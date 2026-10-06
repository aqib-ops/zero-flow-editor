/**
 * Shared types between the Electron main process and the renderer.
 * preload.ts imports these so contextBridge and window.zf never drift apart.
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

export interface RenderRequest {
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  outputPath: string;
  audio: AudioTrackSpec[];
}
