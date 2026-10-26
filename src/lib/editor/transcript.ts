/**
 * Transcript helpers for the Speech to Text tool.
 *
 * Whisper returns raw segments with float seconds. Every timestamp shown,
 * copied or exported here is derived through these functions so the three
 * views (segments / 2-second cues / plain text) and the .srt export can
 * never disagree with each other.
 */

export interface TranscriptSegment {
  start: number;
  end: number;
  duration: number;
  text: string;
}

export interface TranscriptCue {
  start: number;
  end: number;
  text: string;
}

const round3 = (t: number): number => Math.round(t * 1000) / 1000;

/** Clean raw Whisper segments: sorted, finite times, non-empty text. */
export function normalizeSegments(raw: unknown): TranscriptSegment[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptSegment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const s = item as Partial<TranscriptSegment>;
    const start = typeof s.start === "number" && Number.isFinite(s.start) ? Math.max(0, s.start) : 0;
    let end = typeof s.end === "number" && Number.isFinite(s.end) ? Math.max(0, s.end) : start;
    if (!(end > start)) end = start + 0.5;
    const text = typeof s.text === "string" ? s.text.replace(/\s+/g, " ").trim() : "";
    if (!text) continue;
    out.push({ start: round3(start), end: round3(end), duration: round3(end - start), text });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Group segments into ~2-second buckets, keyed by where each segment starts.
 *
 * Every segment lands in exactly one bucket, so no text is duplicated or
 * dropped. A cue starts at its bucket's start and runs to the later of its
 * bucket end and the furthest-reaching sentence in it, then hands over to the
 * next cue — so a sentence that overruns its bucket stays on screen long enough
 * to read, consecutive cues never overlap, and no silence is left between them.
 */
export function chunkIntoWindows(
  segments: TranscriptSegment[],
  windowSec = 2,
  mediaDuration?: number,
): TranscriptCue[] {
  if (segments.length === 0 || !(windowSec > 0)) return [];
  const groups = new Map<number, TranscriptSegment[]>();
  for (const seg of segments) {
    const idx = Math.floor(seg.start / windowSec);
    const list = groups.get(idx);
    if (list) list.push(seg);
    else groups.set(idx, [seg]);
  }
  const ordered = [...groups.keys()].sort((a, b) => a - b);
  const cap =
    typeof mediaDuration === "number" && Number.isFinite(mediaDuration) && mediaDuration > 0
      ? round3(mediaDuration)
      : null;

  const cues: TranscriptCue[] = [];
  let cursor = 0;
  for (const idx of ordered) {
    const parts = groups.get(idx) ?? [];
    const windowStart = round3(idx * windowSec);
    const windowEnd = round3((idx + 1) * windowSec);
    // Whisper segments are not guaranteed to be sorted, so the latest end in
    // the bucket decides how long the cue must stay up — not the last entry.
    const spokenEnd = parts.length
      ? round3(parts.reduce((max, s) => Math.max(max, s.end), 0))
      : windowEnd;
    const start = Math.max(windowStart, cursor);
    let end = Math.max(windowEnd, spokenEnd);
    if (cap !== null) end = Math.min(end, cap);
    if (!(end > start)) end = round3(start + 0.5);
    cursor = end;
    cues.push({
      start: round3(start),
      end: round3(end),
      text: parts.map((s) => s.text).join(" "),
    });
  }
  return cues;
}

/** HH:MM:SS,mmm — the exact SubRip timestamp format. */
export function formatSRTTime(t: number): string {
  const ms = Math.max(0, Math.round((Number.isFinite(t) ? t : 0) * 1000));
  const hh = Math.floor(ms / 3600000);
  const mm = Math.floor((ms % 3600000) / 60000);
  const ss = Math.floor((ms % 60000) / 1000);
  const mmm = ms % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(mmm, 3)}`;
}

/** Compact badge for list rows: M:SS.d, or H:MM:SS.d past an hour. */
export function formatClock(t: number): string {
  const safe = Math.max(0, Number.isFinite(t) ? t : 0);
  const totalTenths = Math.floor(safe * 10);
  const tenths = totalTenths % 10;
  const totalSec = Math.floor(totalTenths / 10);
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  return hh > 0 ? `${hh}:${pad2(mm)}:${pad2(ss)}.${tenths}` : `${mm}:${pad2(ss)}.${tenths}`;
}

/** Full .srt document for segments or cues — numbered cues, one trailing newline. */
export function segmentsToSRT(cues: Array<{ start: number; end: number; text: string }>): string {
  if (cues.length === 0) return "";
  return (
    cues
      .map((c, i) => {
        const safeEnd = c.end > c.start ? c.end : round3(c.start + 0.5);
        return `${i + 1}\n${formatSRTTime(c.start)} --> ${formatSRTTime(safeEnd)}\n${c.text}`;
      })
      .join("\n\n") + "\n"
  );
}

/** Plain reading text — no timestamps. */
export function segmentsToText(segments: Array<{ text: string }>): string {
  return segments
    .map((s) => s.text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
}
