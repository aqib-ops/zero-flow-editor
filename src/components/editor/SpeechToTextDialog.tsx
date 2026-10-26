import { useEffect, useMemo, useState } from "react";
import {
  Copy,
  FileText,
  FolderOpen,
  Loader2,
  Mic,
  Plus,
  Save,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { baseName, kindFromPath } from "@/lib/editor/media";
import {
  chunkIntoWindows,
  formatClock,
  formatSRTTime,
  normalizeSegments,
  segmentsToSRT,
  segmentsToText,
  type TranscriptSegment,
} from "@/lib/editor/transcript";

export interface SttPayload {
  segments: TranscriptSegment[];
  sourceName: string;
  mediaDuration: number;
}

type Tab = "timestamps" | "text";

async function copyText(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied`);
    return;
  } catch {
    /* clipboard API unavailable — fall back below */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toast.success(`${label} copied`);
  } catch {
    toast.error("Could not copy to clipboard");
  }
}

export function SpeechToTextDialog({
  open,
  onClose,
  onUseInProject,
}: {
  open: boolean;
  onClose: () => void;
  onUseInProject: (payload: SttPayload) => void;
}) {
  const [filePath, setFilePath] = useState("");
  const [fileName, setFileName] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [mediaDuration, setMediaDuration] = useState(0);
  const [language, setLanguage] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("timestamps");
  const [saving, setSaving] = useState(false);

  const done = segments.length > 0;
  const chunks = useMemo(
    () => chunkIntoWindows(segments, 2, mediaDuration || undefined),
    [segments, mediaDuration],
  );
  const plainText = useMemo(() => segmentsToText(segments), [segments]);
  // The timestamped view always shows the fixed ~2-second cues.
  const activeCues = chunks;

  const reset = () => {
    setFilePath("");
    setFileName("");
    setError(null);
    setSegments([]);
    setMediaDuration(0);
    setLanguage(null);
    setTab("timestamps");
  };

  // Closing mid-transcription would abandon the Whisper process without a way
  // back to the result, so ignore dismiss requests while a job is running.
  const requestClose = () => {
    if (!working) onClose();
  };

  const pickFile = async () => {
    const paths = await window.zf?.dialog?.openMedia();
    const picked = paths?.[0];
    if (!picked) return;
    const kind = kindFromPath(picked);
    if (kind !== "audio" && kind !== "video") {
      toast.error("Please choose an audio or video file");
      return;
    }
    reset();
    setFilePath(picked);
    setFileName(baseName(picked));
    void transcribe(picked);
  };

  const transcribe = async (path: string) => {
    if (working) return;
    setWorking(true);
    setError(null);
    try {
      if (!window.zf?.whisper?.transcribe) {
        throw new Error("Local Whisper bridge not ready. Please restart the app.");
      }
      const res = await window.zf.whisper.transcribe(path);
      if (!res.ok) throw new Error(res.error || "Transcription failed.");
      const clean = normalizeSegments(res.segments);
      if (clean.length === 0) throw new Error("No speech detected in this file.");
      const dur =
        typeof res.duration === "number" && res.duration > 0
          ? res.duration
          : clean[clean.length - 1].end;
      setSegments(clean);
      setMediaDuration(dur);
      setLanguage(typeof res.language === "string" ? res.language : null);
      toast.success(`Transcribed ${clean.length} lines`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed.");
    } finally {
      setWorking(false);
    }
  };

  const saveFile = async (asSrt: boolean) => {
    if (!done || saving) return;
    const stem = fileName.replace(/\.[a-z0-9]+$/i, "") || "transcript";
    const content = asSrt ? segmentsToSRT(activeCues) : plainText + "\n";
    const defaultName = `${stem}${asSrt ? ".2s.srt" : ".txt"}`;
    setSaving(true);
    try {
      const saved = await window.zf?.text?.save({ defaultName, content });
      if (saved) toast.success(`Saved ${baseName(saved)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save file.");
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !working) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, working, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="stt-title"
        className="animate-in pop-in flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-panel-raised shadow-2xl"
      >
        {/* header */}
        <div className="flex shrink-0 items-start gap-3 border-b border-border p-5 pb-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary/60">
            <Mic className="size-5 text-white" />
          </span>
          <div className="min-w-0">
            <h3 id="stt-title" className="text-base font-semibold tracking-tight">
              Speech to Text
            </h3>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {fileName || "Local Whisper base · offline · timestamps to the millisecond"}
            </p>
          </div>
          <button
            onClick={requestClose}
            aria-label="Close speech to text"
            className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-rail hover:text-foreground"
            title="Close"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {!filePath && !working && (
            <div className="grid place-items-center rounded-xl border border-dashed border-border bg-panel/60 px-6 py-12 text-center">
              <span className="grid size-12 place-items-center rounded-2xl bg-secondary">
                <Mic className="size-5 text-muted-foreground" />
              </span>
              <p className="mt-4 text-sm font-medium">Transcribe any audio or video</p>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                Runs the bundled Whisper base model on this PC — no upload, no timeline needed.
                You get two outputs: timestamped cues (about 2 seconds apart) and clean plain text.
              </p>
              <Button size="sm" className="mt-5" onClick={pickFile}>
                <FolderOpen className="size-3.5" /> Choose audio / video
              </Button>
            </div>
          )}

          {working && (
            <div className="grid place-items-center rounded-xl border border-border bg-panel/60 px-6 py-12 text-center">
              <Loader2 className="size-7 animate-spin text-primary" />
              <p className="mt-4 text-sm font-medium">Transcribing “{fileName}”…</p>
              <p className="mt-1 max-w-md text-xs leading-relaxed text-muted-foreground">
                Local Whisper base is listening. Long files take longer — the app stays usable
                while it works.
              </p>
            </div>
          )}

          {error && !working && (
            <div
              className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-center"
              role="alert"
            >
              <p className="text-sm font-medium text-destructive">{error}</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={pickFile}>
                <FolderOpen className="size-3.5" /> Try another file
              </Button>
            </div>
          )}

          {done && (
            <>
              {/* stats */}
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span className="rounded-full bg-secondary px-2.5 py-1 font-medium">
                  {segments.length} lines
                </span>
                <span className="rounded-full bg-secondary px-2.5 py-1 font-medium">
                  {formatClock(mediaDuration)} total
                </span>
                {language && (
                  <span className="rounded-full bg-secondary px-2.5 py-1 font-medium uppercase">
                    {language}
                  </span>
                )}
                <button
                  onClick={pickFile}
                  className="ml-auto font-medium text-primary hover:underline"
                >
                  Choose another file
                </button>
              </div>

              {/* tabs */}
              <div
                className="mt-4 flex gap-1 rounded-lg border border-border bg-background p-1"
                role="tablist"
                aria-label="Transcript view"
              >
                {(
                  [
                    { id: "timestamps", label: "Timestamps" },
                    { id: "text", label: "Plain text" },
                  ] as const
                ).map((t) => (
                  <button
                    key={t.id}
                    role="tab"
                    type="button"
                    aria-selected={tab === t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      "h-8 flex-1 rounded-md text-xs font-semibold transition-colors",
                      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      tab === t.id
                        ? "bg-primary/15 text-foreground ring-1 ring-primary/40"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* views */}
              {tab !== "text" ? (
                <ol
                  className="mt-3 space-y-1.5"
                  role="tabpanel"
                  aria-label="Timestamped cues, about 2 seconds apart"
                >
                  {activeCues.map((c, i) => (
                    <li
                      key={`${c.start}-${i}`}
                      className="group flex items-start gap-3 rounded-lg border border-border/70 bg-background px-3 py-2"
                    >
                      <span
                        className="mt-0.5 shrink-0 rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground"
                        title={`${formatSRTTime(c.start)} --> ${formatSRTTime(c.end)}`}
                      >
                        {formatClock(c.start)} → {formatClock(c.end)}
                      </span>
                      <span className="min-w-0 flex-1 text-[13px] leading-relaxed">{c.text}</span>
                      <button
                        onClick={() =>
                          void copyText(
                            `${formatClock(c.start)} → ${formatClock(c.end)} ${c.text}`,
                            "Line",
                          )
                        }
                        className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-rail hover:text-foreground group-hover:opacity-100"
                        title="Copy this line with its timecodes"
                        aria-label="Copy this line with its timecodes"
                      >
                        <Copy className="size-3" />
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <div
                  className="mt-3 rounded-lg border border-border/70 bg-background p-4"
                  role="tabpanel"
                  aria-label="Plain text without timestamps"
                >
                  <p className="text-[13px] leading-relaxed">{plainText}</p>
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    {plainText.split(/\s+/).filter(Boolean).length} words · no timestamps
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* footer */}
        {done && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border p-4">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void copyText(
                  tab === "text" ? plainText : segmentsToSRT(activeCues),
                  tab === "text" ? "Text" : "Timestamps",
                )
              }
            >
              <Copy className="size-3.5" /> Copy {tab === "text" ? "text" : "timestamps"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void saveFile(true)} disabled={saving}>
              <Save className="size-3.5" /> Save .srt
            </Button>
            <Button size="sm" variant="outline" onClick={() => void saveFile(false)} disabled={saving}>
              <FileText className="size-3.5" /> Save .txt
            </Button>
            <div className="ml-auto flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={requestClose}>
                Close
              </Button>
              <Button
                size="sm"
                className="bg-gradient-to-r from-primary to-primary/70 font-medium"
                onClick={() =>
                  onUseInProject({
                    segments,
                    sourceName: fileName.replace(/\.[a-z0-9]+$/i, ""),
                    mediaDuration,
                  })
                }
              >
                <Plus className="size-3.5" /> Use in new project
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
