import { useCallback, useMemo, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  Lock,
  Magnet,
  Plus,
  Unlock,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEditor, makeClip } from "@/lib/editor/store";
import { baseName, formatTime } from "@/lib/editor/media";
import { clipEnd, projectDuration } from "@/lib/editor/render";
import { overlayKey } from "@/lib/editor/store";
import { BUILTIN_OVERLAYS } from "@/lib/editor/styles";
import type { Clip, Track, TrackKind } from "@/lib/editor/types";

const HEADER_W = 148;
const ROW_H = 56;
const SNAP_PX = 8;
const TRIM_MIN = 0.1;

type DragMode = "move" | "trim-start" | "trim-end" | null;

interface DragState {
  mode: DragMode;
  clipId: string;
  startX: number;
  startY: number;
  originStart: number;
  originDuration: number;
  originOffset: number;
  originTrack: string;
}

const clipColor: Record<TrackKind, string> = {
  video: "bg-clip-video",
  audio: "bg-clip-audio",
  text: "bg-clip-text",
  overlay: "bg-clip-overlay",
};

function overlayLabel(clip: Clip): string {
  if (clip.overlay?.type === "builtin") {
    const kind = (clip.overlay as { kind: string }).kind;
    return BUILTIN_OVERLAYS.find((o) => o.id === kind)?.label ?? kind;
  }
  return clip.name;
}

