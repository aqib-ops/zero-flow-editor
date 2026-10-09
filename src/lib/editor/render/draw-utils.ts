import type { Clip } from "../types";

export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Cover-fit draw with scale + fractional nudge, keeping the frame anchored. */
export function drawCover(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  W: number,
  H: number,
  scale: number,
  dx: number,
  dy: number,
) {
  if (!sw || !sh) return;
  const base = Math.max(W / sw, H / sh);
  const s = base * scale;
  const w = sw * s;
  const h = sh * s;
  ctx.drawImage(src, (W - w) / 2 + dx * W, (H - h) / 2 + dy * H, w, h);
}

/**
 * Contain-fit draw (letterbox) for overlays that should stay intact. Still
 * honours the animation scale/nudge so zoom and pan effects reach video
 * overlays the same way they reach regular clips.
 */
export function drawContain(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  W: number,
  H: number,
  scale = 1,
  dx = 0,
  dy = 0,
) {
  if (!sw || !sh) return;
  const s = Math.min(W / sw, H / sh) * scale;
  const w = sw * s;
  const h = sh * s;
  ctx.drawImage(src, (W - w) / 2 + dx * W, (H - h) / 2 + dy * H, w, h);
}

export function animationTransform(clip: Clip, p: number) {
  const amt = clip.animationAmount ?? 0.12;
  switch (clip.animation) {
    case "zoomIn":
      return { scale: 1 + amt * p, dx: 0, dy: 0 };
    case "zoomOut":
      return { scale: 1 + amt * (1 - p), dx: 0, dy: 0 };
    case "panLeft":
      return { scale: 1 + amt, dx: (amt / 2) * (0.5 - p), dy: 0 };
    case "panRight":
      return { scale: 1 + amt, dx: (amt / 2) * (p - 0.5), dy: 0 };
    case "panUp":
      return { scale: 1 + amt, dx: 0, dy: (amt / 2) * (0.5 - p) };
    case "panDown":
      return { scale: 1 + amt, dx: 0, dy: (amt / 2) * (p - 0.5) };
    default:
      return { scale: 1, dx: 0, dy: 0 };
  }
}

/** Applies a clip's in-point transition to the context state. */
export function applyTransition(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  local: number,
  W: number,
  H: number,
) {
  if (clip.transition === "none") return;
  const td = Math.min(clip.transitionDuration || 0, clip.duration);
  if (td <= 0 || local >= td) return;
  const t = easeOut(clamp01(local / td));
  switch (clip.transition) {
    case "slideLeft":
      ctx.translate((1 - t) * W, 0);
      break;
    case "slideUp":
      ctx.translate(0, (1 - t) * H);
      break;
    case "push":
      ctx.translate((1 - t) * W * 0.25, 0);
      break;
    case "wipe":
      ctx.beginPath();
      ctx.rect(0, 0, W * t, H);
      ctx.clip();
      break;
    case "zoomPop":
      ctx.translate(W / 2, H / 2);
      ctx.scale(0.86 + 0.14 * t, 0.86 + 0.14 * t);
      ctx.translate(-W / 2, -H / 2);
      break;
    case "flash":
      break;
  }
}
