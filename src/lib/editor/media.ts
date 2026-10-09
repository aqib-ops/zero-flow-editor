import type { AssetKind, MediaAsset } from "./types";

export const uid = () => Math.random().toString(36).slice(2, 10);

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "avif", "bmp", "tif", "tiff"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "ogg", "oga", "flac", "opus", "wma", "aiff", "aif"];
const VIDEO_EXT = ["mp4", "mov", "webm", "mkv", "avi", "m4v", "wmv", "flv", "ts", "m2ts", "mpg", "mpeg"];

export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function kindFromPath(path: string): AssetKind | null {
  const ext = extOf(path);
  if (IMAGE_EXT.includes(ext)) return "image";
  if (AUDIO_EXT.includes(ext)) return "audio";
  if (VIDEO_EXT.includes(ext)) return "video";
  return null;
}

/**
 * Narrowing helpers used by the renderer and export pipeline. The predicates
 * keep the `kind` literal so an `else if` chain doesn't collapse to `never`.
 */
export function isImageAsset(
  asset: MediaAsset | undefined,
): asset is MediaAsset & { kind: "image" } {
  return asset?.kind === "image";
}

export function isVideoAsset(
  asset: MediaAsset | undefined,
): asset is MediaAsset & { kind: "video" } {
  return asset?.kind === "video";
}

export function isAudioAsset(
  asset: MediaAsset | undefined,
): asset is MediaAsset & { kind: "audio" } {
  return asset?.kind === "audio";
}