export function Timeline() {
  const { state, update, updateClip, moveClip, select, setPlayhead, addTrack, addClips } = useEditor();
  const scrollRef = useRef<HTMLDivElement>(null);
  const laneRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubbing = useRef(false);
  const [snapLine, setSnapLine] = useState<number | null>(null);
  const [dropHint, setDropHint] = useState<{ time: number; trackId: string } | null>(null);

  const zoom = state.zoom;
  const total = Math.max(projectDuration(state.clips), 10);
  const contentWidth = (total + 8) * zoom;

  const timeFromClientX = useCallback(
    (clientX: number) => {
      const lane = laneRef.current;
      if (!lane) return 0;
      const rect = lane.getBoundingClientRect();
      return Math.max(0, (clientX - rect.left) / zoom);
    },
    [zoom],
  );

  const snapPoints = useMemo(() => {
    const pts = new Set<number>([0, state.playhead]);
    for (const c of state.clips) {
      pts.add(c.start);
      pts.add(clipEnd(c));
    }
    return [...pts];
  }, [state.clips, state.playhead]);

  /**
   * Snap a time to the nearest edge or the playhead, within SNAP_PX.
   * Returns the snapped value plus the guide line to draw.
   */
  const applySnap = useCallback(
    (time: number, ignoreId?: string) => {
      if (!state.snap) return { time, guide: null as number | null };
      const tol = SNAP_PX / zoom;
      let best: number | null = null;
      let bestDist = tol;
      const pts = [
        0,
        state.playhead,
        ...state.clips.filter((c) => c.id !== ignoreId).flatMap((c) => [c.start, clipEnd(c)]),
      ];
      for (const p of pts) {
        const d = Math.abs(p - time);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
      return best === null ? { time, guide: null } : { time: best, guide: best };
    },
    [state.snap, state.clips, state.playhead, zoom],
  );

  /* ------------------------------- scrubbing ------------------------------- */

  const onRulerDown = (e: React.PointerEvent) => {
    scrubbing.current = true;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setPlayhead(timeFromClientX(e.clientX));
  };
  const onRulerMove = (e: React.PointerEvent) => {
    if (scrubbing.current) setPlayhead(timeFromClientX(e.clientX));
  };
  const onRulerUp = (e: React.PointerEvent) => {
    scrubbing.current = false;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
  };

  /* --------------------------------- drag --------------------------------- */

  const beginDrag = (e: React.PointerEvent, clip: Clip, mode: DragMode) => {
    if (state.tracks.find((t) => t.id === clip.trackId)?.locked) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = {
      mode,
      clipId: clip.id,
      startX: e.clientX,
      startY: e.clientY,
      originStart: clip.start,
      originDuration: clip.duration,
      originOffset: clip.offset,
      originTrack: clip.trackId,
    };
    if (!state.selectedClipIds.includes(clip.id)) select([clip.id]);
  };

  const onLaneMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / zoom;
    const clip = state.clips.find((c) => c.id === d.clipId);
    if (!clip) return;

    if (d.mode === "move") {
      // Snap either edge, whichever is closer to a snap point.
      const raw = Math.max(0, d.originStart + dx);
      const snappedStart = applySnap(raw, clip.id);
      const snappedEnd = applySnap(raw + d.originDuration, clip.id);
      let newStart = raw;
      let guide: number | null = null;
      if (snappedStart.guide !== null) {
        newStart = snappedStart.time;
        guide = snappedStart.guide;
      } else if (snappedEnd.guide !== null) {
        newStart = snappedEnd.time - d.originDuration;
        guide = snappedEnd.guide;
      }
      setSnapLine(guide);

      // Vertical track change, restricted to tracks of the same kind.
      const rows = state.tracks;
      const rowIdx = Math.max(0, rows.findIndex((t) => t.id === d.originTrack));
      const delta = Math.round((e.clientY - d.startY) / ROW_H);
      const target = rows[Math.min(rows.length - 1, Math.max(0, rowIdx + delta))];
      const trackId = target && target.kind === clip.kind && !target.locked ? target.id : clip.trackId;

      moveClip(clip.id, newStart, trackId);
    } else if (d.mode === "trim-start") {
      const raw = Math.max(0, d.originStart + dx);
      const { time, guide } = applySnap(raw, clip.id);
      setSnapLine(guide);
      const maxStart = d.originStart + d.originDuration - TRIM_MIN;
      const start = Math.min(time, maxStart);
      const delta = start - d.originStart;
      updateClip(clip.id, {
        start,
        duration: d.originDuration - delta,
        offset: Math.max(0, d.originOffset + delta * clip.speed),
      });
    } else if (d.mode === "trim-end") {
      const raw = d.originStart + d.originDuration + dx;
      const { time, guide } = applySnap(raw, clip.id);
      setSnapLine(guide);
      updateClip(clip.id, { duration: Math.max(TRIM_MIN, time - d.originStart) });
    }
  };

  const endDrag = () => {
    dragRef.current = null;
    setSnapLine(null);
  };

  /* --------------------------- drop from library --------------------------- */

  const onDragOver = (e: React.DragEvent, track: Track) => {
    if (!e.dataTransfer.types.includes("text/asset-id")) return;
    e.preventDefault();
    const time = Math.max(0, timeFromClientX(e.clientX));
    setDropHint({ time: applySnap(time).time, trackId: track.id });
  };

  const onDrop = (e: React.DragEvent, track: Track) => {
    const assetId = e.dataTransfer.getData("text/asset-id");
    if (!assetId) return;
    e.preventDefault();
    setDropHint(null);
    if (track.locked) return;
    const asset = state.assets.find((a) => a.id === assetId);
    if (!asset) return;
    const kind: TrackKind =
      asset.kind === "audio" ? "audio" : asset.kind === "overlay" ? "overlay" : "video";
    if (track.kind !== kind) return;
    const time = applySnap(Math.max(0, timeFromClientX(e.clientX))).time;
    addClips([
      makeClip({
        trackId: track.id,
        kind,
        name: asset.name,
        assetId: asset.id,
        start: time,
        duration: asset.duration,
      }),
    ]);
  };

  const rows = state.tracks;
  const overlayIdentities = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of state.clips) if (c.kind === "overlay" && c.overlay) m.set(c.id, overlayKey(c.overlay));
    return m;
  }, [state.clips]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      {/* toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Timeline
        </span>
        <div className="ml-2 flex items-center gap-1">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => update((s) => ({ ...s, zoom: Math.max(10, s.zoom / 1.4) }), false)}
            title="Zoom out"
          >
            <ZoomOut className="size-3.5" />
          </Button>
          <input
            type="range"
            min={10}
            max={400}
            step={1}
            value={zoom}
            onChange={(e) => update((s) => ({ ...s, zoom: Number(e.target.value) }), false)}
            className="h-1 w-28 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => update((s) => ({ ...s, zoom: Math.min(400, s.zoom * 1.4) }), false)}
            title="Zoom in"
          >
            <ZoomIn className="size-3.5" />
          </Button>
        </div>
        <Button
          size="sm"
          variant={state.snap ? "default" : "ghost"}
          className="h-7"
          onClick={() => update((s) => ({ ...s, snap: !s.snap }), false)}
          title="Magnetic snapping"
        >
          <Magnet className="size-3.5" /> Snap
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {snapPoints.length > 1 && (
            <span className="mr-1 hidden text-[10px] text-muted-foreground lg:inline">
              {state.clips.length} clips
            </span>
          )}
          <Button size="sm" variant="ghost" className="h-7" onClick={() => addTrack("video")}>
            <Plus className="size-3.5" /> Video
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => addTrack("audio")}>
            <Plus className="size-3.5" /> Audio
          </Button>
          <Button size="sm" variant="ghost" className="h-7" onClick={() => addTrack("overlay")}>
            <Plus className="size-3.5" /> Overlay
          </Button>
        </div>
      </div>

      {/* scroll area */}
      <div
        ref={scrollRef}
        className="relative min-h-0 flex-1 overflow-auto"
        onWheel={(e) => {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            update(
              (s) => ({ ...s, zoom: Math.min(400, Math.max(10, s.zoom * (e.deltaY > 0 ? 0.9 : 1.1))) }),
              false,
            );
          }
        }}
      >
        <div className="relative" style={{ width: HEADER_W + contentWidth }}>
          {/* ruler */}
          <div className="sticky top-0 z-20 flex bg-rail">
            <div className="shrink-0 border-r border-border bg-rail" style={{ width: HEADER_W }} />
            <div
              className="relative h-7 cursor-ew-resize select-none"
              style={{ width: contentWidth }}
              onPointerDown={onRulerDown}
              onPointerMove={onRulerMove}
              onPointerUp={onRulerUp}
              onPointerCancel={onRulerUp}
            >
              <Ruler zoom={zoom} width={contentWidth} />
            </div>
          </div>

          {/* tracks */}
          <div
            className="relative"
            ref={laneRef}
            style={{ marginLeft: HEADER_W }}
            onPointerMove={onLaneMove}
            onPointerUp={endDrag}
            onPointerLeave={endDrag}
            onPointerCancel={endDrag}
          >
            {rows.map((track) => (
              <div
                key={track.id}
                className={cn(
                  "relative border-b border-border bg-track",
                  track.locked && "opacity-70",
                )}
                style={{ height: ROW_H }}
                onDragOver={(e) => onDragOver(e, track)}
                onDragLeave={() => setDropHint(null)}
                onDrop={(e) => onDrop(e, track)}
                onPointerDown={() => select([])}
              >
                {/* track header */}
                <div
                  className="absolute top-0 z-10 flex h-full items-center gap-1 border-r border-border bg-panel-raised px-2"
                  style={{ width: HEADER_W, left: -HEADER_W }}
                >
                  <span className={cn("size-2 shrink-0 rounded-full", clipColor[track.kind])} />
                  <span className="truncate text-[11px] font-medium" title={track.name}>
                    {track.name}
                  </span>
                  <div className="ml-auto flex shrink-0">
                    {track.kind === "audio" ? (
                      <button
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        title={track.muted ? "Unmute" : "Mute"}
                        onClick={() =>
                          update((s) => ({
                            ...s,
                            tracks: s.tracks.map((t) =>
                              t.id === track.id ? { ...t, muted: !t.muted } : t,
                            ),
                          }))
                        }
                      >
                        {track.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
                      </button>
                    ) : (
                      <button
                        className="rounded p-1 text-muted-foreground hover:text-foreground"
                        title={track.hidden ? "Show track" : "Hide track"}
                        onClick={() =>
                          update((s) => ({
                            ...s,
                            tracks: s.tracks.map((t) =>
                              t.id === track.id ? { ...t, hidden: !t.hidden } : t,
                            ),
                          }))
                        }
                      >
                        {track.hidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                      </button>
                    )}
                    <button
                      className="rounded p-1 text-muted-foreground hover:text-foreground"
                      title={track.locked ? "Unlock track" : "Lock track"}
                      onClick={() =>
                        update((s) => ({
                          ...s,
                          tracks: s.tracks.map((t) =>
                            t.id === track.id ? { ...t, locked: !t.locked } : t,
                          ),
                        }))
                      }
                    >
                      {track.locked ? <Lock className="size-3.5" /> : <Unlock className="size-3.5" />}
                    </button>
                  </div>
                </div>

                {/* clips */}
                {state.clips
                  .filter((c) => c.trackId === track.id)
                  .map((clip) => {
                    const selected = state.selectedClipIds.includes(clip.id);
                    const width = Math.max(6, clip.duration * zoom);
                    const label =
                      clip.kind === "text"
                        ? clip.text || "Text"
                        : clip.kind === "overlay"
                          ? overlayLabel(clip)
                          : baseName(clip.name);
                    const sub =
                      clip.kind === "text"
                        ? clip.styleId
                        : clip.kind === "overlay"
                          ? `${clip.blend}${overlayIdentities.has(clip.id) ? "" : ""}`
                          : clip.assetId
                            ? baseName(
                                state.assets.find((a) => a.id === clip.assetId)?.path ?? clip.name,
                              )
                            : "";
                    return (
                      <div
                        key={clip.id}
                        className={cn(
                          "group absolute top-1 flex h-[calc(100%-8px)] cursor-grab items-stretch overflow-hidden rounded-md text-[11px] ring-1 ring-black/30 active:cursor-grabbing",
                          clipColor[clip.kind],
                          selected && "outline outline-2 outline-primary",
                        )}
                        style={{ left: clip.start * zoom, width }}
                        onPointerDown={(e) => beginDrag(e, clip, "move")}
                        onPointerMove={onLaneMove}
                        onPointerUp={endDrag}
                        onClick={(e) => {
                          e.stopPropagation();
                          select(e.shiftKey ? [...state.selectedClipIds, clip.id] : [clip.id]);
                        }}
                        title={`${label} · ${formatTime(clip.start)} → ${formatTime(clipEnd(clip))}`}
                      >
                        <div
                          className="absolute left-0 top-0 z-10 h-full w-2 cursor-w-resize bg-black/30 opacity-0 transition-opacity group-hover:opacity-100"
                          onPointerDown={(e) => beginDrag(e, clip, "trim-start")}
                        />
                        <div className="pointer-events-none flex w-full min-w-0 items-center gap-1.5 px-2">
                          <div className="min-w-0 flex-1">
                            <p className="truncate font-medium text-white/95">{label}</p>
                            {sub && width > 90 && (
                              <p className="truncate font-mono text-[9px] text-white/60">{sub}</p>
                            )}
                          </div>
                          {width > 46 && (
                            <span className="shrink-0 font-mono text-white/70">
                              {clip.duration.toFixed(1)}s
                            </span>
                          )}
                        </div>
                        <div
                          className="absolute right-0 top-0 z-10 h-full w-2 cursor-e-resize bg-black/30 opacity-0 transition-opacity group-hover:opacity-100"
                          onPointerDown={(e) => beginDrag(e, clip, "trim-end")}
                        />
                      </div>
                    );
                  })}

                {/* drop indicator */}
                {dropHint?.trackId === track.id && (
                  <div
                    className="pointer-events-none absolute top-0 z-30 h-full w-0.5 bg-primary"
                    style={{ left: dropHint.time * zoom }}
                  >
                    <div className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-primary" />
                    <div className="absolute left-2 top-1 rounded bg-primary px-1 font-mono text-[10px] text-primary-foreground">
                      {formatTime(dropHint.time)}
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* snap guide */}
            {snapLine !== null && (
              <div
                className="pointer-events-none absolute top-0 z-30 h-full w-px bg-snap"
                style={{ left: snapLine * zoom }}
              />
            )}

            {/* playhead */}
            <div
              className="pointer-events-none absolute top-0 z-30 h-full w-px bg-playhead"
              style={{ left: state.playhead * zoom }}
            />
          </div>
        </div>

        {/* playhead head in ruler */}
        <div
          className="pointer-events-none absolute top-0 z-40"
          style={{ left: HEADER_W + state.playhead * zoom }}
        >
          <div className="-ml-1.5 size-3 rotate-45 bg-playhead" />
        </div>
      </div>
    </div>
  );
}

function Ruler({ zoom, width }: { zoom: number; width: number }) {
  const step = zoom > 200 ? 0.5 : zoom > 90 ? 1 : zoom > 40 ? 2 : zoom > 20 ? 5 : 10;
  const marks: number[] = [];
  for (let t = 0; t * zoom < width; t += step) marks.push(t);
  return (
    <div className="relative h-full w-full border-b border-border">
      {marks.map((t) => (
        <div key={t} className="absolute top-0 h-full" style={{ left: t * zoom }}>
          <div className="h-1.5 w-px bg-border" />
          <span className="absolute left-1 top-0.5 font-mono text-[10px] text-muted-foreground">
            {formatTime(t, false)}
          </span>
        </div>
      ))}
    </div>
  );
}
