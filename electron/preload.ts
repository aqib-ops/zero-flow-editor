/**
 * Electron preload — the only bridge between the renderer and Node.
 * Exposes a small typed surface so the editor never touches fs, spawn or ipc.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AppInfo,
  AudioTrackSpec,
  Binaries,
  EngineStatus,
  MediaProbe,
  OpenedScript,
  RenderProgress,
  SetupSnapshot,
  SetupStatus,
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
  SetupSnapshot,
  SetupStatus,
  UpdateStatus,
};

const api = {
  files: {
    /**
     * Absolute path of a dragged-in File.
     * Electron 37 removed `File.path`, so drag & drop must go through webUtils.
     */
    getPathForFile: (file: File): string => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return "";
      }
    },
  },

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
      language?: string;
      duration?: number;
      error?: string;
    }> => ipcRenderer.invoke("whisper:transcribe", mediaPath, model),
  },

  /** Background self-setup: FFmpeg / captions engine downloads on first run. */
  setup: {
    status: (): Promise<SetupSnapshot> => ipcRenderer.invoke("setup:status"),
    onStatus: (cb: (s: SetupStatus) => void): (() => void) => {
      const h = (_: unknown, s: SetupStatus) => cb(s);
      ipcRenderer.on("setup:status", h);
      return () => ipcRenderer.off("setup:status", h);
    },
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
    /** Wipe derived session caches (HTTP, code, GPU, shader). */
    clearCache: (): Promise<void> => ipcRenderer.invoke("cache:clear"),
    onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
      const h = (_: unknown, s: UpdateStatus) => cb(s);
      ipcRenderer.on("app:update-status", h);
      return () => ipcRenderer.off("app:update-status", h);
    },
  },

  dialog: {
    openMedia: (): Promise<string[]> => ipcRenderer.invoke("dlg:open-media"),
    openScript: (): Promise<OpenedScript | null> => ipcRenderer.invoke("dlg:open-script"),
    saveVideo: (defaultName: string, format?: string): Promise<string | null> =>
      ipcRenderer.invoke("dlg:save-video", defaultName, format),
  },

  /** Autosaved Recent Projects (userData/projects/*.zfp.json). */
  projects: {
    list: () => ipcRenderer.invoke("proj:list"),
    load: (id: string) => ipcRenderer.invoke("proj:load", id),
    save: (id: string, name: string, data: unknown) =>
      ipcRenderer.invoke("proj:save", id, name, data),
    remove: (id: string) => ipcRenderer.invoke("proj:delete", id),
    usage: () => ipcRenderer.invoke("proj:usage"),
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

  text: {
    save: (req: { defaultName: string; content: string }): Promise<string | null> =>
      ipcRenderer.invoke("text:save", req),
  },

  /** Whether we are running inside the Electron desktop shell. */
  isDesktop: true,
};

contextBridge.exposeInMainWorld("zf", api);

export type ZfApi = typeof api;
