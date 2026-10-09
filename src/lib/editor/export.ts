import type { AudioTrackSpec, RenderProgress } from "@/types/window";
import {
  buildRenderScene,
  mediaOwnerForClip,
  projectDuration,
  renderFrame,
  resolveClipAsset,
  type RenderScene,
} from "./render";
import { getAudio, getVideo, waitForImage } from "./media";
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
  const scene = buildRenderScene(state);
  const out: AudioTrackSpec[] = [];
  for (const clip of scene.mediaClips) {
    // Imported overlays are visual-only; their audio is intentionally not mixed.
    if (clip.kind === "overlay") continue;
    const asset = resolveClipAsset(scene, clip);
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
function waitForMetadata(
  element: HTMLMediaElement,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  if (element.readyState >= 1) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      element.removeEventListener("loadedmetadata", onLoaded);
      element.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onLoaded = () => finish();
    const onError = () => finish(new Error(`Could not load media: ${label}`));

    element.addEventListener("loadedmetadata", onLoaded);
    element.addEventListener("error", onError);
    timer = setTimeout(
      () => finish(new Error(`Timed out loading media metadata: ${label}`)),
      timeoutMs,
    );
    if (element.readyState >= 1) finish();
  });
}

function seekMediaElement(
  element: HTMLMediaElement,
  target: number,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  return (async () => {
    await waitForMetadata(element, label, timeoutMs);
    const duration =
      Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;
    const safeTarget = Math.max(
      0,
      duration > 0 ? Math.min(target, duration - Math.min(0.001, duration * 0.001)) : target,
    );
    if (Math.abs(element.currentTime - safeTarget) <= 1 / 120) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        element.removeEventListener("seeked", onSeeked);
        element.removeEventListener("error", onError);
        if (error) reject(error);
        else resolve();
      };
      const onSeeked = () => {
        if (Math.abs(element.currentTime - safeTarget) > 1 / 30) {
          finish(
            new Error(
              `Media seek did not reach ${safeTarget.toFixed(3)}s: ${label}`,
            ),
          );
          return;
        }
        finish();
      };
      const onError = () => finish(new Error(`Could not seek media: ${label}`));

      element.addEventListener("seeked", onSeeked);
      element.addEventListener("error", onError);
      timer = setTimeout(
        () => finish(new Error(`Timed out seeking media: ${label}`)),
        timeoutMs,
      );

      try {
        element.currentTime = safeTarget;
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error(`Could not seek media: ${label}`),
        );
      }
    });
  })();
}

async function seekSources(scene: RenderScene, time: number): Promise<void> {
  const jobs: Promise<void>[] = [];

  for (const clip of scene.mediaClips) {
    const asset = resolveClipAsset(scene, clip);
    if (!asset) continue;

    const active = time >= clip.start && time < clip.start + clip.duration;
    if (asset.kind === "image") {
      if (active) jobs.push(waitForImage(asset.url).then(() => undefined));
      continue;
    }
    if (asset.kind !== "video" && asset.kind !== "audio") continue;

    const owner = mediaOwnerForClip(scene, clip);
    const el = asset.kind === "video" ? getVideo(asset.url, owner) : getAudio(asset.url, owner);

    if (!active) {
      if (!el.paused) el.pause();
      continue;
    }

    const target = clip.offset + (time - clip.start) * clip.speed;
    // When a clip extends past its source media, wrap the seek target so the
    // media loops instead of clamping to the final frame.
    const sourceDuration =
      Number.isFinite(el.duration) && el.duration > 0 ? el.duration : 0;
    const wrapped =
      sourceDuration > 0 && target >= sourceDuration ? target % sourceDuration : target;
    // Export audio is mixed by FFmpeg from the source files. Keep every
    // renderer media element silent so preview/export cannot leak audio.
    el.volume = 0;
    el.playbackRate = Math.min(4, Math.max(0.25, clip.speed));
    el.muted = true;
    jobs.push(seekMediaElement(el, wrapped, asset.name));
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

    let unsubscribe: (() => void) | null = null;
    try {
      const started = await api.render.start({
        width: settings.width,
        height: settings.height,
        fps,
        bitrateMbps: settings.bitrateMbps,
        outputPath: settings.outputPath,
        audio: collectAudioTracks(state),
      });
      if (!started.ok) {
        const error = started.error ?? "Could not start the encoder.";
        onProgress({ phase: "error", progress: 0, message: error, error });
        return { ok: false, error };
      }

      const canvas = document.createElement("canvas");
      canvas.width = settings.width;
      canvas.height = settings.height;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) {
        const error = "Canvas 2D is unavailable.";
        await api.render.cancel().catch((cancelError) => {
          console.warn("[export] encoder cleanup failed", cancelError);
        });
        onProgress({ phase: "error", progress: 0, message: error, error });
        return { ok: false, error };
      }

      const renderState: EditorState = {
        ...state,
        settings: { ...state.settings, width: settings.width, height: settings.height },
      };
      const scene = buildRenderScene(renderState, "export:");

      if (document.fonts?.ready) {
        await document.fonts.ready;
      }

      unsubscribe = api.render.onProgress((p: RenderProgress) => {
        if (p.phase === "error") {
          onProgress({ phase: "error", progress: 0, message: p.message, error: p.error });
        }
      });

      const every = Math.max(1, Math.floor(fps / 6));

      for (let i = 0; i < frameCount; i++) {
        if (signal.cancelled) {
          await api.render.cancel();
          return { ok: false, error: "cancelled" };
        }

        await seekSources(scene, i / fps);
        renderFrame(ctx, scene, i / fps);
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
      } catch (cancelError) {
        console.warn("[export] encoder cleanup failed", cancelError);
      }
      const message = e instanceof Error ? e.message : "Export failed.";
      console.error("[export] failed", e);
      onProgress({ phase: "error", progress: 0, message, error: message });
      return { ok: false, error: message };
    } finally {
      unsubscribe?.();
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
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let off = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      off();
      if (error) reject(error);
      else resolve();
    };
    off = api.render.onAck(() => finish());
    timer = setTimeout(
      () => finish(new Error("The encoder stopped responding while receiving a frame.")),
      20000,
    );
    try {
      api.render.frame(data.buffer as ArrayBuffer);
    } catch (error) {
      finish(error instanceof Error ? error : new Error("Could not send a frame to the encoder."));
    }
  });
}
