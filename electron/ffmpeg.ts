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
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { exeName, ffmpegSearchDirs } from "./paths.js";
import { ensureFfmpeg } from "./self-setup.js";
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

/**
 * Directory of the bundled main-process file (dist-electron in dev). Anchoring
 * off `import.meta.url` rather than `app.getAppPath()` matters in dev: Electron
 * launched with a file path reports that file's directory as the app path, so
 * getAppPath() points at dist-electron/ and never at the project root.
 */
function bundledBinDir(): string {
  const dirs = ffmpegSearchDirs();
  const ff = exeName("ffmpeg");
  const fp = exeName("ffprobe");
  for (const dir of dirs) {
    if (existsSync(join(dir, ff)) && existsSync(join(dir, fp))) return dir;
  }
  return dirs[0];
}

/** Pure lookup: every candidate location, then PATH, then well-known dirs. */
async function scanBinaries(): Promise<Binaries | null> {
  // 1. Binaries shipped with the app (or downloaded by self-setup) — checked
  //    first so the packaged build never depends on the user's own installs.
  const bDir = bundledBinDir();
  const exe = exeName;
  const bFfmpeg = join(bDir, exe("ffmpeg"));
  const bFfprobe = join(bDir, exe("ffprobe"));
  if (existsSync(bFfmpeg) && existsSync(bFfprobe)) {
    return { ffmpeg: bFfmpeg, ffprobe: bFfprobe, source: "bundled" };
  }

  // 2. The user's own install (dev machines, or a manual FFmpeg install).
  const ffmpeg = await which("ffmpeg");
  const ffprobe = await which("ffprobe");
  if (ffmpeg && ffprobe) {
    return { ffmpeg, ffprobe, source: "PATH" };
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
          return { ffmpeg: p, ffprobe: existsSync(probe) ? probe : null, source: "found" };
        }
      }
    }
  }
  return null;
}

export async function findBinaries(): Promise<Binaries> {
  if (cached) return cached;

  const found = await scanBinaries();
  if (found) {
    cached = found;
    return cached;
  }

  // 3. Self-heal: on Windows the app can fetch a pinned FFmpeg build itself
  //    (~80 MB, one-time). This also covers the export path — a machine that
  //    never had FFmpeg becomes usable without the user touching a terminal.
  if (process.platform === "win32" && (await ensureFfmpeg())) {
    const healed = await scanBinaries();
    if (healed) {
      cached = healed;
      return cached;
    }
  }

  const missing: Binaries = { ffmpeg: null, ffprobe: null, source: "missing" };
  // Deliberately not assigned to `cached`: "missing" is only true until the
  // user installs ffmpeg, and Settings → Engines re-checks without a restart.
  // Caching it would pin the app to "FFmpeg missing" for the whole session.
  return missing;
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
    chain += `,atrim=start=${(clip.offset || 0).toFixed(4)}:duration=${Math.max(0.02, clip.duration * clip.speed).toFixed(4)}`;
    if (speeds.length) chain += `,atempo=${speeds.join(",")}`;
    chain += `,asetpts=N/SR/TB`;
    chain += `,volume=${Math.max(0, Math.min(4, clip.volume)).toFixed(4)}`;
    if (delayMs > 0) chain += `,adelay=delays=${delayMs}:all=1`;
    chain += `[amix_${i}]`;
    parts.push(chain);
    labels.push(`[amix_${i}]`);
  });

  parts.push(
    `${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0:dropout_transition=0,` +
      `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=stereo[aout]`,
  );
  return parts.join(";");
}

/* --------------------------------- session --------------------------------- */

