/**
 * FFmpeg bridge.
 *
 * Design: the renderer composites every frame (overlays, captions, motion,
 * blend modes — the exact same code the preview runs) and streams raw RGBA
 * bytes to the main process. We spawn ffmpeg reading `-f rawvideo` from stdin,
 * so the visual result is pixel-identical to the preview, and let ffmpeg do the
 * real work: H.264 encoding, pixel-format conversion, and mixing every audio
 * clip onto one bed with correct delay, offset, speed and gain.
 */
import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { AudioTrackSpec, Binaries, MediaProbe } from "./preload-types.js";

export type { AudioTrackSpec, Binaries, MediaProbe };

const execFileAsync = promisify(execFile);

let cached: Binaries | null = null;

async function which(bin: string): Promise<string | null> {
  try {
    const exe = process.platform === "win32" ? `${bin}.exe` : bin;
    const { stdout } = await execFileAsync(process.platform === "win32" ? "where" : "which", [exe], {
      windowsHide: true,
    });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (first && existsSync(first)) return first;
  } catch {
    /* not on PATH */
  }
  return null;
}

export async function findBinaries(): Promise<Binaries> {
  if (cached) return cached;
  const ffmpeg = await which("ffmpeg");
  const ffprobe = await which("ffprobe");
  if (ffmpeg && ffprobe) {
    cached = { ffmpeg, ffprobe, source: "PATH" };
    return cached;
  }
  if (process.platform === "win32") {
    const roots = [
      process.env.LOCALAPPDATA ?? "",
      process.env.ProgramFiles ?? "",
      process.env["ProgramFiles(x86)"] ?? "",
      "C:\\ffmpeg",
      "D:\\ffmpeg",
    ].filter(Boolean);
    for (const root of roots) {
      for (const rel of [["ffmpeg", "bin", "ffmpeg.exe"], ["ffmpeg.exe"], ["bin", "ffmpeg.exe"]]) {
        const p = join(root, ...rel);
        if (existsSync(p)) {
          const probe = join(dirname(p), "ffprobe.exe");
          cached = { ffmpeg: p, ffprobe: existsSync(probe) ? probe : null, source: "found" };
          return cached;
        }
      }
    }
  }
  cached = { ffmpeg, ffprobe, source: "missing" };
  return cached;
}

