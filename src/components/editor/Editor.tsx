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
import { beginAxisResize, ResizeHandle, useStoredSize } from "@/lib/editor/resize";
import { ImportPanel } from "./ImportPanel";
import { TextPanel } from "./TextPanel";
import { EffectsPanel } from "./EffectsPanel";
import { SyncPanel } from "./SyncPanel";
import { OverlayPanel } from "./OverlayPanel";
import { ClipInspector } from "./ClipInspector";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { ExportDialog } from "./ExportDialog";
import { SettingsDialog } from "./SettingsDialog";
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
const TIMELINE_MIN = 120;
const TIMELINE_DEFAULT = 260;

/**
 * The timeline is pinned to the bottom of the window, so its divider has
 * nowhere to travel downward. The ceiling is a share of the viewport, leaving
 * the preview at least a usable strip.
 */
const timelineMax = () => Math.max(TIMELINE_MIN, Math.round(window.innerHeight * 0.62));

/** Side panel width limits, in CSS pixels. */
const PANEL_MIN = 232;
const PANEL_MAX = 560;
const PANEL_DEFAULT = 272;

const clampTimeline = (h: number) =>
  Math.max(TIMELINE_MIN, Math.min(timelineMax(), Math.round(h)));

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

export function Editor() {
  const { state, setAspectRatio, loadProject } = useEditor();
  const [tab, setTab] = useState<TabId>("import");
  const [timelineHeight, setTimelineHeightRaw] = useStoredSize(
    "zf.timelineHeight",
    TIMELINE_DEFAULT,
    TIMELINE_MIN,
    100000,
  );
  const [panelWidth, setPanelWidth] = useStoredSize(
    "zf.panelWidth",
    PANEL_DEFAULT,
    PANEL_MIN,
    PANEL_MAX,
  );
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const setTimelineHeight = useCallback(
    (h: number) => setTimelineHeightRaw(clampTimeline(h)),
    [setTimelineHeightRaw],
  );

  // A window resize can push either panel past its ceiling; pull them back so
  // the preview is never squeezed out of existence.
  useEffect(() => {
    const onResize = () => {
      setTimelineHeight(timelineHeight);
      setPanelWidth(panelWidth);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [timelineHeight, panelWidth, setTimelineHeight, setPanelWidth]);

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
        thumb: a.thumb,
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
          className="h-7 gap-1.5 bg-gradient-to-r from-primary to-primary/80 font-medium text-primary-foreground shadow-sm hover:opacity-90"
        >
          <Download className="size-3.5" />
          Export
        </Button>

        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            aria-label="Settings"
          >
            <Settings2 className="size-3.5" />
          </Button>
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

        <aside
          className="shrink-0 overflow-hidden border-r border-border bg-panel p-3"
          style={{ width: panelWidth }}
        >
          {tab === "import" && <ImportPanel />}
          {tab === "overlay" && <OverlayPanel />}
          {tab === "text" && <TextPanel />}
          {tab === "sync" && <SyncPanel />}
          {tab === "effects" && <EffectsPanel />}
          {tab === "properties" && <ClipInspector />}
        </aside>

        <ResizeHandle
          axis="x"
          label="Resize side panel"
          onResizeStart={(e) =>
            beginAxisResize(e, {
              axis: "x",
              start: panelWidth,
              origin: e.clientX,
              sign: 1,
              min: PANEL_MIN,
              max: PANEL_MAX,
              onChange: setPanelWidth,
            })
          }
          onReset={() => setPanelWidth(PANEL_DEFAULT)}
        />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Preview />
        </main>
      </div>

      {/* Draggable divider. The timeline is docked to the bottom of the window,
          so the divider can only travel upward — dragging up grows the timeline.
          sign=-1 makes the panel fill the space the divider vacates. Dragging
          past the viewport edge still works, because the gesture is tracked on
          window rather than the handle. */}
      <ResizeHandle
        axis="y"
        label="Resize timeline"
        onResizeStart={(e) =>
          beginAxisResize(e, {
            axis: "y",
            start: timelineHeight,
            origin: e.clientY,
            sign: -1,
            min: TIMELINE_MIN,
            max: timelineMax(),
            onChange: setTimelineHeight,
          })
        }
        onReset={() => setTimelineHeight(TIMELINE_DEFAULT)}
      />

      <div className="shrink-0" style={{ height: timelineHeight }}>
        <Timeline
          height={timelineHeight}
          onHeightChange={setTimelineHeight}
          maxHeight={timelineMax()}
          defaultHeight={TIMELINE_DEFAULT}
        />
      </div>

      <ExportDialog
        isOpen={exportOpen}
        onClose={() => setExportOpen(false)}
        state={state}
      />

      <SettingsDialog isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}

export { TABS };
export type { TabId };
