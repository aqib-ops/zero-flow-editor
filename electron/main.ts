import { app, BrowserWindow, ipcMain, dialog, shell, protocol } from "electron";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, statSync, createReadStream, realpathSync } from "node:fs";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import {
  findBinaries,
  probeMedia,
  startEncode,
  cancelRender,
  isRendering,
} from "./ffmpeg.js";
import { findWhisperRuntime, runtimeSearchRoot, isModelReady, DEFAULT_MODEL } from "./whisper.js";
import { ensureWhisper, getSetupSnapshot, runSelfSetup, setSetupSink } from "./self-setup.js";
import { clearSessionCache, startCacheSweeper } from "./session-cache.js";
import {
  deleteProject,
  listProjects,
  loadProject,
  projectsDiskUsage,
  saveProject,
  sweepTempFiles,
} from "./project-store.js";
import type { SetupSnapshot } from "./preload-types.js";
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

// Dev launches `electron.exe dist-electron/main.js`, and dist-electron holds no
// package.json for Electron to read — without this the dev profile lands in the
// generic %APPDATA%\Electron. The packaged build already resolves its name from
// package.json ("zero-flow-editor"), so this makes dev match it.
if (!app.isPackaged) app.setName("zero-flow-editor");

const __dirname = dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let activeEncode: Awaited<ReturnType<typeof startEncode>> | null = null;
let encodeEnded = false;
// Set once the user has confirmed abandoning a render, so the window's close
// guard does not re-prompt while `app.quit()` tears the window down.
let forceQuit = false;

/**
 * Ask before dropping an active export. Closing the window destroys the
 * renderer that feeds frames over IPC, so the encode cannot finish once the
 * last window is gone — the only honest options are keep working or cancel.
 */
function confirmAbandonRender(win: BrowserWindow): void {
  void dialog
    .showMessageBox(win, {
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
        forceQuit = true;
        cancelRender();
        app.quit();
      }
    })
    .catch(() => {
      forceQuit = true;
      app.quit();
    });
}

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

  // Alt+F4 / taskbar close bypass `win:close` (the custom titlebar IPC), so
  // guard the native event too — otherwise the renderer dies mid-export and
  // the encoder waits forever for frames that can no longer arrive.
  mainWindow.on("close", (event) => {
    if (forceQuit || !isRendering()) return;
    event.preventDefault();
    confirmAbandonRender(mainWindow!);
  });

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
    webm: "video/webm", avi: "video/x-msvideo", ts: "video/mp2t", m2ts: "video/mp2t",
    mpg: "video/mpeg", mpeg: "video/mpeg", flv: "video/x-flv", wmv: "video/x-ms-wmv",
    mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
    ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/opus", flac: "audio/flac",
    wma: "audio/x-ms-wma",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
    gif: "image/gif", svg: "image/svg+xml", bmp: "image/bmp",
    avif: "image/avif", tif: "image/tiff", tiff: "image/tiff",
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

      if (!filePath) {
        return new Response("Media not found", { status: 404 });
      }

      // Resolve links before the allowlist below: a symlink/junction called
      // "clip.mp4" must not be able to expose a non-media file just because of
      // its name. The canonical path is what we stat and stream.
      let realPath: string;
      try {
        realPath = realpathSync(filePath);
      } catch {
        return new Response("Media not found", { status: 404 });
      }

      const stat = statSync(realPath);
      if (!stat.isFile()) {
        return new Response("Not a file", { status: 404 });
      }

      const size = stat.size;
      const ext = extname(realPath).replace(".", "").toLowerCase();
      const mime = MEDIA_MIME[ext];
      // The scheme is registered with bypassCSP and the renderer runs with
      // webSecurity disabled, so a known-media extension allowlist is the only
      // thing stopping "zf-media:///…/id_rsa" from becoming a file read.
      if (!mime) {
        return new Response("Unsupported media type", { status: 415 });
      }
      const baseHeaders: Record<string, string> = {
        "Content-Type": mime,
        "Accept-Ranges": "bytes",
        "Last-Modified": stat.mtime.toUTCString(),
        "Cache-Control": "no-cache",
        // Canvas readback (thumbnails, export frames) requires an un-tainted
        // source; the scheme is registered corsEnabled, so opt in explicitly.
        "Access-Control-Allow-Origin": "*",
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
          createReadStream(realPath, { start, end }),
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

      const full = Readable.toWeb(createReadStream(realPath)) as ReadableStream;
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

  // Self-setup: if the shipped FFmpeg/captioning runtime is missing, download
  // it in the background (one-time) and stream progress to the renderer so a
  // fresh machine works with zero manual steps. Never blocks the editor.
  setSetupSink((status) => send("setup:status", status));
  void runSelfSetup();

  // Derived caches (HTTP, code, GPU, shader) are wiped after every export and
  // on quit. Local Storage is kept — it only ever holds a few bytes of UI prefs.
  startCacheSweeper();

  // Recent Projects: remove .tmp leftovers from any crashed autosave before
  // the renderer asks for the list.
  sweepTempFiles();
});

