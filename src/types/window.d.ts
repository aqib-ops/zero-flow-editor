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

/** Which engine a setup:status event is about. */
export type SetupComponent = "ffmpeg" | "whisper";

export type SetupPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "extracting"
  | "installing"
  | "ready"
  | "error";

/** Pushed over the `setup:status` channel whenever an engine's state changes. */
export interface SetupStatus {
  component: SetupComponent;
  phase: SetupPhase;
  detail?: string;
  /** 0–100 while downloading, undefined otherwise. */
  progress?: number;
}

/** Reply to `setup.status()` — a snapshot of both engines. */
export interface SetupSnapshot {
  ffmpeg: SetupPhase;
  whisper: SetupPhase;
  message: string | null;
}

export interface ZfApi {
  files: {
    /** Absolute path of a dragged-in File (Electron removed `File.path`). */
    getPathForFile: (file: File) => string;
  };
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
      language?: string;
      duration?: number;
      error?: string;
    }>;
  };
  /** Background self-setup: FFmpeg / captions engine downloads on first run. */
  setup: {
    status: () => Promise<SetupSnapshot>;
    onStatus: (cb: (s: SetupStatus) => void) => () => void;
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
    /** Wipe derived session caches (HTTP, code, GPU, shader). */
    clearCache: () => Promise<void>;
    onUpdateStatus: (cb: (s: UpdateStatus) => void) => () => void;
  };
  dialog: {
    openMedia: () => Promise<string[]>;
    openScript: () => Promise<OpenedScript | null>;
    saveVideo: (defaultName: string, format?: "mp4" | "mov" | "mkv") => Promise<string | null>;
  };
  /** Autosaved Recent Projects (userData/projects/*.zfp.json). */
  projects: {
    list: () => Promise<
      Array<{ id: string; name: string; savedAt: number; data: unknown }>
    >;
    load: (id: string) => Promise<{ id: string; name: string; savedAt: number; data: unknown } | null>;
    save: (id: string, name: string, data: unknown) => Promise<void>;
    remove: (id: string) => Promise<boolean>;
    usage: () => Promise<number>;
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
      format: "mp4" | "mov" | "mkv";
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
  text: {
    save: (req: { defaultName: string; content: string }) => Promise<string | null>;
  };
  isDesktop: true;
}

declare global {
  interface Window {
    zf: ZfApi;
  }
}

export {};
