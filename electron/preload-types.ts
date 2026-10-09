/**
 * Shared types between the Electron main process and the renderer.
 * preload.ts imports these so contextBridge and window.zf never drift apart.
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

export interface RenderRequest {
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  outputPath: string;
  audio: AudioTrackSpec[];
}
