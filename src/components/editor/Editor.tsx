import { useCallback, useEffect, useState } from "react";
import {
  Download,
  FileText,
  Film,
  FolderOpen,
  Layers,
  Minus,
  Save,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Type,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { useEditor } from "@/lib/editor/store";
import { baseName, toFileUrl } from "@/lib/editor/media";
import { ImportPanel } from "./ImportPanel";
import { TextPanel } from "./TextPanel";
import { EffectsPanel } from "./EffectsPanel";
import { SyncPanel } from "./SyncPanel";
import { OverlayPanel } from "./OverlayPanel";
import { ClipInspector } from "./ClipInspector";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { ExportDialog } from "./ExportDialog";
import type { ProjectFile } from "@/lib/editor/types";

const TABS = [
  { id: "import", label: "Import", icon: Upload },
  { id: "overlay", label: "Overlays", icon: Layers },
  { id: "text", label: "Captions", icon: Type },
  { id: "sync", label: "Sync", icon: FileText },
  { id: "effects", label: "Motion", icon: Sparkles },
  { id: "properties", label: "Edit", icon: SlidersHorizontal },
] as const;

type TabId = (typeof TABS)[number]["id"];

const RATIOS = ["16:9", "9:16", "1:1", "4:5", "4:3", "3:4", "21:9"] as const;

/** Timeline height limits, in CSS pixels. */
const TIMELINE_MIN = 140;
const TIMELINE_MAX = 520;
const DEFAULT_TIMELINE = 260;

const clampTimeline = (h: number) =>
  Math.max(TIMELINE_MIN, Math.min(TIMELINE_MAX, Math.round(h)));

function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => window.zf?.window?.onMaximizeChange(setMaximized), []);

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel-raised px-3">
      <Film className="size-4 text-primary" />
      <span className="text-xs font-semibold tracking-tight">Zero Flow</span>
      <span className="hidden text-[11px] text-muted-foreground sm:inline">
        offline video editor
      </span>
      {window.zf?.window && (
        <div className="ml-auto flex items-center">
          <button
            className="grid h-9 w-11 place-items-center text-muted-foreground hover:bg-rail hover:text-foreground"
            onClick={() => void window.zf?.window?.minimize()}
            title="Minimize"
          >
            <Minus className="size-3.5" />
          </button>
          <button
            className="grid h-9 w-11 place-items-center text-muted-foreground hover:bg-rail hover:text-foreground"
            onClick={() => void window.zf?.window?.toggleMaximize()}
            title={maximized ? "Restore" : "Maximize"}
          >
            <Square className="size-3" />
          </button>
          <button
            className="grid h-9 w-11 place-items-center text-muted-foreground hover:bg-destructive/90 hover:text-white"
            onClick={() => void window.zf?.window?.close()}
            title="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

/** Warns when ffmpeg is missing — the app cannot export without it. */
function useFfmpegStatus() {
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  useEffect(() => {
    let alive = true;
    if (!window.zf?.ffmpeg) {
      setStatus({ ok: false, message: "FFmpeg bridge unavailable (desktop app required)" });
      return;
    }
    void window.zf.ffmpeg
      .findBinaries()
      .then((b) => {
        if (!alive) return;
        if (b.ffmpeg) setStatus({ ok: true, message: b.ffmpeg });
        else setStatus({ ok: false, message: "FFmpeg not found" });
      })
      .catch(() => alive && setStatus({ ok: false, message: "FFmpeg check failed" }));
    return () => {
      alive = false;
    };
  }, []);
  return status;
}

export function Editor() {
  const { state, setAspectRatio, loadProject } = useEditor();
  const [tab, setTab] = useState<TabId>("import");
  const [timelineHeight, setTimelineHeight] = useState(DEFAULT_TIMELINE);
  const [exportOpen, setExportOpen] = useState(false);
  const ffmpeg = useFfmpegStatus();

  const saveProject = useCallback(async () => {
    const file: ProjectFile = {
      version: 1,
      settings: state.settings,
      tracks: state.tracks,
      clips: state.clips,
      assets: state.assets.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        path: a.path,
        duration: a.duration,
        width: a.width,
        height: a.height,
        hasAudio: a.hasAudio,
      })),
    };
    const saved = await window.zf?.dialog?.saveProject(file);
    if (saved) toast.success(`Project saved to ${baseName(saved)}`);
  }, [state]);

  const openProject = useCallback(async () => {
    const data = (await window.zf?.dialog?.openProject()) as ProjectFile | null;
    if (!data) return;
    // Rebuild the renderer URLs from the stored absolute paths.
    const assets = (data.assets ?? []).map((a) => ({ ...a, url: toFileUrl(a.path) }));
    loadProject({
      settings: data.settings,
      tracks: data.tracks,
      clips: data.clips,
      assets,
    });
    toast.success("Project loaded");
  }, [loadProject]);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />

      {/* toolbar */}
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Ratio:</span>
          <select
            aria-label="Aspect ratio"
            value={state.settings.aspectRatio}
            onChange={(e) => setAspectRatio(e.target.value as (typeof RATIOS)[number])}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs font-medium hover:border-primary/50 transition-colors"
          >
            {RATIOS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        <Button
          size="sm"
          onClick={() => setExportOpen(true)}
          disabled={!ffmpeg?.ok}
          className="h-7 gap-1.5 bg-gradient-to-r from-primary to-primary/80 font-medium text-primary-foreground shadow-sm hover:opacity-90"
        >
          <Download className="size-3.5" />
          Export
        </Button>

        <div className="ml-auto flex items-center gap-1">
          <span
            className={cn(
              "flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px]",
              ffmpeg?.ok ? "text-muted-foreground" : "border-destructive/60 text-destructive",
            )}
            title={ffmpeg?.message ?? "Checking for FFmpeg…"}
          >
            <Settings2 className="size-3" />
            {ffmpeg ? (ffmpeg.ok ? "FFmpeg ready" : "FFmpeg missing") : "Checking FFmpeg…"}
          </span>
          <Button size="sm" variant="ghost" className="h-7" onClick={openProject} title="Open project">
            <FolderOpen className="size-3.5" /> Open
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={saveProject} title="Save project">
            <Save className="size-3.5" /> Save
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="flex w-[4.5rem] shrink-0 flex-col items-center gap-1 border-r border-border bg-panel py-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.label}
              className={cn(
                "flex w-14 flex-col items-center gap-1 rounded-md py-2 text-[10px] transition-colors",
                tab === t.id
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-rail hover:text-foreground",
              )}
            >
              <t.icon className="size-5" />
              {t.label}
            </button>
          ))}
        </nav>

        <aside className="w-[17rem] shrink-0 overflow-hidden border-r border-border bg-panel p-3 xl:w-[20rem]">
          {tab === "import" && <ImportPanel />}
          {tab === "overlay" && <OverlayPanel />}
          {tab === "text" && <TextPanel />}
          {tab === "sync" && <SyncPanel />}
          {tab === "effects" && <EffectsPanel />}
          {tab === "properties" && <ClipInspector />}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Preview />
        </main>
      </div>

      {/* Draggable divider: drag up to give the preview more room, down to give
          the timeline more room. The preview is flex-1 so it absorbs the rest. */}
      <div
        className="group relative h-1.5 shrink-0 cursor-row-resize border-y border-border bg-panel hover:bg-primary/30 active:bg-primary/50"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const startY = e.clientY;
          const startH = timelineHeight;
          const move = (ev: PointerEvent) =>
            setTimelineHeight(clampTimeline(startH + (ev.clientY - startY)));
          const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        }}
        onDoubleClick={() => setTimelineHeight(DEFAULT_TIMELINE)}
        title="Drag to resize the timeline (double-click to reset)"
      >
        <div className="absolute top-1/2 left-1/2 h-0.5 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border group-hover:bg-primary" />
      </div>

      <div className="shrink-0 border-b border-border" style={{ height: timelineHeight }}>
        <Timeline />
      </div>

      {!ffmpeg?.ok && ffmpeg && (
        <div className="border-t border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
          FFmpeg was not found on this PC, so export is disabled. Install FFmpeg and make sure it is on
          your PATH, then restart Zero Flow. You can still import, edit and preview.
        </div>
      )}

      <ExportDialog
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        state={state}
      />
    </div>
  );
}

export { TABS };
export type { TabId };