interface Session {
  proc: import("node:child_process").ChildProcess | null;
  cancelled: boolean;
  ended: boolean;
  /**
   * Set when the encoder died before it could finish: a non-zero exit, a spawn
   * error or an explicit abort. `end()` must report this as a failure — a
   * truncated file must never be handed back as a successful export.
   */
  failed: string | null;
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
  /** Container format; must match the output path's extension. */
  format: "mp4" | "mov" | "mkv";
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

const MUXER_BY_FORMAT: Record<NonNullable<StartOptions["format"]>, string> = {
  mp4: "mp4",
  mov: "mov",
  mkv: "matroska",
};

/* ------------------------------ encoder choice ------------------------------ */

type VideoEncoder = {
  /** ffmpeg -c:v value. */
  name: "h264_nvenc" | "h264_qsv" | "libx264";
  /** Human label for progress messages. */
  label: string;
};

let encoderCache: VideoEncoder | null = null;

/**
 * Pick the fastest available H.264 encoder: NVIDIA NVENC, then Intel
 * QuickSync, then CPU x264. Probed once per process by asking ffmpeg to encode
 * a single 64x64 frame — the only reliable check, since `-encoders` lists
 * builds that fail at runtime (driver too old, no device).
 */
async function pickEncoder(ffmpeg: string): Promise<VideoEncoder> {
  if (encoderCache) return encoderCache;
  const candidates: VideoEncoder[] = [
    { name: "h264_nvenc", label: "GPU (NVENC)" },
    { name: "h264_qsv", label: "GPU (QuickSync)" },
  ];
  for (const candidate of candidates) {
    try {
      await execFileAsync(
        ffmpeg,
        [
          "-hide_banner", "-v", "error",
          "-f", "lavfi", "-i", "color=black:s=64x64:d=0.1",
          "-c:v", candidate.name, "-frames:v", "1",
          "-f", "null", "-",
        ],
        { timeout: 10_000, windowsHide: true },
      );
      encoderCache = candidate;
      return encoderCache;
    } catch {
      /* not usable on this machine — try the next */
    }
  }
  encoderCache = { name: "libx264", label: "CPU" };
  return encoderCache;
}

/** Encoder flags for one frame-size-agnostic H.264 encode at the given bitrate. */
function encoderArgs(encoder: VideoEncoder, bitrateMbps: number, fps: number): string[] {
  switch (encoder.name) {
    case "h264_nvenc":
      // p5 is the quality/speed sweet spot; rc vbr with maxrate/bufsize keeps
      // file sizes close to the slider's promise.
      return [
        "-c:v", "h264_nvenc",
        "-preset", "p5",
        "-rc", "vbr",
        "-cq", "23",
        "-maxrate", `${Math.round(bitrateMbps * 1.45)}M`,
        "-bufsize", `${Math.round(bitrateMbps * 2)}M`,
        "-g", String(fps * 2),
      ];
    case "h264_qsv":
      return [
        "-c:v", "h264_qsv",
        "-preset", "medium",
        "-global_quality", "23",
        "-maxrate", `${Math.round(bitrateMbps * 1.45)}M`,
        "-bufsize", `${Math.round(bitrateMbps * 2)}M`,
        "-g", String(fps * 2),
      ];
    default:
      return [
        "-c:v", "libx264",
        "-preset", "medium",
        "-profile:v", "high",
        "-b:v", `${Math.round(bitrateMbps)}M`,
        "-maxrate", `${Math.round(bitrateMbps * 1.45)}M`,
        "-bufsize", `${Math.round(bitrateMbps * 2)}M`,
        "-g", String(fps * 2),
      ];
  }
}

export async function startEncode(opts: StartOptions): Promise<Started> {
  const { ffmpeg } = await findBinaries();
  if (!ffmpeg) throw new Error("FFmpeg was not found. Install it and restart Zero Flow.");

  // One-time probe: NVENC → QuickSync → CPU. Falls back automatically when a
  // GPU exists but its driver refuses to encode.
  const encoder = await pickEncoder(ffmpeg);

  mkdirSync(dirname(opts.outputPath), { recursive: true });

  // Encode to a .part sibling and rename only on a clean exit, so a crash or
  // cancel never leaves a truncated file that looks playable. The muxer is
  // forced from the chosen format rather than inferred from the extension —
  // a mismatched filename can no longer silently produce a different container.
  const finalPath = opts.outputPath;
  const partPath = `${finalPath}.part`;
  const muxer = MUXER_BY_FORMAT[opts.format];

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
    ...encoderArgs(encoder, opts.bitrateMbps, opts.fps),
    // No explicit -level: the encoder picks the minimum compliant one, so
    // 4K/60 exports aren't stamped with the 1080p-era 4.1 limit that some
    // players reject.
    "-pix_fmt", "yuv420p",
    "-colorspace", "bt709",
    "-color_primaries", "bt709",
    "-color_trc", "bt709",
    ...(audioGraph ? ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : ["-an"]),
    // faststart relocates the index to the head of MP4-family files for
    // instant playback; Matroska has no equivalent and ignores the flag.
    ...(opts.format === "mkv" ? [] : ["-movflags", "+faststart"]),
    "-f", muxer,
    "-progress", "pipe:1",
    "-nostats",
    partPath,
  );

