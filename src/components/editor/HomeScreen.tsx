import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Clapperboard,
  ExternalLink,
  Film,
  Images,
  Mic,
  Minus,
  Plus,
  Square,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { makeClip, useEditor } from "@/lib/editor/store";
import { toFileUrl } from "@/lib/editor/media";
import { CAPTION_STYLES } from "@/lib/editor/styles";
import type { ProjectFile, Track } from "@/lib/editor/types";
import type { TranscriptSegment } from "@/lib/editor/transcript";
import { SpeechToTextDialog, type SttPayload } from "./SpeechToTextDialog";

type AspectRatio = ProjectFile["settings"]["aspectRatio"];

const RATIOS: AspectRatio[] = ["16:9", "9:16", "1:1", "4:5", "4:3", "3:4", "21:9"];
const FPS_OPTIONS = [24, 30, 60] as const;

const RATIO_SIZE: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
  "4:3": { width: 1440, height: 1080 },
  "3:4": { width: 1080, height: 1440 },
  "21:9": { width: 2560, height: 1080 },
};

/** Fixed ids so transcript clips can target the text track deterministically. */
const NEW_PROJECT_TRACKS: Track[] = [
  { id: "t-text", kind: "text", name: "Text" },
  { id: "t-overlay", kind: "overlay", name: "Overlays" },
  { id: "t-video", kind: "video", name: "Video 1" },
  { id: "t-audio", kind: "audio", name: "Audio 1" },
];

interface RecentProject {
  id: string;
  name: string;
  savedAt: number;
  data: unknown;
}

/** Card metadata extracted once per list render, not per frame. */
interface RecentMeta {
  ratio?: string;
  clipCount: number;
  duration: number;
  thumb?: string;
}

/**
 * Reads the stored (pre-sanitization) JSON defensively: the card only shows a
 * ratio badge, a count and a duration, and every field is clamped/validated
 * here so a hand-edited project file can't produce absurd card text. The full
 * sanitizeLoadedState pass runs when the project is actually opened.
 */
