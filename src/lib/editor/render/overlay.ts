import { getImage, getVideo, isImageAsset, isVideoAsset } from "../media";
import type { Clip, MediaAsset } from "../types";
import { animationTransform, applyTransition, clamp01, drawContain } from "./draw-utils";
import { mediaOwnerForClip, type RenderScene } from "./scene";

function mulberry(seed: number) {
  let value = seed;
  return function () {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GRAIN_TILE_SIZE = 128;
const GRAIN_TILE_LIMIT = 96;
const grainTiles = new Map<number, HTMLCanvasElement>();

/**
 * Film grain used to issue 2,200 fillRect calls per frame. A small repeating
 * tile keeps the same look while reducing the hot loop to one pattern fill.
 */
function getGrainTile(seed: number): HTMLCanvasElement {
  const cached = grainTiles.get(seed);
  if (cached) return cached;

  const tile = document.createElement("canvas");
  tile.width = GRAIN_TILE_SIZE;
  tile.height = GRAIN_TILE_SIZE;
  const tileCtx = tile.getContext("2d");
  if (tileCtx) {
    const image = tileCtx.createImageData(GRAIN_TILE_SIZE, GRAIN_TILE_SIZE);
    const rnd = mulberry(seed);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.floor(rnd() * 46);
    }
    tileCtx.putImageData(image, 0, 0);
  }

  if (grainTiles.size >= GRAIN_TILE_LIMIT) {
    const oldest = grainTiles.keys().next().value;
    if (oldest !== undefined) grainTiles.delete(oldest);
  }
  grainTiles.set(seed, tile);
  return tile;
}

function drawBuiltinOverlay(
  ctx: CanvasRenderingContext2D,
  kind: string,
  time: number,
  W: number,
  H: number,
) {
  const seed = Math.floor(time * 24);
  const rnd = mulberry(seed + 1);
  switch (kind) {
    case "grain": {
      const pattern = ctx.createPattern(getGrainTile(seed + 1), "repeat");
      if (pattern) {
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case "particles": {
      for (let i = 0; i < 55; i++) {
        const r0 = mulberry(i * 97 + 13);
        const bx = r0();
        const by = r0();
        const sp = 0.02 + r0() * 0.08;
        const y = (by - ((time * sp) % 1) + 1) % 1;
        const rad = (0.001 + r0() * 0.004) * W;
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,240,200,${0.25 + r0() * 0.6})`;
        ctx.arc(bx * W + Math.sin(time + i) * W * 0.01, y * H, rad, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case "dust": {
      for (let i = 0; i < 75; i++) {
        const r0 = mulberry(i * 31 + 7);
        const bx = r0();
        const by = r0();
        const drift = Math.sin(time * 0.6 + i) * 0.01;
        ctx.fillStyle = `rgba(255,255,255,${0.1 + r0() * 0.3})`;
        ctx.fillRect((bx + drift) * W, ((by + time * 0.01) % 1) * H, W * 0.0015, W * 0.0015);
      }
      break;
    }
    case "vignette": {
      const g = ctx.createRadialGradient(
        W / 2,
        H / 2,
        Math.min(W, H) * 0.25,
        W / 2,
        H / 2,
        Math.max(W, H) * 0.72,
      );
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,0.95)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      break;
    }
    case "scanlines": {
      const step = Math.max(2, Math.round(H / 360));
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      for (let y = 0; y < H; y += step * 2) ctx.fillRect(0, y, W, step);
      break;
    }
    case "light": {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, "rgba(255,196,120,0.55)");
      g.addColorStop(0.5, "rgba(255,255,255,0)");
      g.addColorStop(1, "rgba(120,180,255,0.45)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      break;
    }
  }
}

/**
 * Imported video/image overlays play, blend and transition using the same
 * rules as the main visual track.
 */
function drawImportedOverlay(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  asset: MediaAsset,
  time: number,
  W: number,
  H: number,
  scene: RenderScene,
) {
  const local = time - clip.start;
  const p = clamp01(local / Math.max(0.001, clip.duration));
  const { scale, dx, dy } = animationTransform(clip, p);

  if (isImageAsset(asset)) {
    const img = getImage(asset.url);
    if (img.complete && img.naturalWidth) {
      applyTransition(ctx, clip, local, W, H);
      drawContain(ctx, img, img.naturalWidth, img.naturalHeight, W, H, scale, dx, dy);
    }
    return;
  }

  if (isVideoAsset(asset)) {
    const video = getVideo(asset.url, mediaOwnerForClip(scene, clip));
    if (video.readyState >= 2 && video.videoWidth) {
      applyTransition(ctx, clip, local, W, H);
      drawContain(ctx, video, video.videoWidth, video.videoHeight, W, H, scale, dx, dy);
    }
  }
}

export function drawOverlayClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  time: number,
  W: number,
  H: number,
  asset: MediaAsset | undefined,
  scene: RenderScene,
) {
  if (!clip.overlay) return;
  ctx.save();
  ctx.globalAlpha = clip.opacity;
  ctx.globalCompositeOperation = clip.blend;
  if (clip.overlay.type === "builtin") {
    drawBuiltinOverlay(ctx, clip.overlay.kind, time - clip.start, W, H);
  } else if (asset) {
    drawImportedOverlay(ctx, clip, asset, time, W, H, scene);
  }
  ctx.restore();
}
