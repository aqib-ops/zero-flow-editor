import { getStyle } from "../styles";
import type { Clip } from "../types";
import { clamp01, easeOut } from "./draw-utils";

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export function drawTextClip(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  time: number,
  W: number,
  H: number,
) {
  const style = getStyle(clip.styleId);
  const raw = (clip.text ?? "").replace(/\r?\n/g, " ");
  const content = style.uppercase ? raw.toUpperCase() : raw;
  if (!content.trim()) return;

  const local = time - clip.start;
  let fontSize = Math.round(style.size * H * (clip.sizeScale ?? 1));
  if (fontSize < 4) return;

  ctx.save();
  ctx.globalAlpha = clip.opacity;
  ctx.font = `${style.weight} ${fontSize}px ${style.font}`;
  ctx.textAlign = "center";
  const letterSpacing = clip.letterSpacing ?? style.letterSpacing ?? 0;
  if ("letterSpacing" in ctx) {
    (ctx as unknown as { letterSpacing: string }).letterSpacing = `${letterSpacing}px`;
  }

  const wordSpacing = clip.wordSpacing ?? 0;
  if ("wordSpacing" in ctx) {
    (ctx as unknown as { wordSpacing: string }).wordSpacing = `${wordSpacing}px`;
  }

  const maxWidth = W * 0.86;
  const forceSingle = style.singleLine || clip.singleLine;
  let lines: string[];

  if (forceSingle) {
    const singleWidth = ctx.measureText(content).width;
    if (singleWidth > maxWidth && singleWidth > 0) {
      const fitScale = Math.max(0.55, maxWidth / singleWidth);
      fontSize = Math.round(fontSize * fitScale);
      ctx.font = `${style.weight} ${fontSize}px ${style.font}`;
    }
    lines = [content];
  } else {
    const singleWidth = ctx.measureText(content).width;
    if (singleWidth <= maxWidth * 1.15 && content.split(/\s+/).length <= 4) {
      if (singleWidth > maxWidth) {
        fontSize = Math.round(fontSize * (maxWidth / singleWidth));
        ctx.font = `${style.weight} ${fontSize}px ${style.font}`;
      }
      lines = [content];
    } else {
      lines = wrapLines(ctx, content, maxWidth);
    }
  }

  const lineH = fontSize * (clip.lineHeight ?? 1.18);
  const blockH = lines.length * lineH;
  const anchor = clip.anchor ?? "bottom";
  let top: number;
  if (anchor === "top") top = H * 0.08;
  else if (anchor === "middle") top = (H - blockH) / 2;
  else top = H * 0.82 - blockH;
  top = Math.max(4, Math.min(H - blockH - 4, top));
  const cy = top + blockH / 2;

  const transitionDuration = clip.transitionDuration || 0.22;
  const progress = clamp01(local / transitionDuration);
  let animationScale = 1;
  let animationOffsetY = 0;
  let animationOffsetX = 0;
  let animationAlpha = 1;

  if (clip.transition === "none" || !clip.transition) {
    animationScale = 1;
    animationOffsetY = 0;
    animationAlpha = 1;
  } else if (clip.transition === "fade") {
    animationAlpha = easeOut(progress);
    animationScale = 1;
  } else if (clip.transition === "slideUp") {
    const t = easeOut(progress);
    animationOffsetY = (1 - t) * Math.min(28, fontSize * 0.45);
    animationAlpha = t;
    animationScale = 1;
  } else if (clip.transition === "slideLeft") {
    const t = easeOut(progress);
    animationOffsetX = (1 - t) * Math.min(36, fontSize * 0.55);
    animationAlpha = t;
    animationScale = 1;
  } else if (clip.transition === "push") {
    const t = easeOut(progress);
    animationScale = 1.1 - 0.1 * t;
    animationAlpha = t;
  } else if (clip.transition === "flash") {
    animationAlpha = progress < 0.25 ? 0.3 + progress * 2.8 : 1;
    animationScale = progress < 0.4 ? 1.04 : 1;
  } else if (clip.transition === "zoomPop") {
    if (progress < 0.55) {
      animationScale = 0.72 + 0.35 * (progress / 0.55);
      animationAlpha = Math.min(1, progress * 3);
    } else if (progress < 0.8) {
      const p2 = (progress - 0.55) / 0.25;
      animationScale = 1.07 - 0.09 * p2;
      animationAlpha = 1;
    } else {
      const p3 = (progress - 0.8) / 0.2;
      animationScale = 0.98 + 0.02 * p3;
      animationAlpha = 1;
    }
  }

  ctx.globalAlpha = clip.opacity * animationAlpha;
  ctx.translate(W / 2 + animationOffsetX, cy + animationOffsetY);
  ctx.scale(animationScale, animationScale);
  ctx.translate(-W / 2, -cy);

  if (style.background) {
    const maxLineWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
    const padX = fontSize * 0.55;
    const padY = fontSize * 0.32;
    const boxWidth = maxLineWidth + padX * 2;
    const boxHeight = blockH + padY * 2;
    const boxX = W / 2 - boxWidth / 2;
    const boxY = cy - boxHeight / 2;
    const radius = Math.min(boxHeight / 2, fontSize * 0.35);
    ctx.fillStyle = style.background;
    ctx.beginPath();
    ctx.roundRect(boxX, boxY, boxWidth, boxHeight, radius);
    ctx.fill();
  }

  lines.forEach((line, index) => {
    const y = cy - blockH / 2 + lineH / 2 + index * lineH;
    if (style.shadow) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
      ctx.shadowBlur = fontSize * 0.2;
      ctx.shadowOffsetY = fontSize * 0.04;
    }
    if (style.strokeWidth > 0 && style.stroke && style.stroke !== "transparent") {
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = fontSize * Math.min(0.08, style.strokeWidth);
      ctx.strokeText(line, W / 2, y);
    }
    ctx.shadowBlur = style.shadow ? fontSize * 0.15 : 0;
    ctx.fillStyle = style.color;
    ctx.fillText(line, W / 2, y);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
  });

  ctx.restore();
}
