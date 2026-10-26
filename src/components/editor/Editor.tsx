import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  FileText,
  Film,
  Layers,
  Minus,
  Plus,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Type,
  Upload,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEditor } from "@/lib/editor/store";
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

export function Editor({
  projectId,
  projectName,
  onHome,
  onProjectChange,
}: {
  projectId: string;
  projectName: string;
  onHome: () => void;
  onProjectChange: (info: { id: string; name: string }) => void;
}) {
  const { state, setAspectRatio } = useEditor();
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

  // ---- Autosave (Recent Projects) ----
  // Every edit lands on disk ~1.5s after it stops changing, and beforeunload
  // flushes immediately so closing the window (or a crash) loses at most the
  // last second and a half. Media is referenced by path, so a save is a few KB.
  const stateRef = useRef(state);
  stateRef.current = state;
  const projectNameRef = useRef(projectName);
  projectNameRef.current = projectName;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedJson = useRef<string>("");

  const saveNow = useCallback(() => {
    const s = stateRef.current;
    const file = {
      version: 1,
      settings: s.settings,
      tracks: s.tracks,
      clips: s.clips,
      assets: s.assets.map((a) => ({
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
    window.zf?.projects
      ?.save(projectId, projectNameRef.current.trim() || "Untitled project", file)
      .catch((err: unknown) =>
        console.warn("[autosave] failed", err instanceof Error ? err.message : err),
      );
  }, [projectId]);

  // Serialized project content, recomputed only when a saved field actually
  // changes. Deliberately excludes playhead/playing/zoom/snap/selection, so
  // scrubbing or playback never re-runs this or resets the debounce timer.
  const projectJson = useMemo(() => {
    const s = stateRef.current;
    return JSON.stringify({
      version: 1,
      settings: s.settings,
      tracks: s.tracks,
      clips: s.clips,
      assets: s.assets.map((a) => ({
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
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reads the latest state via ref by design
  }, [state.settings, state.tracks, state.clips, state.assets]);

  // Debounced autosave: re-arms only when saved content changed; playback and
  // selection churn never reach here.
  useEffect(() => {
    if (!projectId) return;
    if (projectJson === lastSavedJson.current) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      lastSavedJson.current = projectJson;
      saveNow();
    }, 1500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [projectJson, projectId, saveNow]);

  // Crash/close flush: window teardown does not wait for the debounce.
  useEffect(() => {
    const flush = () => {
      if (!projectId) return;
      saveNow();
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [projectId, saveNow]);

  // Starting a new project from the editor keeps this one in recents — it is
  // already autosaved, so no confirmation is needed.
  const startNewProject = () => onHome();

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />

      {/* toolbar */}
      <header className="flex flex-wrap items-center gap-3 border-b border-border bg-panel px-3 py-1.5">
        <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={startNewProject} title="Start a new project">
          <Plus className="size-3.5" /> <span className="hidden sm:inline">New project</span>
        </Button>
        <div className="min-w-0 max-w-56">
          <input
            value={projectName}
            onChange={(e) => onProjectChange({ id: projectId, name: e.target.value })}
            aria-label="Project name"
            maxLength={80}
            className="w-full truncate rounded border border-transparent bg-transparent px-1 text-xs font-semibold tracking-tight outline-none hover:border-border focus:border-primary/60"
            placeholder="Untitled project"
          />
          <p className="truncate px-1 text-[10px] text-muted-foreground">
            Autosaves locally · recoverable after a crash
          </p>
        </div>
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
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* min-h-0 + overflow-y-auto: when the timeline is expanded the preview
            row can end up shorter than the six tabs, so the rail scrolls (the
            thin 9px scrollbar in styles.css keeps it unobtrusive) instead of
            clipping the lowest entries — Edit, Motion, Sync. Buttons are
            shrink-0 and slightly tighter so the rail still fits without
            scrolling at normal window sizes. */}
        <nav className="flex min-h-0 w-[4.5rem] shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-border bg-panel py-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              title={t.label}
              className={cn(
                "flex w-14 shrink-0 flex-col items-center gap-1 rounded-md px-0.5 py-1.5 text-[10px] transition-colors",
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
