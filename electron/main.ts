import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from "electron";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, statSync, createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import {
  findBinaries,
  probeMedia,
  startEncode,
  cancelRender,
  isRendering,
} from "./ffmpeg.js";
import { findWhisperRuntime, DEFAULT_MODEL } from "./whisper.js";
import {
  checkForUpdates,
  currentUpdateStatus,
  downloadUpdate,
  quitAndInstall,
  startAutoUpdates,
} from "./updater.js";
import type { AudioTrackSpec, RenderProgress } from "./preload-types.js";

export type { AudioTrackSpec, RenderProgress };

// Register custom protocol before app is ready to ensure standard media streaming
protocol.registerSchemesAsPrivileged([
  {
    scheme: "zf-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let activeEncode: Awaited<ReturnType<typeof startEncode>> | null = null;
let encodeEnded = false;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1120,
    minHeight: 680,
    backgroundColor: "#0b0d12",
    title: "Zero Flow",
    show: false,
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      webSecurity: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  const reportMax = () => send("win:maximize-change", mainWindow?.isMaximized() ?? false);
  mainWindow.on("maximize", reportMax);
  mainWindow.on("unmaximize", reportMax);
  mainWindow.on("restore", reportMax);

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[main] Failed to load ${url}: [${code}] ${desc}`);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.webContents.on("console-message", (_e, level, msg, line, src) => {
      if (level >= 2) {
        console.error(`[renderer error] ${msg} (${src}:${line})`);
      }
    });
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(join(__dirname, "../dist/renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const MEDIA_MIME: Record<string, string> = {
    mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
    webm: "video/webm", avi: "video/x-msvideo", ts: "video/mp2t",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
    ogg: "audio/ogg", opus: "audio/opus", flac: "audio/flac",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp",
  };

  /**
   * Serve local media with full HTTP Range support (206 Partial Content).
   *
   * Chromium *requires* working Range responses to seek into a video before it
   * is fully buffered. `net.fetch(fileURL)` ignores the Range header and always
   * returns the whole file with status 200, which made <video> unseekable during
   * export/scrubbing — every seek landed at 0.0s and the compositor aborted with
   * "Media seek did not reach ...". Streaming the requested byte window fixes it.
   */
  protocol.handle("zf-media", (request) => {
    try {
      const prefix = "zf-media://local/";
      let filePath = "";
      if (request.url.startsWith(prefix)) {
        filePath = decodeURIComponent(request.url.slice(prefix.length));
      } else {
        const parsed = new URL(request.url);
        filePath = decodeURIComponent(parsed.pathname);
        if (process.platform === "win32" && filePath.startsWith("/")) {
          filePath = filePath.slice(1);
        }
      }

      if (!filePath || !existsSync(filePath)) {
        return new Response("Media not found", { status: 404 });
      }

      const stat = statSync(filePath);
      if (!stat.isFile()) {
        return new Response("Not a file", { status: 404 });
      }

      const size = stat.size;
      const ext = extname(filePath).replace(".", "").toLowerCase();
      const mime = MEDIA_MIME[ext] || "application/octet-stream";
      const baseHeaders: Record<string, string> = {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Last-Modified": stat.mtime.toUTCString(),
        "Cache-Control": "no-cache",
      };

      const rangeHeader = request.headers.get("range");
      const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;

      if (m && (m[1] !== "" || m[2] !== "")) {
        let start: number;
        let end: number;
        if (m[1] === "") {
          // Suffix form: bytes=-500 → last 500 bytes.
          const suffix = Number(m[2]);
          if (!Number.isFinite(suffix) || suffix <= 0) {
            return new Response(null, {
              status: 416,
              headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
            });
          }
          start = Math.max(0, size - suffix);
          end = size - 1;
        } else {
          start = Number(m[1]);
          end = m[2] === "" ? size - 1 : Number(m[2]);
        }

        if (
          !Number.isFinite(start) || !Number.isFinite(end) ||
          start < 0 || end < start || start >= size
        ) {
          return new Response(null, {
            status: 416,
            headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
          });
        }
        end = Math.min(end, size - 1);

        const body = Readable.toWeb(
          createReadStream(filePath, { start, end }),
        ) as ReadableStream;
        return new Response(body, {
          status: 206,
          headers: {
            ...baseHeaders,
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Content-Length": String(end - start + 1),
          },
        });
      }

      const full = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
      return new Response(full, {
        status: 200,
        headers: { ...baseHeaders, "Content-Length": String(size) },
      });
    } catch (err) {
      console.error("[zf-media protocol error]", err);
      return new Response("Media not found", { status: 404 });
    }
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // Silent background check so Settings → Updates has a state on first open.
  startAutoUpdates(send);
});

app.on("window-all-closed", () => {
  // Never kill ffmpeg mid-encode: the output file would be truncated.
  if (isRendering()) return;
  app.quit();
});

const send = (channel: string, ...args: unknown[]): void => {
  mainWindow?.webContents.send(channel, ...args);
};

/* --------------------------------- IPC ------------------------------------- */

ipcMain.handle("media:to-data-url", async (_e, filePath: string) => {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      m4a: "audio/mp4",
      flac: "audio/flac",
    };
    const mime = mimeMap[ext] || "application/octet-stream";
    const data = readFileSync(filePath);
    return `data:${mime};base64,${data.toString("base64")}`;
  } catch (err) {
    console.error("[media:to-data-url error]", err);
    return null;
  }
});

ipcMain.handle("ff:find-binaries", () => findBinaries());

ipcMain.handle("ff:probe", (_e, path: string) => probeMedia(path));

/* ------------------------------ app / settings ------------------------------ */

ipcMain.handle("app:info", () => ({
  name: app.getName(),
  version: app.getVersion(),
  electron: process.versions.electron ?? "",
  chrome: process.versions.chrome ?? "",
  node: process.versions.node ?? "",
  platform: `${process.platform} ${process.arch}`,
  packaged: app.isPackaged,
  repo: "https://github.com/aqib-ops/zero-flow-editor",
}));

ipcMain.handle("app:engine", async () => {
  const binaries = await findBinaries();
  const runtime = findWhisperRuntime();
  const modelDir = runtime ? join(runtime.modelRoot, DEFAULT_MODEL) : null;
  const modelReady = !!modelDir && existsSync(join(modelDir, "model.bin"));
  return {
    ffmpeg: { path: binaries.ffmpeg, source: binaries.source },
    captions: {
      available: !!runtime && modelReady,
      python: runtime?.python ?? null,
      source: runtime?.source ?? null,
      modelRoot: modelReady ? modelDir : null,
    },
  };
});

ipcMain.handle("app:update-status", () => currentUpdateStatus());
ipcMain.handle("app:update-check", () => checkForUpdates(send));
ipcMain.handle("app:update-download", () => downloadUpdate(send));
ipcMain.handle("app:update-install", () => quitAndInstall());
ipcMain.handle("app:open-external", (_e, url: string) => {
  // Only ever hand http(s) to the OS browser.
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
});

ipcMain.handle("dlg:open-media", async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return [];
  const res = await dialog.showOpenDialog(win, {
    title: "Import media",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "All supported media", extensions: [
        "mp4","mov","webm","mkv","avi","m4v","wmv","flv","ts","m2ts","mpg","mpeg",
        "png","jpg","jpeg","webp","gif","avif","bmp","tif","tiff",
        "mp3","wav","m4a","aac","ogg","oga","flac","opus","wma",
      ] },
      { name: "Video", extensions: ["mp4","mov","webm","mkv","avi","m4v","wmv","flv","ts","m2ts"] },
      { name: "Images", extensions: ["png","jpg","jpeg","webp","gif","avif","bmp","tif","tiff"] },
      { name: "Audio", extensions: ["mp3","wav","m4a","aac","ogg","flac","opus","wma"] },
    ],
  });
  return res.canceled ? [] : res.filePaths;
});

ipcMain.handle("dlg:open-script", async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: "Open script / timing list",
    properties: ["openFile"],
    filters: [{ name: "Text files", extensions: ["txt","srt","csv","vtt","md"] }],
  });
  if (res.canceled) return null;
  const p = res.filePaths[0];
  if (!existsSync(p)) return null;
  return { path: p, text: readFileSync(p, "utf8") };
});

ipcMain.handle("whisper:transcribe", async (_e, mediaPath: string, model?: string) => {
  if (!mediaPath || !existsSync(mediaPath)) {
    return { ok: false, error: `Media file not found: ${mediaPath}` };
  }

  const runtime = findWhisperRuntime();
  if (!runtime) {
    return {
      ok: false,
      error:
        "The captioning engine is not installed. Run `npm run setup:whisper` once, or reinstall the app.",
    };
  }

  const modelSize = model && model !== "auto" ? model : DEFAULT_MODEL;

  return new Promise((resolve) => {
    const py = spawn(runtime.python, [runtime.script, mediaPath, modelSize, runtime.modelRoot], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";

    py.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    py.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    py.on("close", (code) => {
      if (code !== 0 && !stdout) {
        resolve({ ok: false, error: stderr.trim() || `Whisper exited with code ${code}` });
        return;
      }
      try {
        const trimmed = stdout.trim();
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
          const jsonStr = trimmed.slice(start, end + 1);
          const parsed = JSON.parse(jsonStr);
          resolve(parsed);
          return;
        }
        const parsed = JSON.parse(trimmed);
        resolve(parsed);
      } catch (err) {
        resolve({ ok: false, error: `Whisper parse error: ${(err as Error).message}\n${stdout || stderr}` });
      }
    });

    py.on("error", (err) => {
      resolve({
        ok: false,
        error: `Failed to launch the captioning engine (${runtime.python}): ${err.message}`,
      });
    });
  });
});

ipcMain.handle("shell:open-folder", (_e, filePath: string) => {
  if (filePath && existsSync(filePath)) {
    shell.showItemInFolder(filePath);
    return true;
  }
  return false;
});

ipcMain.handle("dlg:save-video", async (_e, defaultName: string) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  const res = await dialog.showSaveDialog(win, {
    title: "Export video",
    defaultPath: defaultName,
    properties: ["createDirectory", "showOverwriteConfirmation"],
    filters: [
      { name: "MP4 (H.264 + AAC)", extensions: ["mp4"] },
      { name: "QuickTime MOV", extensions: ["mov"] },
      { name: "Matroska MKV", extensions: ["mkv"] },
    ],
  });
  return res.canceled || !res.filePath ? null : res.filePath;
});

ipcMain.handle("proj:write", async (_e, data: unknown) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  const res = await dialog.showSaveDialog(win, {
    title: "Save project",
    defaultPath: "zero-flow-project.zfp",
    properties: ["createDirectory", "showOverwriteConfirmation"],
    filters: [{ name: "Zero Flow project", extensions: ["zfp","json"] }],
  });
  if (res.canceled || !res.filePath) return null;
  writeFileSync(res.filePath, JSON.stringify(data, null, 2), "utf8");
  return res.filePath;
});

ipcMain.handle("proj:read", (_e, path: string) => {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
});

ipcMain.handle("proj:open-project", async () => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: "Open project",
    properties: ["openFile"],
    filters: [{ name: "Zero Flow project", extensions: ["zfp","json"] }],
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return JSON.parse(readFileSync(res.filePaths[0], "utf8"));
});

ipcMain.handle("win:minimize", () => mainWindow?.minimize());

ipcMain.handle("win:toggle-maximize", () => {
  const win = mainWindow;
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.handle("win:is-maximized", () => mainWindow?.isMaximized() ?? false);

ipcMain.handle("win:close", () => {
  if (isRendering()) {
    void dialog
      .showMessageBox(mainWindow!, {
        type: "warning",
        buttons: ["Keep rendering", "Cancel render & quit"],
        defaultId: 0,
        cancelId: 0,
        title: "Render in progress",
        message: "A render is still running.",
        detail: "Quitting now would leave the exported file incomplete.",
      })
      .then(({ response }) => {
        if (response === 1) {
          cancelRender();
          setTimeout(() => app.quit(), 150);
        }
      })
      .catch(() => app.quit());
    return;
  }
  mainWindow?.close();
});

/* ------------------------------ render pipeline ----------------------------- */

ipcMain.handle(
  "render:start",
  async (
    _e,
    req: { width: number; height: number; fps: number; bitrateMbps: number; outputPath: string; audio: AudioTrackSpec[] },
  ) => {
    if (activeEncode) return { ok: false, error: "A render is already running." };
    encodeEnded = false;
    try {
      activeEncode = await startEncode({
        width: req.width,
        height: req.height,
        fps: req.fps,
        bitrateMbps: req.bitrateMbps,
        outputPath: req.outputPath,
        audio: req.audio,
        onProgress: (p) => send("render:progress", p),
      });
      return { ok: true };
    } catch (e) {
      activeEncode = null;
      return { ok: false, error: (e as Error).message };
    }
  },
);

ipcMain.on("render:frame", (_e, rgba: ArrayBuffer) => {
  const enc = activeEncode;
  if (!enc || encodeEnded) return;
  void (async () => {
    try {
      await enc.writeFrame(rgba);
      send("render:ack");
    } catch (e) {
      enc.abort((e as Error).message);
      teardown();
    }
  })();
});

function teardown(): void {
  encodeEnded = true;
  activeEncode = null;
}

ipcMain.handle("render:finalize", async () => {
  const enc = activeEncode;
  if (!enc) return { ok: false, error: "No active render." };
  try {
    const out = await enc.end();
    teardown();
    return out;
  } catch (e) {
    enc.abort((e as Error).message);
    teardown();
    return { ok: false, error: (e as Error).message };
  }
});

ipcMain.handle("render:cancel", () => {
  cancelRender();
  teardown();
});
