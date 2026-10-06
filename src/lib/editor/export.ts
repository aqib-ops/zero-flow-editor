import type { AudioTrackSpec, RenderProgress } from "@/types/window";
import { renderFrame, projectDuration } from "./render";
import { getAudio, getVideo } from "./media";
import type { EditorState } from "./types";

export interface ExportSettings {
  width: number;
  height: number;
  fps: number;
  bitrateMbps: number;
  outputPath: string;
}

export interface ExportProgress {
  phase: "starting" | "frames" | "finalizing" | "done" | "error" | "cancelled";
  progress: number;
  message: string;
  outputPath?: string;
  error?: string;
}

export interface ExportOutcome {
  ok: boolean;
  outputPath?: string;
  error?: string;
}

export const EXPORT_HEIGHTS = { "720p": 720, "1080p": 1080, "1440p": 1440, "4K": 2160 } as const;
export type ExportHeightLabel = keyof typeof EXPORT_HEIGHTS;

/** Even dimensions are required by H.264. */
const makeEven = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Keep the project's aspect ratio so the export framing matches the preview. */
export function resolveExportSize(
  state: EditorState,
  targetHeight: number,
): { width: number; height: number } {
  const ratio = state.settings.width / Math.max(1, state.settings.height);
  const height = makeEven(targetHeight);
  return { width: makeEven(height * ratio), height };
}

/**
 * Every audio-producing clip ffmpeg should mix: audio clips, plus the audio of
 * video clips that isn't muted and actually has a track.
 */
export function collectAudioTracks(state: EditorState): AudioTrackSpec[] {
  const assets = new Map(state.assets.map((a) => [a.id, a]));
  const out: AudioTrackSpec[] = [];
  for (const clip of state.clips) {
    const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
    if (!asset || clip.volume <= 0) continue;
    const isAudio = clip.kind === "audio";
    const isVideoAudio = clip.kind === "video" && asset.kind === "video" && asset.hasAudio;
    if (!isAudio && !isVideoAudio) continue;
    out.push({
      source: asset.path,
      start: clip.start,
      offset: clip.offset,
      duration: clip.duration,
      speed: clip.speed,
      volume: clip.volume,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/* ---------------------------- deterministic frames ------------------------- */

/**
 * Put every source media element exactly where a given timeline time needs it,
 * waiting for the seek to land. This is what makes the export deterministic
 * instead of depending on wall-clock playback.
 */
async function seekSources(state: EditorState, time: number): Promise<void> {
  const assets = new Map(state.assets.map((a) => [a.id, a]));
  const jobs: Promise<void>[] = [];

  for (const clip of state.clips) {
    const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
    if (!asset) continue;

    const active =
      time >= clip.start &&
      time < clip.start + clip.duration &&
      (asset.kind === "video" || asset.kind === "audio");
    const el =
      asset.kind === "video" ? getVideo(asset.url) : asset.kind === "audio" ? getAudio(asset.url) : null;
    if (!el) continue;

    if (!active) {
      if (!el.paused) el.pause();
      continue;
    }

    const target = clip.offset + (time - clip.start) * clip.speed;
    el.volume = asset.kind === "audio" ? Math.min(1, Math.max(0, clip.volume)) : 0;
    el.playbackRate = Math.min(4, Math.max(0.25, clip.speed));
    el.muted = true;

    if (Math.abs(el.currentTime - target) <= 1 / 60) continue;
    jobs.push(
      new Promise<void>((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          el.removeEventListener("seeked", finish);
          resolve();
        };
        el.addEventListener("seeked", finish);
        try {
          el.currentTime = Math.max(0, Math.min(target, (el.duration || target) - 0.001));
        } catch {
          finish();
        }
        // Never let one bad seek stall the whole export.
        setTimeout(finish, 350);
      }),
    );
  }

  await Promise.all(jobs);
}

const nextTick = () => new Promise<void>((r) => setTimeout(r, 0));

/* --------------------------------- export ---------------------------------- */

export interface ExportHandle {
  promise: Promise<ExportOutcome>;
  cancel: () => void;
}

export function exportVideo(
  state: EditorState,
  settings: ExportSettings,
  onProgress: (p: ExportProgress) => void,
): ExportHandle {
  const signal = { cancelled: false };

  const promise = (async (): Promise<ExportOutcome> => {
    const api = window.zf;
    if (!api?.render) {
      return { ok: false, error: "This build is not running in the desktop app." };
    }

    const total = projectDuration(state.clips);
    if (total <= 0) return { ok: false, error: "The timeline is empty." };

    const fps = Math.max(1, Math.round(settings.fps));
    const frameCount = Math.max(1, Math.round(total * fps));

    onProgress({ phase: "starting", progress: 0, message: "Starting the encoder…" });

    const started = await api.render.start({
      width: settings.width,
      height: settings.height,
      fps,
      bitrateMbps: settings.bitrateMbps,
      outputPath: settings.outputPath,
      audio: collectAudioTracks(state),
    });
    if (!started.ok) {
      return { ok: false, error: started.error ?? "Could not start the encoder." };
    }

    const canvas = document.createElement("canvas");
    canvas.width = settings.width;
    canvas.height = settings.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) {
      await api.render.cancel();
      return { ok: false, error: "Canvas 2D is unavailable." };
    }

    const renderState: EditorState = {
      ...state,
      settings: { ...state.settings, width: settings.width, height: settings.height },
    };

    const unsubscribe = api.render.onProgress((p: RenderProgress) => {
      if (p.phase === "error") {
        onProgress({ phase: "error", progress: 0, message: p.message, error: p.error });
      }
    });

    const every = Math.max(1, Math.floor(fps / 6));

    try {
      for (let i = 0; i < frameCount; i++) {
        if (signal.cancelled) {
          await api.render.cancel();
          return { ok: false, error: "cancelled" };
        }

        await seekSources(renderState, i / fps);
        renderFrame(ctx, renderState, i / fps);
        await sendFrame(api, ctx.getImageData(0, 0, settings.width, settings.height).data);

        if (i % every === 0 || i === frameCount - 1) {
          onProgress({
            phase: "frames",
            progress: (i / frameCount) * 0.97,
            message: `Frame ${i + 1} of ${frameCount}`,
          });
        }
        await nextTick();
      }

      onProgress({ phase: "finalizing", progress: 0.98, message: "Writing the file…" });
      const result = await api.render.finalize();
      if (!result.ok) {
        return { ok: false, error: result.error ?? "Encoding failed." };
      }
      onProgress({
        phase: "done",
        progress: 1,
        message: "Export complete",
        outputPath: settings.outputPath,
      });
      return { ok: true, outputPath: settings.outputPath };
    } catch (e) {
      try {
        await api.render.cancel();
      } catch {
        /* already stopped */
      }
      const message = (e as Error).message || "Export failed.";
      onProgress({ phase: "error", progress: 0, message, error: message });
      return { ok: false, error: message };
    } finally {
      unsubscribe();
    }
  })();

  return {
    promise,
    cancel: () => {
      signal.cancelled = true;
    },
  };
}

/**
 * Push one RGBA frame to the encoder, waiting for the main process ack so the
 * pipe is never flooded faster than ffmpeg can consume it.
 */
function sendFrame(
  api: NonNullable<Window["zf"]>,
  data: Uint8ClampedArray,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const off = api.render.onAck(() => {
      off();
      resolve();
    });
    api.render.frame(data.buffer as ArrayBuffer);
  });
}