app.on("window-all-closed", () => {
  // The renderer drives the frame pipeline over IPC, so once the last window is
  // gone no more frames can arrive and a running encode can never finish. Stop
  // ffmpeg before exiting instead of leaving a headless process waiting on a
  // stdin that will never close.
  if (isRendering()) cancelRender();
  app.quit();
});

const send = (channel: string, ...args: unknown[]): void => {
  mainWindow?.webContents.send(channel, ...args);
};

/* --------------------------------- IPC ------------------------------------- */

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
  // Partial folders (model.bin only) are NOT ready: transcribe.py would fall
  // back to a network download that cannot succeed offline.
  const modelReady = isModelReady(runtime?.modelRoot ?? null);
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

/** Called by the renderer after a successful export. */
ipcMain.handle("cache:clear", () => clearSessionCache());

/* ------------------------------ recent projects ----------------------------- */

ipcMain.handle("proj:list", () => listProjects());
ipcMain.handle("proj:load", (_e, id: string) => loadProject(id));
ipcMain.handle("proj:save", (_e, id: string, name: string, data: unknown) =>
  saveProject(id, name, data),
);
ipcMain.handle("proj:delete", (_e, id: string) => deleteProject(id));
ipcMain.handle("proj:usage", () => projectsDiskUsage());

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

/** Snapshot of the background self-setup, for the renderer to render on mount. */
ipcMain.handle("setup:status", async (): Promise<SetupSnapshot> => getSetupSnapshot());

