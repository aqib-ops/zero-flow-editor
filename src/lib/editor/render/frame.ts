import { drawOverlayClip } from "./overlay";
import { activeClipsForTrack, resolveClipAsset, type RenderScene } from "./scene";
import { drawTextClip } from "./text";
import { drawVisualClip } from "./visual";

export function renderFrame(
  ctx: CanvasRenderingContext2D,
  scene: RenderScene,
  time: number,
) {
  const { width: W, height: H } = scene.settings;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = scene.settings.background;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  const order = ["video", "overlay", "text"] as const;
  for (const kind of order) {
    const tracks = scene.layerTracks[kind];
    // Timeline rows render top-to-bottom in tracks-array order, so drawing in
    // reverse paints the topmost row last — higher rows sit in front of lower
    // ones, matching CapCut-style layer stacking.
    for (let i = tracks.length - 1; i >= 0; i--) {
      const track = tracks[i];
      const clips = activeClipsForTrack(
        scene.clipsByTrack.get(track.id) ?? [],
        time,
        scene.prefixMaxEndByTrack.get(track.id),
      );
      for (const clip of clips) {
        if (clip.opacity <= 0) continue;
        const asset = resolveClipAsset(scene, clip);
        if (kind === "video") drawVisualClip(ctx, clip, asset, time, W, H, scene);
        else if (kind === "overlay") drawOverlayClip(ctx, clip, time, W, H, asset, scene);
        else drawTextClip(ctx, clip, time, W, H);
      }
    }
  }
}