  const proc = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  console.log(`[export] encoder: ${encoder.label} (${encoder.name}) -> ${finalPath}`);

  let endResolve: () => void = () => {};
  const ended = new Promise<void>((r) => {
    endResolve = r;
  });

  const s: Session = { proc, cancelled: false, ended: false, failed: null, resolveEnd: endResolve };
  session = s;

  const stats = { fps: 0, frames: 0 };
  let stderrTail = "";

  const finish = (error?: string) => {
    s.ended = true;
    if (error) s.failed = error;
    if (session === s) session = null;
    s.resolveEnd();
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

  /** Promote the .part file to the final name, or discard it on any failure. */
  const settlePart = (keep: boolean): void => {
    try {
      if (keep && existsSync(partPath)) renameSync(partPath, finalPath);
      else rmSync(partPath, { force: true });
    } catch {
      /* best effort — a stuck .part is swept by the next export's -y overwrite */
    }
  };

  proc.on("close", (code) => {
    if (s.cancelled) {
      settlePart(false);
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
      settlePart(false);
      opts.onProgress({ phase: "error", progress: 0, message: msg, error: msg });
      finish(msg);
      return;
    }
    settlePart(true);
    opts.onProgress({
      phase: "done",
      progress: 1,
      message: "Render complete",
      outputPath: finalPath,
    });
    finish();
  });

  const writeFrame = async (rgba: ArrayBuffer): Promise<void> => {
    if (s.ended || s.cancelled) throw new Error("Render stopped");
    if (proc.stdin?.destroyed || proc.stdin?.writableEnded) throw new Error("Encoding pipe closed");
    const buf = Buffer.from(rgba);
    // Honour backpressure so ffmpeg is never flooded with queued bytes.
    if (proc.stdin.write(buf)) return;
    await new Promise<void>((resolve, reject) => {
      const stopListening = () => {
        clearTimeout(timer);
        proc.stdin?.off("drain", onDrain);
        proc.stdin?.off("close", onBroken);
        proc.stdin?.off("error", onBroken);
      };
      const onDrain = () => {
        stopListening();
        resolve();
      };
      // The encoder going away while we wait must fail the frame, not ack it —
      // otherwise the renderer believes bytes were accepted into a dead pipe.
      const onBroken = () => {
        stopListening();
        reject(new Error("Encoding pipe closed"));
      };
      // A minute without draining means the encode is dead. Refusing to queue
      // more bytes is better than growing the buffer without bound; the export
      // fails loudly instead of eating all available memory.
      const timer = setTimeout(() => {
        stopListening();
        reject(new Error("The encoder stopped accepting frames."));
      }, 60_000);
      proc.stdin?.once("drain", onDrain);
      proc.stdin?.once("close", onBroken);
      proc.stdin?.once("error", onBroken);
    });
  };

  return {
    bytesPerFrame: opts.width * opts.height * 4,
    get frameCount() {
      return stats.frames;
    },
    writeFrame,
    async end() {
      if (s.cancelled) return { ok: false, error: "cancelled" };
      if (s.failed) return { ok: false, error: s.failed };
      // Signal EOF. If the encoder already died, the finish callback may never
      // fire, so bound this wait by the close/abort promise instead of hanging.
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        if (proc.stdin && !proc.stdin.destroyed && !proc.stdin.writableEnded) {
          proc.stdin.end(settle);
        } else {
          settle();
        }
        void ended.then(settle);
      });
      await ended;
      if (s.cancelled) return { ok: false, error: "cancelled" };
      // A non-zero ffmpeg exit lands here too, so check it before claiming
      // success — otherwise a truncated file is reported as a finished export.
      if (s.failed) return { ok: false, error: s.failed };
      if (s.ended && stats.frames === 0) {
        return { ok: false, error: "Encoder produced no frames" };
      }
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(finalPath).size;
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
      settlePart(false);
      opts.onProgress({ phase: "error", progress: 0, message: error, error });
      finish(error);
    },
  };
}