/** Sort names naturally so "clip 2" comes before "clip 10". */
export function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** file:// URL for a local path, with the escaping Chromium needs on Windows. */
export function toFileUrl(path: string): string {
  if (!path) return "";
  if (
    path.startsWith("zf-media://") ||
    path.startsWith("http://") ||
    path.startsWith("https://") ||
    path.startsWith("blob:") ||
    path.startsWith("data:")
  ) {
    return path;
  }
  let p = path;
  if (p.startsWith("file://")) {
    p = decodeURI(p.replace(/^file:\/\//, ""));
  }
  p = p.replace(/\\/g, "/");
  if (!p.startsWith("/")) p = "/" + p;

  if (typeof window !== "undefined" && window.zf?.isDesktop) {
    const cleanPath = p.length > 2 && p[0] === "/" && p[2] === ":" ? p.slice(1) : p;
    return "zf-media://local/" + encodeURI(cleanPath).replace(/\?/g, "%3F").replace(/#/g, "%23");
  }
  return "file://" + encodeURI(p).replace(/\?/g, "%3F").replace(/#/g, "%23");
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not decode image: ${url}`));
    img.src = url;
  });
}

function loadVideo(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => resolve(v);
    v.onerror = () => reject(new Error(`Could not decode video: ${url}`));
    v.src = url;
  });
}

function loadAudio(url: string): Promise<HTMLAudioElement> {
  return new Promise((resolve, reject) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () => resolve(a);
    a.onerror = () => reject(new Error(`Could not decode audio: ${url}`));
    a.src = url;
  });
}

function videoThumb(video: HTMLVideoElement): string | undefined {
  try {
    const c = document.createElement("canvas");
    const w = 192;
    c.width = w;
    c.height = Math.max(1, Math.round((video.videoHeight / Math.max(1, video.videoWidth)) * w));
    const ctx = c.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL("image/jpeg", 0.62);
  } catch {
    return undefined;
  }
}

/**
 * Build an asset from an absolute path. Uses the browser decoders first (they
 * are the same ones that play the preview), and falls back to ffprobe when the
 * container is something Chromium refuses to touch.
 */
export async function assetFromPath(path: string, probe?: () => Promise<{
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
}>): Promise<MediaAsset | null> {
  const kind = kindFromPath(path);
  if (!kind) return null;

  const url = toFileUrl(path);
  const base: MediaAsset = {
    id: uid(),
    name: baseName(path),
    kind,
    path,
    url,
    duration: 4,
    width: 1920,
    height: 1080,
    hasAudio: false,
  };

  try {
    if (kind === "image") {
      let finalThumb = url;
      if (window.zf?.media?.toDataUrl) {
        try {
          const dUrl = await window.zf.media.toDataUrl(path);
          if (dUrl) finalThumb = dUrl;
        } catch (error) {
          console.warn("[media] thumbnail conversion failed, using source URL", path, error);
        }
      }
      const img = await loadImage(finalThumb || url);
      return {
        ...base,
        duration: 4,
        width: img.naturalWidth || 1920,
        height: img.naturalHeight || 1080,
        thumb: finalThumb,
      };
    }
    if (kind === "video") {
      const v = await loadVideo(url);
      const nativeDur = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
      const nativeW = v.videoWidth || 0;
      const nativeH = v.videoHeight || 0;
      let probed:
        | { duration: number; width: number; height: number; hasAudio: boolean }
        | undefined;
      if (probe) {
        try {
          probed = await probe();
        } catch (probeError) {
          console.warn(`[media] ffprobe metadata failed for ${base.name}`, probeError);
        }
      }
      return {
        ...base,
        duration: nativeDur || (probed?.duration && probed.duration > 0 ? probed.duration : 5),
        width: nativeW || probed?.width || 1920,
        height: nativeH || probed?.height || 1080,
        hasAudio: probed?.hasAudio ?? false,
        thumb: videoThumb(v),
      };
    }
    const a = await loadAudio(url);
    const dur = Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    if (!dur && probe) {
      const p = await probe();
      return { ...base, duration: p.duration > 0 ? p.duration : 10, hasAudio: p.hasAudio };
    }
    return { ...base, duration: dur || 10, hasAudio: true };
  } catch (error) {
    console.warn(`[media] browser decode failed for ${base.name}`, error);
    // Undecodable in the renderer — ffprobe may still salvage the metadata.
    if (probe) {
      try {
        const p = await probe();
        return {
          ...base,
          duration: p.duration || 5,
          width: p.width || 1920,
          height: p.height || 1080,
          hasAudio: p.hasAudio,
        };
      } catch (probeError) {
        console.error(`[media] ffprobe fallback failed for ${base.name}`, probeError);
      }
    }
    return null;
  }
}

/* --------------------------- element cache (preview) ------------------------ */

const imageCache = new Map<string, HTMLImageElement>();
const videoCache = new Map<string, HTMLVideoElement>();
const audioCache = new Map<string, HTMLAudioElement>();

type MediaListener = () => void;
const mediaListeners = new Set<MediaListener>();

export function onMediaLoaded(cb: MediaListener): () => void {
  mediaListeners.add(cb);
  return () => {
    mediaListeners.delete(cb);
  };
}

export function notifyMediaLoaded(): void {
  for (const cb of mediaListeners) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

export function getImage(url: string): HTMLImageElement {
  let el = imageCache.get(url);
  if (!el) {
    el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => notifyMediaLoaded();
    el.onerror = () => console.warn("[media] image failed to load", url);
    el.src = url;
    imageCache.set(url, el);
  }
  return el;
}

/**
 * Wait until a cached image has decoded enough to be drawn. Export uses this
 * before compositing a frame so an image overlay can never be skipped just
 * because its decode completed after the frame render began.
 */
export function waitForImage(url: string, timeoutMs = 15_000): Promise<HTMLImageElement> {
  const image = getImage(url);
  if (image.complete && image.naturalWidth > 0) return Promise.resolve(image);

  return new Promise<HTMLImageElement>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.removeEventListener("load", onLoad);
      image.removeEventListener("error", onError);
      if (error) reject(error);
      else resolve(image);
    };
    const onLoad = () => finish();
    const onError = () => finish(new Error(`Could not decode image: ${url}`));
    const timer = setTimeout(
      () => finish(new Error(`Timed out waiting for image: ${url}`)),
      timeoutMs,
    );

    image.addEventListener("load", onLoad);
    image.addEventListener("error", onError);
    // The image may have completed between the initial check and listener
    // registration.
    if (image.complete) onLoad();
  });
}

export function getVideo(url: string, owner = "shared"): HTMLVideoElement {
  const key = `${url}\0${owner}`;
  let el = videoCache.get(key);
  if (!el) {
    el = document.createElement("video");
    el.src = url;
    el.preload = "auto";
    el.playsInline = true;
    el.crossOrigin = "anonymous";
    el.onloadeddata = () => notifyMediaLoaded();
    el.onseeked = () => notifyMediaLoaded();
    el.onerror = () => console.warn("[media] video failed to load", url);
    videoCache.set(key, el);
  }
  return el;
}

export function getAudio(url: string, owner = "shared"): HTMLAudioElement {
  const key = `${url}\0${owner}`;
  let el = audioCache.get(key);
  if (!el) {
    el = new Audio(url);
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    el.onerror = () => console.warn("[media] audio failed to load", url);
    audioCache.set(key, el);
  }
  return el;
}

export function releaseAsset(url: string): void {
  imageCache.delete(url);
  const prefix = `${url}\0`;
  for (const [key, video] of videoCache) {
    if (!key.startsWith(prefix)) continue;
    video.pause();
    video.removeAttribute("src");
    video.load();
    videoCache.delete(key);
  }
  for (const [key, audio] of audioCache) {
    if (!key.startsWith(prefix)) continue;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    audioCache.delete(key);
  }
}

export function formatTime(t: number, withMs = true): string {
  if (!Number.isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const ms = Math.floor((t % 1) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${withMs ? "." + ms : ""}`;
}
