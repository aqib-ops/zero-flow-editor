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
  source: "PATH" | "found" | "missing";
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
