export type { ScriptLine } from "./types";

// Parses lines shaped like:
// Image 001 | 00:00.0 - 00:05.7 (5.7s) | Some narration text.
// Also tolerates: 001 | 0:00 - 0:05 | text  and  00:00:05.700 timestamps,
// plus SRT-style "00:00:01,000 --> 00:00:05,700" lines.

import type { ScriptLine } from "./types";

function parseTime(raw: string): number | null {
  const t = raw.trim();
  // hh:mm:ss.mmm / mm:ss.mmm / mm:ss
  const m = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:[.,]\d+)?)$/);
  if (m) {
    const h = m[1] ? Number(m[1]) : 0;
    const min = Number(m[2]);
    const sec = Number(m[3].replace(",", "."));
    return h * 3600 + min * 60 + sec;
  }
  // bare seconds or "5.7s"
  const m2 = t.match(/^(\d{1,4}(?:[.,]\d+)?)s?$/);
  if (m2) return Number(m2[1].replace(",", "."));
  return null;
}

export function parseScript(input: string): ScriptLine[] {
  const out: ScriptLine[] = [];
  const lines = input.split(/\r?\n/);
  let i = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    // SRT cue line: "00:00:01,000 --> 00:00:05,700" (no pipes)
    const srt = line.match(/^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)\s*(.*)$/);
    if (srt) {
      const start = parseTime(srt[1]);
      const end = parseTime(srt[2]);
      if (start === null || end === null || end <= start) continue;
      out.push({
        index: i++,
        label: `Line ${i}`,
        start,
        end,
        duration: end - start,
        text: (srt[3] ?? "").trim(),
      });
      continue;
    }

    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 2) continue;

    const label = parts[0];
    const timePart = parts[1];
    const text = parts.slice(2).join(" | ").trim();

    // Support "-->" inside the time column as well.
    const range = timePart.match(/([\d:.,]+)\s*(?:-|–|—|to|-->)\s*([\d:.,]+)/);
    if (!range) continue;
    const start = parseTime(range[1]);
    const end = parseTime(range[2]);
    if (start === null || end === null || end <= start) continue;

    out.push({
      index: i++,
      label,
      start,
      end,
      duration: end - start,
      text,
    });
  }
  return out;
}

/** Trailing number in a label / filename, e.g. "Image 001" -> 1, "shot_012.png" -> 12. */
export function numberKey(name: string): number | null {
  const base = name.replace(/\.[a-z0-9]+$/i, "");
  const matches = base.match(/(\d+)(?!.*\d)/);
  return matches ? Number(matches[1]) : null;
}

/** Split a sentence into caption chunks of at most `maxWords` words. */
export function chunkCaption(text: string, maxWords: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += Math.max(1, maxWords)) {
    chunks.push(words.slice(i, i + maxWords).join(" "));
  }
  return chunks;
}