ipcMain.handle("whisper:transcribe", async (_e, mediaPath: string, model?: string) => {
  if (!mediaPath || !existsSync(mediaPath)) {
    return { ok: false, error: `Media file not found: ${mediaPath}` };
  }

  // Self-heal: a missing runtime triggers the same download the startup
  // self-setup uses (no-op when it is already running or the runtime exists).
  let runtime = findWhisperRuntime();
  if (!runtime && (await ensureWhisper())) runtime = findWhisperRuntime();
  if (!runtime) {
    return {
      ok: false,
      error:
        `The captioning engine could not be installed (looked in ${runtimeSearchRoot()}). ` +
        "Check your internet connection and try again, or reinstall the app.",
    };
  }

  const modelSize = model && model !== "auto" ? model : DEFAULT_MODEL;

  // A hang (huge file, locked media, a broken interpreter) must not leave the
  // renderer spinning forever — there is no cancel button on the dialog.
  const WHISPER_TIMEOUT_MS = 15 * 60 * 1000;

  return new Promise((resolve) => {
    const py = spawn(runtime.python, [runtime.script, mediaPath, modelSize, runtime.modelRoot], {
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const settle = (value: {
      ok: boolean;
      segments?: Array<{ start: number; end: number; duration: number; text: string }>;
      language?: string;
      duration?: number;
      error?: string;
    }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(value);
    };

    const timeout = setTimeout(() => {
      try {
        py.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      settle({
        ok: false,
        error: `Captioning timed out after ${Math.round(WHISPER_TIMEOUT_MS / 60000)} minutes. ` +
          "Try a shorter clip.",
      });
    }, WHISPER_TIMEOUT_MS);

    py.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    py.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    py.on("close", (code) => {
      const trimmed = stdout.trim();
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          const parsed = JSON.parse(trimmed.slice(start, end + 1));
          // The script emits {"ok": false, "error": ...} on its own failures.
          // Honour that even when the process exited 0, otherwise a failed run
          // that printed a payload is reported as a success.
          if (parsed && typeof parsed === "object" && parsed.ok === false) {
            settle({
              ok: false,
              error:
                typeof parsed.error === "string" && parsed.error
                  ? parsed.error
                  : `Whisper exited with code ${code}`,
            });
            return;
          }
          settle(parsed);
          return;
        } catch (err) {
          settle({
            ok: false,
            error: `Whisper parse error: ${(err as Error).message}\n${stdout || stderr}`,
          });
          return;
        }
      }
      settle({
        ok: false,
        error:
          stderr.trim() ||
          `Whisper exited with code ${code}` ||
          "The captioning engine produced no output.",
      });
    });

    py.on("error", (err) => {
      settle({
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

ipcMain.handle("dlg:save-video", async (_e, defaultName: string, format?: string) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  // The filter follows the format chosen in the export dialog so the default
  // extension always matches what the encoder will actually write.
  const filters =
    format === "mov"
      ? [{ name: "QuickTime MOV", extensions: ["mov"] }]
      : format === "mkv"
        ? [{ name: "Matroska MKV", extensions: ["mkv"] }]
        : format === "mp4"
          ? [{ name: "MP4 (H.264 + AAC)", extensions: ["mp4"] }]
          : [
              { name: "MP4 (H.264 + AAC)", extensions: ["mp4"] },
              { name: "QuickTime MOV", extensions: ["mov"] },
              { name: "Matroska MKV", extensions: ["mkv"] },
            ];
  const res = await dialog.showSaveDialog(win, {
    title: "Export video",
    defaultPath: defaultName,
    properties: ["createDirectory", "showOverwriteConfirmation"],
    filters,
  });
  return res.canceled || !res.filePath ? null : res.filePath;
});

ipcMain.handle("text:save", async (_e, req: { defaultName: string; content: string }) => {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow;
  if (!win) return null;
  const defaultName =
    req && typeof req.defaultName === "string" && req.defaultName.trim()
      ? req.defaultName.trim()
      : "transcript.txt";
  const content = req && typeof req.content === "string" ? req.content : "";
  const isSrt = /\.srt$/i.test(defaultName);
  const res = await dialog.showSaveDialog(win, {
    title: "Save transcript",
    defaultPath: defaultName,
    properties: ["createDirectory", "showOverwriteConfirmation"],
    filters: isSrt
      ? [{ name: "SubRip subtitles", extensions: ["srt"] }]
      : [
          { name: "Text file", extensions: ["txt"] },
          { name: "SubRip subtitles", extensions: ["srt"] },
        ],
  });
  if (res.canceled || !res.filePath) return null;
  writeFileSync(res.filePath, content, "utf8");
  return res.filePath;
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
  const win = mainWindow;
  if (!win) return;
  if (isRendering()) {
    confirmAbandonRender(win);
    return;
  }
  win.close();
});

/* ------------------------------ render pipeline ----------------------------- */

ipcMain.handle(
  "render:start",
  async (
    _e,
    req: { width: number; height: number; fps: number; bitrateMbps: number; outputPath: string; format: "mp4" | "mov" | "mkv"; audio: AudioTrackSpec[] },
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
        format: req.format,
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