export async function probeMedia(path: string): Promise<MediaProbe> {
  const base: MediaProbe = {
    path,
    exists: existsSync(path),
    duration: 0,
    width: 0,
    height: 0,
    hasAudio: false,
  };
  if (!base.exists) return { ...base, error: "File not found" };

  const { ffprobe } = await findBinaries();
  if (!ffprobe) return { ...base, error: "ffprobe not found" };

  try {
    const { stdout } = await execFileAsync(
      ffprobe,
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    const info = JSON.parse(stdout) as {
      format?: { duration?: string };
      streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
    };
    const v = info.streams?.find((s) => s.codec_type === "video");
    const dur = Number(info.format?.duration ?? v?.duration ?? 0);
    return {
      path,
      exists: true,
      duration: Number.isFinite(dur) && dur > 0 ? dur : 0,
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      hasAudio: (info.streams ?? []).some((s) => s.codec_type === "audio"),
    };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

/**
 * Build the filter_complex audio graph: every clip becomes a delayed, trimmed,
 * speed- and gain-adjusted stream, then all are mixed and normalised.
 *
 * `inputBase` is the ffmpeg input index of the first audio input. The raw video
 * frames occupy input 0, so audio starts at 1.
 */
export function buildAudioGraph(audio: AudioTrackSpec[], inputBase = 1, sampleRate = 48000): string {
  if (audio.length === 0) return "";
  const parts: string[] = [];
  const labels: string[] = [];

  audio.forEach((clip, i) => {
    const delayMs = Math.max(0, Math.round(clip.start * 1000));
    // atempo accepts 0.5–2.0 per instance — chain for larger ranges.
    const speeds: number[] = [];
    let remaining = Math.min(4, Math.max(0.25, clip.speed || 1));
    while (remaining > 2.0001) {
      speeds.push(2);
      remaining /= 2;
    }
    while (remaining < 0.4999) {
      speeds.push(0.5);
      remaining /= 0.5;
    }
    if (Math.abs(remaining - 1) > 0.001) speeds.push(Number(remaining.toFixed(4)));

    const inIdx = inputBase + i;
    let chain = `[${inIdx}:a]aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo`;
    if (speeds.length) chain += `,atempo=${speeds.join(",")}`;
    chain += `,atrim=start=${(clip.offset || 0).toFixed(4)}:duration=${Math.max(0.02, clip.duration).toFixed(4)},asetpts=N/SR/TB`;
    chain += `,volume=${Math.max(0, Math.min(4, clip.volume)).toFixed(4)}`;
    if (delayMs > 0) chain += `,adelay=delays=${delayMs}:all=1`;
    chain += `[amix_${i}]`;
    parts.push(chain);
    labels.push(`[amix_${i}]`);
  });

  parts.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0:dropout_transition=0,` +
      `alimiter=limit=0.95,` +
      `loudnorm=I=-16:TP=-1.5:LRA=11:linear=true,` +
      `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo[aout]`,
  );
  return parts.join(";");
}

/* --------------------------------- session --------------------------------- */

interface Session {
  proc: import("node:child_process").ChildProcess | null;
  cancelled: boolean;
  ended: boolean;
  resolveEnd: () => void;
}

let session: Session | null = null;

export function cancelRender(): void {
  if (!session || session.ended) return;
  session.cancelled = true;
  if (session.proc && !session.proc.killed) {
    try {
      session.proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

export function isRendering(): boolean {
  return session !== null && !session.ended;
}

export interface StartOptions {
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  outputPath: string;
  audio: AudioTrackSpec[];
  onProgress: (p: {
    phase: "encoding" | "finalizing" | "done" | "error" | "cancelled";
    progress: number;
    message: string;
    error?: string;
    outputPath?: string;
  }) => void;
}

export interface Started {
  bytesPerFrame: number;
  frameCount: number;
  writeFrame: (rgba: ArrayBuffer) => Promise<void>;
  end: () => Promise<{ ok: boolean; error?: string; sizeBytes?: number }>;
  abort: (error: string) => void;
}

export async function startEncode(opts: StartOptions): Promise<Started> {
  const { ffmpeg } = await findBinaries();
  if (!ffmpeg) throw new Error("FFmpeg was not found. Install it and restart Zero Flow.");

  mkdirSync(dirname(opts.outputPath), { recursive: true });

  const args = [
    "-y",
    "-f", "rawvideo",
    "-pix_fmt", "rgba",
    "-s", `${opts.width}x${opts.height}`,
    "-r", String(opts.fps),
    "-i", "pipe:0",
  ];

  const audioGraph = buildAudioGraph(opts.audio);
  const missing = opts.audio.filter((a) => !existsSync(a.source));
  if (missing.length) {
    throw new Error(`Audio source missing: ${missing[0].source}`);
  }
  for (const a of opts.audio) {
    args.push("-i", a.source);
  }

  if (audioGraph) {
    args.push("-filter_complex", audioGraph);
  }

  args.push(
    "-map", "0:v",
    ...(audioGraph ? ["-map", "[aout]"] : []),
    "-c:v", "libx264",
    "-preset", "medium",
    "-profile:v", "high",
    "-level", "4.1",
    "-pix_fmt", "yuv420p",
    "-b:v", `${Math.round(opts.bitrateMbps)}M`,
    "-maxrate", `${Math.round(opts.bitrateMbps * 1.45)}M`,
    "-bufsize", `${Math.round(opts.bitrateMbps * 2)}M`,
    "-g", String(opts.fps * 2),
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    ...(audioGraph ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : ["-an"]),
    "-movflags", "+faststart",
    "-progress", "pipe:1",
    "-nostats",
    opts.outputPath,
  );

  const proc = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

  let endResolve: () => void = () => {};
  const ended = new Promise<void>((r) => {
    endResolve = r;
  });

  const s: Session = { proc, cancelled: false, ended: false, resolveEnd: endResolve };
  session = s;

  const stats = { fps: 0, frames: 0 };
  let stderrTail = "";

  const finish = (error?: string) => {
    s.ended = true;
    if (session === s) session = null;
    s.resolveEnd();
    void error;
  };

  proc.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === "fps") stats.fps = Number(val) || stats.fps;
      if (key === "frame") stats.frames = Math.max(stats.frames, parseInt(val, 10) || 0);
    }
  });

  proc.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4000);
  });

  proc.on("error", (e) => {
    opts.onProgress({
      phase: "error",
      progress: 0,
      message: e.message,
      error: e.message,
    });
    finish(e.message);
  });

  proc.on("close", (code) => {
    if (s.cancelled) {
      opts.onProgress({ phase: "cancelled", progress: 0, message: "Render cancelled" });
      finish("cancelled");
      return;
    }
    if (code !== 0) {
      // Surface the most useful ffmpeg line rather than an empty exit code.
      const useful = stderrTail
        .split(/\r?\n/)
        .filter((l) => l && !/^\s*(frame=|fps=|size=|time=|bitrate=|progress=)/.test(l))
        .slice(-4)
        .join(" | ");
      const msg = useful ? `ffmpeg exited with ${code}: ${useful}` : `ffmpeg exited with code ${code}`;
      opts.onProgress({ phase: "error", progress: 0, message: msg, error: msg });
      finish(msg);
      return;
    }
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(opts.outputPath).size;
    } catch {
      /* file may not exist yet on some FS quirk */
    }
    opts.onProgress({
      phase: "done",
      progress: 1,
      message: "Render complete",
      outputPath: opts.outputPath,
    });
    finish();
  });

  const writeFrame = async (rgba: ArrayBuffer): Promise<void> => {
    if (s.ended || s.cancelled) throw new Error("Render stopped");
    if (proc.stdin?.destroyed || proc.stdin?.writableEnded) throw new Error("Encoding pipe closed");
    const buf = Buffer.from(rgba);
    // Honour backpressure so ffmpeg is never flooded with queued bytes.
    if (!proc.stdin.write(buf)) {
      await new Promise<void>((resolve) => {
        // If ffmpeg exits while we wait for drain, unblock instead of hanging.
        const done = () => {
          clearTimeout(timer);
          proc.stdin?.off("drain", done);
          proc.stdin?.off("close", done);
          proc.stdin?.off("error", done);
          resolve();
        };
        const timer = setTimeout(done, 10_000);
        proc.stdin?.once("drain", done);
        proc.stdin?.once("close", done);
        proc.stdin?.once("error", done);
      });
      if (proc.stdin?.destroyed) throw new Error("Encoding pipe closed");
    }
  };

  return {
    bytesPerFrame: opts.width * opts.height * 4,
    get frameCount() {
      return stats.frames;
    },
    writeFrame,
    async end() {
      await new Promise<void>((resolve) => proc.stdin?.end(resolve));
      await ended;
      if (s.cancelled) return { ok: false, error: "cancelled" };
      if (s.ended && stats.frames === 0) {
        return { ok: false, error: "Encoder produced no frames" };
      }
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(opts.outputPath).size;
      } catch {
        /* ignore */
      }
      return { ok: true, sizeBytes };
    },
    abort(error: string) {
      if (s.cancelled || s.ended) return;
      try {
        proc.stdin?.destroy();
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      opts.onProgress({ phase: "error", progress: 0, message: error, error });
      finish(error);
    },
  };
}

export function cleanupWorkDirs(base: string): void {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
