/**
 * Electron preload — the only bridge between the renderer and Node.
 * Exposes a small typed surface so the editor never touches fs, spawn or ipc.
 */
import { contextBridge, ipcRenderer } from "electron";
import type {
  AppInfo,
  AudioTrackSpec,
  Binaries,
  EngineStatus,
  MediaProbe,
  OpenedScript,
  RenderProgress,
  UpdateStatus,
} from "./preload-types.js";

export type {
  AppInfo,
  AudioTrackSpec,
  Binaries,
  EngineStatus,
  MediaProbe,
  OpenedScript,
  RenderProgress,
  UpdateStatus,
};

const api = {
  ffmpeg: {
    /** Locate ffmpeg/ffprobe on this machine. */
    findBinaries: (): Promise<Binaries> => ipcRenderer.invoke("ff:find-binaries"),
    /** Probe a media file for duration/dimensions/audio presence. */
    probe: (path: string): Promise<MediaProbe> => ipcRenderer.invoke("ff:probe", path),
  },

  whisper: {
    transcribe: (
      mediaPath: string,
      model = "base",
    ): Promise<{
      ok: boolean;
      segments?: Array<{ start: number; end: number; duration: number; text: string }>;
      error?: string;
    }> => ipcRenderer.invoke("whisper:transcribe", mediaPath, model),
  },

  /** Version, engine provenance and the GitHub Releases updater. */
  app: {
    info: (): Promise<AppInfo> => ipcRenderer.invoke("app:info"),
    engine: (): Promise<EngineStatus> => ipcRenderer.invoke("app:engine"),
    updateStatus: (): Promise<UpdateStatus> => ipcRenderer.invoke("app:update-status"),
    updateCheck: (): Promise<UpdateStatus> => ipcRenderer.invoke("app:update-check"),
    updateDownload: (): Promise<UpdateStatus> => ipcRenderer.invoke("app:update-download"),
    updateInstall: (): Promise<void> => ipcRenderer.invoke("app:update-install"),
    openExternal: (url: string): Promise<void> => ipcRenderer.invoke("app:open-external", url),
    onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const h = (_: unknown, s: UpdateStatus) => cb(s);
      ipcRenderer.on("app:update-status", h);
      return () => ipcRenderer.off("app:update-status", h);
    },
  },

  dialog: {
    openMedia: (): Promise<string[]> => ipcRenderer.invoke("dlg:open-media"),
    openScript: (): Promise<OpenedScript | null> => ipcRenderer.invoke("dlg:open-script"),
    saveVideo: (defaultName: string): Promise<string | null> =>
      ipcRenderer.invoke("dlg:save-video", defaultName),
    saveProject: (data: unknown): Promise<string | null> => ipcRenderer.invoke("proj:write", data),
    openProject: (): Promise<unknown | null> => ipcRenderer.invoke("proj:open-project"),
  },

  project: {
    read: (path: string): Promise<unknown> => ipcRenderer.invoke("proj:read", path),
  },

  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke("win:minimize"),
    toggleMaximize: (): Promise<void> => ipcRenderer.invoke("win:toggle-maximize"),
    close: (): Promise<void> => ipcRenderer.invoke("win:close"),
    onMaximizeChange: (cb: (max: boolean) => void): (() => void) => {
      const h = (_: unknown, max: boolean) => cb(max);
      ipcRenderer.on("win:maximize-change", h);
      return () => ipcRenderer.off("win:maximize-change", h);
    },
  },

  render: {
    /** Spawn ffmpeg. Then push frames with `frame`, finish with `finalize`. */
    start: (req: {
      width: number;
      height: number;
      fps: number;
      bitrateMbps: number;
      outputPath: string;
      audio: AudioTrackSpec[];
    }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("render:start", req),
    /** Push one raw RGBA frame (must be width*height*4 bytes). */
    frame: (rgba: ArrayBuffer): void => ipcRenderer.send("render:frame", rgba),
    /** Signal EOF and wait for ffmpeg to finish. */
    finalize: (): Promise<{ ok: boolean; error?: string; sizeBytes?: number }> =>
      ipcRenderer.invoke("render:finalize"),
    cancel: (): Promise<void> => ipcRenderer.invoke("render:cancel"),
    /** Ack callback — main calls this once a frame was written. */
    onAck: (cb: () => void): (() => void) => {
      const h = () => cb();
      ipcRenderer.on("render:ack", h);
      return () => ipcRenderer.off("render:ack", h);
    },
    onProgress: (cb: (p: RenderProgress) => void): (() => void) => {
      const h = (_: unknown, p: RenderProgress) => cb(p);
      ipcRenderer.on("render:progress", h);
      return () => ipcRenderer.off("render:progress", h);
    },
  },

  shell: {
    showItemInFolder: (filePath: string): Promise<boolean> =>
      ipcRenderer.invoke("shell:open-folder", filePath),
  },

  media: {
    toDataUrl: (filePath: string): Promise<string | null> =>
      ipcRenderer.invoke("media:to-data-url", filePath),
  },

  /** Whether we are running inside the Electron desktop shell. */
  isDesktop: true,
};

contextBridge.exposeInMainWorld("zf", api);

export type ZfApi = typeof api;
