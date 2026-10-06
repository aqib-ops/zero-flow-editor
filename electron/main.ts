import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } from "electron";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import {
  findBinaries,
  probeMedia,
  startEncode,
  cancelRender,
  isRendering,
} from "./ffmpeg.js";
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
      return net.fetch(pathToFileURL(filePath).toString());
    } catch (err) {
      console.error("[zf-media protocol error]", err);
      return new Response("Media not found", { status: 404 });
    }
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
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

ipcMain.handle("whisper:transcribe", async (_e, mediaPath: string, model = "tiny") => {
  if (!mediaPath || !existsSync(mediaPath)) {
    return { ok: false, error: `Media file not found: ${mediaPath}` };
  }
  return new Promise((resolve) => {
    const scriptPath = join(__dirname, "../scripts/transcribe.py");
    const py = spawn("python", [scriptPath, mediaPath, model], {
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
      resolve({ ok: false, error: `Failed to execute python: ${err.message}` });
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
