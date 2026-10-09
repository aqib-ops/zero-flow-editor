/**
 * Renderer-side mirror of the Electron preload surface (window.zf).
 *
 * electron/preload.ts is the runtime source of truth; this file exists so the
 * renderer can type-check against the same shapes without importing across the
 * Electron boundary into the renderer bundle.
 */
export interface Binaries {
  ffmpeg: string | null;
  ffprobe: string | null;
  source: "PATH" | "found" | "missing" | "bundled";
}

export interface MediaProbe {
  path: string;
  exists: boolean;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  error?: string;
}

export interface AudioTrackSpec {
  source: string;
  start: number;
  offset: number;
  duration: number;
  speed: number;
  volume: number;
}

export interface RenderProgress {
  phase: "encoding" | "finalizing" | "done" | "error" | "cancelled";
  progress: number;
  message: string;
  error?: string;
  outputPath?: string;
}

export interface OpenedScript {
  path: string;
  text: string;
}

/** Everything the About tab shows, plus what the UI branches on. */
export interface AppInfo {
  name: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  platform: string;
  packaged: boolean;
  repo: string;
}

/** Where each local engine came from — Settings → General displays this. */
export interface EngineStatus {
  ffmpeg: {
    path: string | null;
    /** "bundled" means shipped inside resources/, never on the user's PATH. */
    source: Binaries["source"];
  };
  captions: {
    available: boolean;
    python: string | null;
    source: "bundled" | "system" | null;
    /** Local model folder that was resolved, or null when only a size is set. */
    modelRoot: string | null;
  };
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "not-available"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export interface UpdateStatus {
  phase: UpdatePhase;
  /** Next version once an update is found / downloaded. */
  version?: string;
  releaseDate?: string;
  /** 0–100 while downloading. */
  percent?: number;
  message?: string;
}

export interface ZfApi {
  ffmpeg: {
    findBinaries: () => Promise<Binaries>;
    probe: (path: string) => Promise<MediaProbe>;
  };
  whisper: {
    transcribe: (
      mediaPath: string,
      model?: string,
    ) => Promise<{
      ok: boolean;
      segments?: Array<{ start: number; end: number; duration: number; text: string }>;
      error?: string;
    }>;
  };
  /** Version info, engine provenance and the GitHub Releases updater. */
  app: {
    info: () => Promise<AppInfo>;
    engine: () => Promise<EngineStatus>;
    updateStatus: () => Promise<UpdateStatus>;
    updateCheck: () => Promise<UpdateStatus>;
    updateDownload: () => Promise<UpdateStatus>;
    updateInstall: () => Promise<void>;
    openExternal: (url: string) => Promise<void>;
    onUpdateStatus: (cb: (s: UpdateStatus) => void) => () => void;
  };
  dialog: {
    openMedia: () => Promise<string[]>;
    openScript: () => Promise<OpenedScript | null>;
    saveVideo: (defaultName: string) => Promise<string | null>;
    saveProject: (data: unknown) => Promise<string | null>;
    openProject: () => Promise<unknown | null>;
  };
  project: {
    read: (path: string) => Promise<unknown>;
  };
  window: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
    onMaximizeChange: (cb: (maximized: boolean) => void) => () => void;
  };
  render: {
    start: (req: {
      width: number;
      height: number;
      fps: number;
      bitrateMbps: number;
      outputPath: string;
      audio: AudioTrackSpec[];
    }) => Promise<{ ok: boolean; error?: string }>;
    frame: (rgba: ArrayBuffer) => void;
    finalize: () => Promise<{ ok: boolean; error?: string; sizeBytes?: number }>;
    cancel: () => Promise<void>;
    onAck: (cb: () => void) => () => void;
    onProgress: (cb: (p: RenderProgress) => void) => () => void;
  };
  shell?: {
    showItemInFolder: (filePath: string) => Promise<boolean>;
  };
  media?: {
    toDataUrl: (filePath: string) => Promise<string | null>;
  };
  isDesktop: true;
}

declare global {
  interface Window {
    zf: ZfApi;
  }
}

export {};