function metaOf(data: unknown): RecentMeta {
  const p = data as Partial<ProjectFile> | null;
  const clips = Array.isArray(p?.clips) ? p!.clips : [];
  const assets = Array.isArray(p?.assets) ? p!.assets : [];
  const rawDuration = clips.reduce((max, c) => Math.max(max, (c?.start ?? 0) + (c?.duration ?? 0)), 0);
  const ratio = p?.settings?.aspectRatio;
  return {
    ratio: RATIOS.includes(ratio as AspectRatio) ? ratio : undefined,
    clipCount: Math.min(clips.length, 9999),
    duration: Number.isFinite(rawDuration) ? Math.min(Math.max(0, rawDuration), 86_400) : 0,
    thumb:
      assets.find((a) => a && typeof a.thumb === "string" && a.thumb.startsWith("data:image/"))
        ?.thumb,
  };
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return "";
  const m = Math.floor(totalSeconds / 60);
  const s = Math.round(totalSeconds % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

interface PendingTranscript {
  segments: TranscriptSegment[];
  sourceName: string;
}

/**
 * Browser-based companion tools. These are links only — nothing is bundled or
 * rendered locally, so the cards stay deliberately compact next to the
 * full-size editor actions.
 */
interface WebTool {
  id: string;
  name: string;
  blurb: string;
  /** Primary URL; extras are shown as a small picker in the confirm dialog. */
  urls: string[];
  Icon: typeof ExternalLink;
}

const WEB_TOOLS: WebTool[] = [
  {
    id: "script-to-image",
    name: "Script to Prompts",
    blurb: "Turn a script into a sequence of scene image prompts.",
    urls: ["https://images-composer-ai.lovable.app/"],
    Icon: Images,
  },
  {
    id: "text-to-image",
    name: "Text to Image",
    blurb: "Generate images from a text prompt in Gemini.",
    urls: [
      "https://gemini.google.com/share/26b1c2d69587",
      "https://gemini.google.com/share/79e5de5150e6",
    ],
    Icon: Type,
  },
];

/** Compact host label so the card shows where a link goes without the full URL. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Host + path (for links sharing a host, e.g. two Gemini share URLs). */
function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

/** Little ratio glyph so the picker reads visually, like CapCut's canvas presets. */
function RatioGlyph({ ratio }: { ratio: AspectRatio }) {
  const [w, h] = ratio.split(":").map(Number);
  const aspect = `${w} / ${h}`;
  return (
    <span className="grid h-9 w-12 place-items-center rounded-md bg-rail p-1.5">
      <span className="max-h-full max-w-full rounded-[3px] border-2 border-muted-foreground" style={{ aspectRatio: aspect, width: w >= h ? "100%" : "auto", height: h > w ? "100%" : "auto" }} />
    </span>
  );
}

function HomeTitleBar() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => window.zf?.window?.onMaximizeChange(setMaximized), []);
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel-raised px-3">
      <Film className="size-4 text-primary" />
      <span className="text-xs font-semibold tracking-tight">Zero Flow</span>
      <span className="hidden text-[11px] text-muted-foreground sm:inline">offline video editor</span>
      {window.zf?.window && (
        <div className="ml-auto flex items-center">
          <button
            className="grid h-9 w-11 place-items-center text-muted-foreground hover:bg-rail hover:text-foreground"
            onClick={() => void window.zf?.window?.minimize()}
            title="Minimize"
            aria-label="Minimize"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            className="grid h-9 w-11 place-items-center text-muted-foreground hover:bg-rail hover:text-foreground"
            onClick={() => void window.zf?.window?.toggleMaximize()}
            title={maximized ? "Restore" : "Maximize"}
            aria-label={maximized ? "Restore" : "Maximize"}
          >
            <Square className="size-3" />
          </button>
          <button
            className="grid h-9 w-11 place-items-center text-muted-foreground hover:bg-destructive/90 hover:text-white"
            onClick={() => void window.zf?.window?.close()}
            title="Close"
            aria-label="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Home screen: autosaved Recent Projects plus the session launcher.
 *
 * Projects autosave to <userData>/projects while the editor is open — there is
 * no save button and no folder picker. The list is read straight from disk, so
 * it is always in sync with what a crash left behind.
 */
export function HomeScreen({
  onNewProject,
  onOpenProject,
}: {
  onNewProject: (name: string) => void;
  onOpenProject: (info: { id: string; name: string }) => void;
}) {
  const { loadProject } = useEditor();
  const [recents, setRecents] = useState<RecentProject[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [ratio, setRatio] = useState<AspectRatio>("16:9");
  const [fps, setFps] = useState<number>(30);
  const [sttOpen, setSttOpen] = useState(false);
  const [pendingTranscript, setPendingTranscript] = useState<PendingTranscript | null>(null);
  const [toolPrompt, setToolPrompt] = useState<WebTool | null>(null);

  const refreshRecents = useCallback(() => {
    window.zf?.projects
      ?.list()
      .then(setRecents)
      .catch(() => setRecents([]));
  }, []);

  // Initial load + refresh whenever the home screen is shown or focused, so a
  // project saved in another window appears without a restart.
  useEffect(refreshRecents, [refreshRecents]);
  useEffect(() => {
    window.addEventListener("focus", refreshRecents);
    return () => window.removeEventListener("focus", refreshRecents);
  }, [refreshRecents]);

  const openRecent = async (recent: RecentProject) => {
    try {
      const stored = await window.zf?.projects?.load(recent.id);
      if (!stored) throw new Error("Project data is missing.");
      const data = stored.data as ProjectFile;
      // Rebuild the renderer URLs from the stored absolute paths.
      const assets = (data.assets ?? []).map((a) => ({ ...a, url: toFileUrl(a.path) }));
      loadProject({
        settings: data.settings,
        tracks: data.tracks,
        clips: data.clips,
        assets,
      });
      onOpenProject({ id: recent.id, name: stored.name });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open project.");
    }
  };

  const removeRecent = async (recent: RecentProject) => {
    if (!window.confirm(`Delete "${recent.name}"? This cannot be undone.`)) return;
    try {
      await window.zf?.projects?.remove(recent.id);
      setRecents((list) => list.filter((r) => r.id !== recent.id));
      toast.success("Project deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete project.");
    }
  };

  /** Confirm-then-open: never launch a browser without an explicit click here. */
  const openTool = async (url: string) => {
    const bridge = window.zf?.app?.openExternal;
    if (!bridge) {
      toast.error("Opening links is only available in the desktop app.");
      return;
    }
    setToolPrompt(null);
    try {
      await bridge(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not open the link.");
    }
  };

  const useTranscriptInProject = (payload: SttPayload) => {
    setPendingTranscript({ segments: payload.segments, sourceName: payload.sourceName });
    setSttOpen(false);
    if (!newName.trim() && payload.sourceName) setNewName(payload.sourceName);
    setCreateOpen(true);
  };

  /** Dismiss the new-project dialog; any attached transcript goes with it. */
  const closeCreate = () => {
    setCreateOpen(false);
    setPendingTranscript(null);
  };

  const createProject = () => {
    const size = RATIO_SIZE[ratio];
    const name = newName.trim() || pendingTranscript?.sourceName || "Untitled project";
    // An attached transcript becomes caption clips with the exact Whisper
    // timestamps, so the new timeline opens already subtitled.
    const transcriptClips = (pendingTranscript?.segments ?? [])
      .filter((s) => s.text && s.end > s.start)
      .map((s) =>
        makeClip({
          trackId: "t-text",
          kind: "text",
          name: s.text.slice(0, 16) || "Caption",
          start: s.start,
          duration: Math.max(0.35, s.duration || s.end - s.start),
          text: s.text,
          styleId: CAPTION_STYLES[0].id,
          anchor: "bottom",
          singleLine: true,
          sizeScale: 1,
          letterSpacing: 0,
          wordSpacing: 0,
          lineHeight: 1.18,
          transition: "fade",
          transitionDuration: 0.16,
        }),
      );
    loadProject({
      settings: {
        width: size.width,
        height: size.height,
        aspectRatio: ratio,
        fps,
        background: "#000000",
      },
      tracks: NEW_PROJECT_TRACKS.map((track) => ({ ...track })),
      clips: transcriptClips,
      assets: [],
    });
    toast.success(
      transcriptClips.length > 0
        ? `Project created with ${transcriptClips.length} captions`
        : "Project created",
    );
    setCreateOpen(false);
    setNewName("");
    setPendingTranscript(null);
    onNewProject(name);
  };

  const metas = useMemo(() => {
    const m = new Map<string, RecentMeta>();
    for (const r of recents) m.set(r.id, metaOf(r.data));
    return m;
  }, [recents]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <HomeTitleBar />

      {/* top bar */}
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border bg-panel px-5 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary/50 shadow-sm">
            <Clapperboard className="size-4.5 text-white" />
          </span>
          <div className="leading-tight">
            <h1 className="text-sm font-semibold tracking-tight">Zero Flow</h1>
            <p className="text-[11px] text-muted-foreground">
              Projects autosave locally — recoverable even after a crash
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button size="sm" className="h-8 bg-gradient-to-r from-primary to-primary/70 font-medium" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" /> New project
          </Button>
        </div>
      </header>

      {/* body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-5xl px-5 py-5">
          {/* hero */}
          <div className="grid gap-3 lg:grid-cols-2">
            <button
              onClick={() => setCreateOpen(true)}
              className="group relative overflow-hidden rounded-xl border border-primary/30 bg-gradient-to-br from-primary/25 via-panel-raised to-panel-raised p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/60 hover:shadow-lg"
            >
              <div className="pointer-events-none absolute -right-8 -top-8 size-28 rounded-full bg-primary/20 blur-2xl transition-opacity group-hover:opacity-100" />
              <span className="flex items-center gap-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary to-primary/60 shadow-md transition-transform group-hover:scale-105">
                  <Plus className="size-4 text-white" />
                </span>
                <span className="text-[13px] font-semibold tracking-tight">Create new project</span>
              </span>
              <span className="mt-2.5 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
                Blank timeline with your choice of canvas — {RATIOS.length} ratios, 24 / 30 / 60 fps.
                Autosaves locally as you edit.
              </span>
              <span className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-medium text-primary">
                Start creating <span aria-hidden>→</span>
              </span>
            </button>

            <button
              onClick={() => setSttOpen(true)}
              className="group relative overflow-hidden rounded-xl border border-border bg-panel p-4 text-left transition-all hover:-translate-y-0.5 hover:border-primary/40"
            >
              <div className="pointer-events-none absolute -right-8 -top-8 size-28 rounded-full bg-primary/10 blur-2xl transition-opacity group-hover:opacity-100" />
              <span className="flex items-center gap-2.5">
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-primary/80 to-primary/40 shadow-md transition-transform group-hover:scale-105">
                  <Mic className="size-4 text-white" />
                </span>
                <span className="text-[13px] font-semibold tracking-tight">Speech to Text</span>
              </span>
              <span className="mt-2.5 line-clamp-2 block text-[11px] leading-relaxed text-muted-foreground">
                Turn any audio or video into timestamped text with local Whisper base —
                2-second cues, SRT export, or straight into a new project as captions.
              </span>
              <span className="mt-3 inline-flex items-center gap-1.5 text-[11px] font-medium text-primary">
                Transcribe <span aria-hidden>→</span>
              </span>
            </button>
          </div>

          {/* web tools — compact link-only cards, opened in the external browser */}
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {WEB_TOOLS.map((t) => {
              const { Icon } = t;
              return (
                <button
                  key={t.id}
                  onClick={() => setToolPrompt(t)}
                  title={`Open ${t.name} — ${hostOf(t.urls[0])}`}
                  className="group flex items-center gap-2.5 rounded-lg border border-border bg-panel/70 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-panel"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-md bg-secondary">
                    <Icon className="size-3.5 text-muted-foreground transition-colors group-hover:text-foreground" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-semibold tracking-tight">
                      {t.name}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {t.blurb}
                    </span>
                  </span>
                  <ExternalLink className="size-3 shrink-0 text-muted-foreground group-hover:text-primary" />
                </button>
              );
            })}
          </div>

          {/* recents header */}
          <div className="mt-6 flex items-center gap-3">
            <h2 className="text-sm font-semibold tracking-tight">Recent projects</h2>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {recents.length}
            </span>
          </div>

          {/* recents grid */}
          {recents.length === 0 ? (
            <div className="mt-3 grid place-items-center rounded-xl border border-dashed border-border bg-panel/50 px-6 py-10 text-center">
              <span className="grid size-12 place-items-center rounded-2xl bg-secondary">
                <Film className="size-5 text-muted-foreground" />
              </span>
              <p className="mt-4 text-sm font-medium">No projects yet</p>
              <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Create your first project above — it autosaves while you edit and will appear
                here with its canvas, length and last-edited time.
              </p>
              <Button size="sm" className="mt-5" onClick={() => setCreateOpen(true)}>
                <Plus className="size-3.5" /> New project
              </Button>
            </div>
          ) : (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {recents.map((r) => {
                const meta = metas.get(r.id);
                return (
                  <article
                    key={r.id}
                    className="group overflow-hidden rounded-xl border border-border bg-panel transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg"
                  >
                    <button
                      onClick={() => void openRecent(r)}
                      className="block w-full text-left"
                      title={`Open ${r.name}`}
                    >
                      <div className="relative aspect-video overflow-hidden bg-rail">
                        {meta?.thumb ? (
                          <img src={meta.thumb} alt="" className="size-full object-cover transition-transform duration-300 group-hover:scale-105" />
                        ) : (
                          <div className="grid size-full place-items-center bg-gradient-to-br from-rail via-panel to-panel-raised">
                            <Film className="size-7 text-muted-foreground/60" />
                          </div>
                        )}
                        <div className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition-all group-hover:bg-black/35 group-hover:opacity-100">
                          <span className="rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-black shadow">
                            Open
                          </span>
                        </div>
                        {meta?.ratio && (
                          <span className="absolute left-2 top-2 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                            {meta.ratio}
                          </span>
                        )}
                      </div>
                      <div className="p-3">
                        <p className="truncate text-[13px] font-semibold tracking-tight" title={r.name}>
                          {r.name}
                        </p>
                        <p className="mt-1.5 text-[11px] text-muted-foreground">
                          {timeAgo(r.savedAt)}
                          {meta?.clipCount ? ` · ${meta.clipCount} clip${meta.clipCount === 1 ? "" : "s"}` : ""}
                          {meta && meta.duration > 0 ? ` · ${formatDuration(meta.duration)}` : ""}
                        </p>
                      </div>
                    </button>
                    <div className="flex items-center justify-end border-t border-border px-2 py-1.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        className="ml-auto grid size-7 place-items-center rounded text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
                        onClick={() => void removeRecent(r)}
                        title="Delete project"
                        aria-label={`Delete ${r.name}`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          <p className="mt-8 text-center text-[11px] text-muted-foreground">
            Projects autosave to this PC and reference your original media files — nothing is
            uploaded, and deleting a project here removes only its timeline data.
          </p>
        </div>
      </div>

      {/* new-project dialog */}
      {createOpen && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) closeCreate();
          }}
        >
          <div className="animate-in pop-in w-full max-w-[540px] rounded-2xl border border-border bg-panel-raised p-6 shadow-2xl">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary/60">
                <Plus className="size-5 text-white" />
              </span>
              <div>
                <h3 className="text-base font-semibold tracking-tight">New project</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Pick a canvas — you can still change it later in the editor.
                </p>
              </div>
              <button
                onClick={closeCreate}
                aria-label="Close project dialog"
                className="ml-auto grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-rail hover:text-foreground"
                title="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            <label className="mt-5 block text-[11px] font-medium text-muted-foreground">
              Project name
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") createProject();
                  if (e.key === "Escape") closeCreate();
                }}
                placeholder="Untitled project"
                maxLength={80}
                className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
              />
            </label>

            <p className="mb-2 mt-5 text-[11px] font-medium text-muted-foreground" id="ratio-label">
              Aspect ratio
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-labelledby="ratio-label">
              {RATIOS.map((r) => (
                <button
                  key={r}
                  onClick={() => setRatio(r)}
                  aria-pressed={ratio === r}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border p-2 text-left transition-colors",
                    ratio === r
                      ? "border-primary/70 bg-primary/10"
                      : "border-border bg-background hover:border-primary/40",
                  )}
                >
                  <RatioGlyph ratio={r} />
                  <span>
                    <span className="block text-xs font-semibold">{r}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {RATIO_SIZE[r].width}×{RATIO_SIZE[r].height}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <p className="mb-2 mt-5 text-[11px] font-medium text-muted-foreground" id="fps-label">
              Frame rate
            </p>
            <div className="flex gap-2" role="group" aria-labelledby="fps-label">
              {FPS_OPTIONS.map((f) => (
                <button
                  key={f}
                  onClick={() => setFps(f)}
                  aria-pressed={fps === f}
                  className={cn(
                    "h-8 flex-1 rounded-md border text-xs font-semibold transition-colors",
                    fps === f
                      ? "border-primary/70 bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  {f} fps
                </button>
              ))}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={closeCreate}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-gradient-to-r from-primary to-primary/70 font-medium"
                onClick={createProject}
              >
                <Plus className="size-3.5" /> Create project
              </Button>
            </div>
          </div>
        </div>
      )}

      {pendingTranscript && createOpen && (
        <div className="fixed inset-x-0 bottom-5 z-[60] mx-auto w-fit max-w-[calc(100vw-2rem)]">
          <div className="animate-in pop-in flex items-center gap-2 rounded-full border border-primary/40 bg-panel-raised py-2 pl-4 pr-2 shadow-2xl">
            <Mic className="size-3.5 shrink-0 text-primary" />
            <span className="max-w-80 truncate text-xs">
              <span className="font-semibold">{pendingTranscript.segments.length} transcript lines</span>
              <span className="text-muted-foreground">
                {pendingTranscript.sourceName ? ` · ${pendingTranscript.sourceName}` : ""} — becomes
                captions on create
              </span>
            </span>
            <button
              onClick={() => setPendingTranscript(null)}
              className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-rail hover:text-foreground"
              title="Remove transcript"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* open-tool confirm — links leave the app, so ask first */}
      {toolPrompt && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setToolPrompt(null);
          }}
        >
          <div className="animate-in pop-in w-full max-w-[420px] rounded-2xl border border-border bg-panel-raised p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-secondary">
                <toolPrompt.Icon className="size-4.5 text-foreground" />
              </span>
              <div className="min-w-0">
                <h3 className="text-sm font-semibold tracking-tight">
                  Open {toolPrompt.name}?
                </h3>
                <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                  This opens{" "}
                  <span className="font-medium text-foreground">
                    {hostOf(toolPrompt.urls[0])}
                  </span>{" "}
                  in your default browser. Nothing is installed and your project is untouched.
                </p>
              </div>
              <button
                onClick={() => setToolPrompt(null)}
                aria-label="Cancel opening link"
                className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-rail hover:text-foreground"
                title="Close"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* Multiple URLs for one tool — let the user pick which to open. */}
            {toolPrompt.urls.length > 1 ? (
              <div className="mt-4 space-y-2">
                {toolPrompt.urls.map((u, i) => (
                  <button
                    key={u}
                    onClick={() => void openTool(u)}
                    className="flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-left transition-colors hover:border-primary/50 hover:bg-panel"
                  >
                    <span className="grid size-6 shrink-0 place-items-center rounded-md bg-secondary text-[11px] font-semibold text-muted-foreground">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium">
                        Option {i + 1}
                      </span>
                      <span className="block truncate text-[10px] text-muted-foreground" title={u}>
                        {endpointOf(u)}
                      </span>
                    </span>
                    <ExternalLink className="size-3 shrink-0 text-muted-foreground" />
                  </button>
                ))}
              </div>
            ) : null}

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setToolPrompt(null)}>
                Cancel
              </Button>
              {toolPrompt.urls.length === 1 && (
                <Button
                  size="sm"
                  className="bg-gradient-to-r from-primary to-primary/70 font-medium"
                  onClick={() => void openTool(toolPrompt.urls[0])}
                >
                  <ExternalLink className="size-3.5" /> Open in browser
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      <SpeechToTextDialog
        open={sttOpen}
        onClose={() => setSttOpen(false)}
        onUseInProject={useTranscriptInProject}
      />
    </div>
  );
}
