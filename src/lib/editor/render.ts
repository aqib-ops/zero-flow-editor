import { getAudio, getImage, getVideo } from "./media";
import { getStyle } from "./styles";
import type { Clip, EditorState, MediaAsset } from "./types";

export function clipEnd(c: Clip) {
  return c.start + c.duration;
}

export function projectDuration(clips: Clip[]) {
  return clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Cover-fit draw with scale + fractional nudge, keeping the frame anchored. */
function drawCover(
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

/** Contain-fit draw (letterbox) — used for overlays that should stay intact. */
function drawContain(
  ctx: CanvasRenderingContext2D,
  src: CanvasImageSource,
  sw: number,
  sh: number,
  W: number,
  H: number,
) {
  if (!sw || !sh) return;
  const s = Math.min(W / sw, H / sh);
  const w = sw * s;
  const h = sh * s;
  ctx.drawImage(src, (W - w) / 2, (H - h) / 2, w, h);
}

function animationTransform(clip: Clip, p: number) {
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
function applyTransition(
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

function drawVisualClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  asset: MediaAsset | undefined,
  time: number,
  W: number,
  H: number,
) {
  if (!asset) return;
  const local = time - clip.start;
  const p = clamp01(local / Math.max(0.001, clip.duration));
  const { scale, dx, dy } = animationTransform(clip, p);

  ctx.save();
  ctx.globalAlpha = clip.opacity;
  applyTransition(ctx, clip, local, W, H);

  if (asset.kind === "image") {
    const img = getImage(asset.url);
    if (img.complete && img.naturalWidth) {
      drawCover(ctx, img, img.naturalWidth, img.naturalHeight, W, H, scale, dx, dy);
    }
  } else if (asset.kind === "video") {
    const v = getVideo(asset.url);
    if (v.readyState >= 2 && v.videoWidth) {
      drawCover(ctx, v, v.videoWidth, v.videoHeight, W, H, scale, dx, dy);
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

/* --------------------------------- overlays -------------------------------- */

function mulberry(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
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
      const size = Math.max(2, Math.round(W / 420));
      for (let i = 0; i < 2200; i++) {
        const v = rnd();
        ctx.fillStyle = `rgba(255,255,255,${v * 0.18})`;
        ctx.fillRect(rnd() * W, rnd() * H, size, size);
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
 * Imported-overlay supporting draw: video or image overlays play/blend over the
 * frame with their own speed, trim, opacity and blend mode.
 */
function drawImportedOverlay(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  asset: MediaAsset,
  time: number,
  W: number,
  H: number,
) {
  const local = time - clip.start;
  const p = clamp01(local / Math.max(0.001, clip.duration));
  const { scale, dx, dy } = animationTransform(clip, p);

  if (asset.kind === "image") {
    const img = getImage(asset.url);
    if (img.complete && img.naturalWidth) {
      applyTransition(ctx, clip, local, W, H);
      drawCover(ctx, img, img.naturalWidth, img.naturalHeight, W, H, scale, dx, dy);
    }
    return;
  }

  if (asset.kind === "video") {
    const v = getVideo(asset.url);
    if (v.readyState >= 2 && v.videoWidth) {
      applyTransition(ctx, clip, local, W, H);
      drawContain(ctx, v, v.videoWidth, v.videoHeight, W, H);
    }
  }
}

function drawOverlayClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  time: number,
  W: number,
  H: number,
  asset: MediaAsset | undefined,
) {
  if (!clip.overlay) return;
  ctx.save();
  ctx.globalAlpha = clip.opacity;
  ctx.globalCompositeOperation = clip.blend;
  if (clip.overlay.type === "builtin") {
    drawBuiltinOverlay(ctx, clip.overlay.kind, time, W, H);
  } else if (asset) {
    drawImportedOverlay(ctx, clip, asset, time, W, H);
  }
  ctx.restore();
}

/* ----------------------------------- text ---------------------------------- */

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  time: number,
  W: number,
  H: number,
) {
  const st = getStyle(clip.styleId);
  const raw = (clip.text ?? "").replace(/\r?\n/g, " ");
  const content = st.uppercase ? raw.toUpperCase() : raw;
  if (!content.trim()) return;

  const local = time - clip.start;
  const pop = clamp01(local / 0.14);
  let fontSize = Math.round(st.size * H * (clip.sizeScale ?? 1));
  if (fontSize < 4) return;

  ctx.save();
  ctx.globalAlpha = clip.opacity;
  ctx.font = `${st.weight} ${fontSize}px ${st.font}`;
  ctx.textAlign = "center";
  const letterSpacing = clip.letterSpacing ?? st.letterSpacing ?? 0;
  if ("letterSpacing" in ctx) {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${letterSpacing}px`;
  }

  const wordSpacing = clip.wordSpacing ?? 0;
  if ("wordSpacing" in ctx) {
    (ctx as unknown as { wordSpacing: string }).wordSpacing = `${wordSpacing}px`;
  }

  const maxWidth = W * 0.86;
  const forceSingle = st.singleLine || clip.singleLine;
  let lines: string[];

  if (forceSingle) {
    const singleWidth = ctx.measureText(content).width;
    if (singleWidth > maxWidth && singleWidth > 0) {
      const fitScale = Math.max(0.55, maxWidth / singleWidth);
      fontSize = Math.round(fontSize * fitScale);
      ctx.font = `${st.weight} ${fontSize}px ${st.font}`;
    }
    lines = [content];
  } else {
    // If text is short (<= 4 words) and close to fitting, keep it on one clean line
    const singleWidth = ctx.measureText(content).width;
    if (singleWidth <= maxWidth * 1.15 && content.split(/\s+/).length <= 4) {
      if (singleWidth > maxWidth) {
        fontSize = Math.round(fontSize * (maxWidth / singleWidth));
        ctx.font = `${st.weight} ${fontSize}px ${st.font}`;
      }
      lines = [content];
    } else {
      lines = wrapLines(ctx, content, maxWidth);
    }
  }

  const lineH = fontSize * (clip.lineHeight ?? 1.18);
  const blockH = lines.length * lineH;

  // Vertical anchor: keep the text block inside the frame at any ratio.
  const anchor = clip.anchor ?? "bottom";
  let top: number;
  if (anchor === "top") top = H * 0.08;
  else if (anchor === "middle") top = (H - blockH) / 2;
  else top = H * 0.82 - blockH;
  top = Math.max(4, Math.min(H - blockH - 4, top));
  const cy = top + blockH / 2;

  // Entrance motion animation: silky smooth CapCut spring pop
  const transDur = clip.transitionDuration || 0.22;
  const progress = clamp01(local / transDur);

  let animScale = 1;
  let animOffsetY = 0;
  let animOffsetX = 0;
  let animAlpha = 1;

  if (clip.transition === "none" || !clip.transition) {
    // Pure clean cut — zero bounce, zero movement
    animScale = 1;
    animOffsetY = 0;
    animAlpha = 1;
  } else if (clip.transition === "fade") {
    // Silky smooth opacity fade
    animAlpha = easeOut(progress);
    animScale = 1.0;
  } else if (clip.transition === "slideUp") {
    // Subtle elegant upward drift
    const t = easeOut(progress);
    animOffsetY = (1 - t) * Math.min(28, fontSize * 0.45);
    animAlpha = t;
    animScale = 1.0;
  } else if (clip.transition === "slideLeft") {
    // Smooth horizontal glide
    const t = easeOut(progress);
    animOffsetX = (1 - t) * Math.min(36, fontSize * 0.55);
    animAlpha = t;
    animScale = 1.0;
  } else if (clip.transition === "push") {
    // Gentle punch in
    const t = easeOut(progress);
    animScale = 1.10 - 0.10 * t;
    animAlpha = t;
  } else if (clip.transition === "flash") {
    // High-impact flash
    animAlpha = progress < 0.25 ? 0.3 + progress * 2.8 : 1;
    animScale = progress < 0.4 ? 1.04 : 1.0;
  } else if (clip.transition === "zoomPop") {
    // CapCut Elastic Spring Pop
    if (progress < 0.55) {
      animScale = 0.72 + 0.35 * (progress / 0.55);
      animAlpha = Math.min(1, progress * 3);
    } else if (progress < 0.8) {
      const p2 = (progress - 0.55) / 0.25;
      animScale = 1.07 - 0.09 * p2;
      animAlpha = 1;
    } else {
      const p3 = (progress - 0.8) / 0.2;
      animScale = 0.98 + 0.02 * p3;
      animAlpha = 1;
    }
  }

  ctx.globalAlpha = clip.opacity * animAlpha;
  ctx.translate(W / 2 + animOffsetX, cy + animOffsetY);
  ctx.scale(animScale, animScale);
  ctx.translate(-W / 2, -cy);

  if (st.background) {
    const wMax = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const padX = fontSize * 0.55;
    const padY = fontSize * 0.32;
    const bw = wMax + padX * 2;
    const bh = blockH + padY * 2;
    const bx = W / 2 - bw / 2;
    const by = cy - bh / 2;
    const r = Math.min(bh / 2, fontSize * 0.35);
    ctx.fillStyle = st.background;
    ctx.beginPath();
    ctx.roundRect(bx, by, bw, bh, r);
    ctx.fill();
  }

  lines.forEach((l, i) => {
    const y = cy - blockH / 2 + lineH / 2 + i * lineH;
    if (st.shadow) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
      ctx.shadowBlur = fontSize * 0.2;
      ctx.shadowOffsetY = fontSize * 0.04;
    }
    if (st.strokeWidth > 0 && st.stroke && st.stroke !== "transparent") {
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeStyle = st.stroke;
      // Cap stroke width so it remains clean, crisp, and never forms harsh black outlines
      ctx.lineWidth = fontSize * Math.min(0.08, st.strokeWidth);
      ctx.strokeText(l, W / 2, y);
    }
    ctx.shadowBlur = st.shadow ? fontSize * 0.15 : 0;
    ctx.fillStyle = st.color;
    ctx.fillText(l, W / 2, y);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  });

  ctx.restore();
}

/* ---------------------------------- frame ---------------------------------- */

export function activeClips(state: EditorState, time: number) {
  return state.clips.filter((c) => time >= c.start && time < clipEnd(c) - 0.0001);
}

export function renderFrame(ctx: CanvasRenderingContext2D, state: EditorState, time: number) {
  const { width: W, height: H } = state.settings;
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.fillStyle = state.settings.background;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  const assets = new Map(state.assets.map((a) => [a.id, a]));
  const order = ["video", "overlay", "text"] as const;

  for (const kind of order) {
    const tracks = state.tracks.filter((t) => t.kind === kind && !t.hidden);
    for (const track of tracks) {
      if (track.locked) continue;
      const clips = state.clips
        .filter((c) => c.trackId === track.id && time >= c.start && time < clipEnd(c))
        .sort((a, b) => a.start - b.start);
      for (const clip of clips) {
        const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
        if (clip.opacity <= 0) continue;
        if (kind === "video") drawVisualClip(ctx, clip, asset, time, W, H);
        else if (kind === "overlay") drawOverlayClip(ctx, clip, time, W, H, asset);
        else drawTextClip(ctx, clip, time, W, H);
      }
    }
  }
}

/* ------------------------------ playback sync ------------------------------ */

function syncElement(
  el: HTMLVideoElement | HTMLAudioElement,
  clip: Clip,
  time: number,
  playing: boolean,
  volume: number,
  muted: boolean,
) {
  const inside = time >= clip.start && time < clipEnd(clip);
  if (!inside) {
    if (!el.paused) el.pause();
    return;
  }
  const target = clip.offset + (time - clip.start) * clip.speed;
  if (Math.abs(el.currentTime - target) > 0.25) {
    try {
      el.currentTime = Math.max(0, target);
    } catch {
      /* seek not ready */
    }
  }
  el.playbackRate = Math.min(4, Math.max(0.25, clip.speed));
  el.volume = muted ? 0 : Math.min(1, Math.max(0, volume));
  if (playing && el.paused) void el.play().catch(() => {});
  if (!playing && !el.paused) el.pause();
}

export function syncVideoElements(state: EditorState, time: number, playing: boolean) {
  const assets = new Map(state.assets.map((a) => [a.id, a]));
  const tracks = new Map(state.tracks.map((t) => [t.id, t]));
  for (const clip of state.clips) {
    const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
    if (!asset || asset.kind !== "video") continue;
    const track = tracks.get(clip.trackId);
    syncElement(getVideo(asset.url), clip, time, playing, clip.volume, track?.muted ?? false);
  }
}

export function syncAudioElements(state: EditorState, time: number, playing: boolean) {
  const assets = new Map(state.assets.map((a) => [a.id, a]));
  const tracks = new Map(state.tracks.map((t) => [t.id, t]));
  for (const clip of state.clips) {
    if (clip.kind !== "audio" && clip.kind !== "video") continue;
    const asset = clip.assetId ? assets.get(clip.assetId) : undefined;
    if (!asset) continue;
    const url = asset.kind === "audio" ? asset.url : asset.url;
    const track = tracks.get(clip.trackId);
    syncElement(getAudio(url), clip, time, playing, clip.volume, track?.muted ?? false);
  }
}
