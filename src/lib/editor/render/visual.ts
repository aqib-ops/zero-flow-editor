import { getImage, getVideo, isImageAsset, isVideoAsset } from "../media";
import type { Clip, MediaAsset } from "../types";
import { animationTransform, applyTransition, clamp01, drawCover } from "./draw-utils";
import { mediaOwnerForClip, type RenderScene } from "./scene";

export function drawVisualClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  asset: MediaAsset | undefined,
  time: number,
  W: number,
  H: number,
  scene: RenderScene,
) {
  if (!asset) return;
  const local = time - clip.start;
  const p = clamp01(local / Math.max(0.001, clip.duration));
  const { scale, dx, dy } = animationTransform(clip, p);

  ctx.save();
  ctx.globalAlpha = clip.opacity;
  ctx.globalCompositeOperation = clip.blend || "source-over";
  applyTransition(ctx, clip, local, W, H);

  if (isImageAsset(asset)) {
    const img = getImage(asset.url);
    if (img.complete && img.naturalWidth) {
      drawCover(ctx, img, img.naturalWidth, img.naturalHeight, W, H, scale, dx, dy);
    }
  } else if (isVideoAsset(asset)) {
    const video = getVideo(asset.url, mediaOwnerForClip(scene, clip));
    if (video.readyState >= 2 && video.videoWidth) {
      drawCover(ctx, video, video.videoWidth, video.videoHeight, W, H, scale, dx, dy);
    }
  }

  if (clip.transition === "flash") {
    const td = Math.min(clip.transitionDuration || 0, clip.duration);
    if (td > 0 && local < td) {
      ctx.globalAlpha = (1 - local / td) * 0.9;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
    }
  }
  ctx.restore();
}
