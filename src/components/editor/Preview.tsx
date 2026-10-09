import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getAudio,
  getVideo,
  isAudioAsset,
  isVideoAsset,
} from "@/lib/editor/media";
import {
  activeClips,
  resolveClipAsset,
} from "@/lib/editor/render";
import {
  ChevronsLeftRight,
  Pause,
  Play,
  Scissors,
  SkipBack,
  SkipForward,
  Trash2,
  Undo2,
  Redo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/editor/store";
import { formatTime, onMediaLoaded } from "@/lib/editor/media";
import {
  buildRenderScene,
  projectDuration,
  renderFrame,
  syncVideoElements,
  syncAudioElements,
  type RenderScene,
} from "@/lib/editor/render";

/**
 * Fits the canvas inside its container at the project's aspect ratio.
 *
 * The old version styled the canvas with `height:100%; width:auto` plus an
 * aspect-ratio, which lets the browser overflow the box in one dimension when
 * the container is wider than the ratio needs — so switching to 9:16 pushed the
 * preview out of view. Measuring both axes and taking the smaller scale fixes
 * it and keeps the letterboxed area centred.
 */
function useFittedCanvas(
  containerRef: React.RefObject<HTMLDivElement | null>,
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  aspect: number,
) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const rect = container.getBoundingClientRect();
      if (!Number.isFinite(aspect) || aspect <= 0) return;
      // Provide comfortable breathing room around the preview monitor
      const padX = Math.max(24, Math.round(rect.width * 0.05));
      const padY = Math.max(24, Math.round(rect.height * 0.05));
      const availW = Math.max(1, rect.width - padX * 2);
      const availH = Math.max(1, rect.height - padY * 2);

      let width = availW;
      let height = width / aspect;
      if (height > availH) {
        height = availH;
        width = height * aspect;
      }
      setSize({
        width: Math.max(1, Math.floor(width)),
        height: Math.max(1, Math.floor(height)),
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [containerRef, aspect]);

  return size;
}

export function Preview() {
  const { state, setPlayhead, setPlaying, splitAt, removeClips, undo, redo } = useEditor();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  // Build the render lookup tables once per edit instead of on every frame.
  const scene = useMemo(
    () => buildRenderScene(state),
    [state.assets, state.tracks, state.clips, state.settings],
  );
  const sceneRef = useRef<RenderScene>(scene);
  sceneRef.current = scene;
  const rafRef = useRef<number>(0);
  const anchorRef = useRef<{ wall: number; time: number } | null>(null);
  /** Throttle playhead state so the whole editor doesn't re-render at 60fps. */
  const lastUiSyncRef = useRef(0);
  /** Debounce timer for audio scrub bursts while dragging the playhead. */
  const scrubAudioTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSafeArea, setShowSafeArea] = useState(false);

  const total = projectDuration(state.clips);
  const aspect = state.settings.width / Math.max(1, state.settings.height);
  const { width, height } = useFittedCanvas(containerRef, canvasRef, aspect);

  const syncAudio = useCallback((time: number, playing: boolean) => {
    syncAudioElements(sceneRef.current, time, playing);
  }, []);

  const draw = useCallback((time: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = sceneRef.current;
    // Keep the backing store at the project resolution; CSS scales it to fit.
    if (canvas.width !== s.settings.width || canvas.height !== s.settings.height) {
      canvas.width = s.settings.width;
      canvas.height = s.settings.height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    renderFrame(ctx, s, time);
  }, []);

  // Resize the backing store as soon as the project size changes, even if no
  // redraw is otherwise scheduled (e.g. switching ratio with an empty timeline),
  // so the preview keeps the right framing.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.width !== state.settings.width || canvas.height !== state.settings.height) {
      canvas.width = state.settings.width;
      canvas.height = state.settings.height;
    }
  }, [state.settings.width, state.settings.height]);

  // Scrubbing (paused, playhead changed) must show the correct frame and play
  // a short audio burst, like Premiere Pro.
  //
  // Two problems with the old approach (sync → rAF → draw):
  //   1. Video seeking is asynchronous, so the next rAF painted the OLD frame.
  //   2. syncAudio(…, false) paused everything, so scrubbing was silent.
  // Now we wait for `seeked` on any video element before drawing, and we let
  // audio elements play a brief burst when the playhead lands on them.
  useEffect(() => {
    if (state.playing) return;
    const s = sceneRef.current;
    const time = state.playhead;
    syncVideoElements(s, time, false);
    syncAudio(time, false);

    // Ask every active video element to seek, then draw once they've all fired
    // `seeked`. A video still decoding (readyState < 2) can't seek yet, so
    // it's excluded and will be drawn via the media-loaded redraw instead.
    const seeking: HTMLVideoElement[] = [];
    for (const clip of activeClips(s, time)) {
      const asset = resolveClipAsset(s, clip);
      if (!asset || !isVideoAsset(asset)) continue;
      const el = getVideo(asset.url, `${s.mediaOwnerPrefix}${clip.id}`);
      if (el.readyState >= 2) seeking.push(el);
    }

    let cancelled = false;
    let pending = seeking.length;
    let rafId = 0;

    const paint = () => {
      if (cancelled) return;
      rafId = requestAnimationFrame(() => draw(time));
    };

    if (pending === 0) {
      paint();
    } else {
      const onSeeked = () => {
        pending -= 1;
        if (pending === 0) paint();
      };
      for (const el of seeking) el.addEventListener("seeked", onSeeked);
      // Safety net: if a seek stalls, paint anyway rather than freeze on black.
      const timer = setTimeout(paint, 120);
      return () => {
        cancelled = true;
        clearTimeout(timer);
        cancelAnimationFrame(rafId);
        for (const el of seeking) el.removeEventListener("seeked", onSeeked);
      };
    }

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [state, draw, syncAudio]);

  // Audio scrub: while paused, play a short burst of any audio clip under the
  // playhead so dragging across the timeline is audible (Premiere Pro style).
  // Debounced so a drag plays one burst per pause, not one per frame.
  useEffect(() => {
    if (state.playing) return;
    const s = sceneRef.current;
    const time = state.playhead;

    const playables: HTMLAudioElement[] = [];
    for (const clip of activeClips(s, time)) {
      if (clip.kind !== "audio") continue;
      const asset = resolveClipAsset(s, clip);
      if (!asset || !isAudioAsset(asset)) continue;
      const el = getAudio(asset.url, `${s.mediaOwnerPrefix}${clip.id}`);
      const target = clip.offset + (time - clip.start) * clip.speed;
      if (Math.abs(el.currentTime - target) > 0.25) {
        try {
          el.currentTime = Math.max(0, target);
        } catch {
          /* seek before metadata — skip */
        }
      }
      el.volume = Math.min(1, Math.max(0, clip.volume));
      el.muted = s.tracks.get(clip.trackId)?.muted ?? false;
      playables.push(el);
    }

    if (!playables.length) return;

    for (const el of playables) {
      void el.play().catch(() => {
        /* autoplay blocked until first user gesture */
      });
    }

    if (scrubAudioTimer.current) clearTimeout(scrubAudioTimer.current);
    scrubAudioTimer.current = setTimeout(() => {
      for (const el of playables) {
        if (!el.paused) el.pause();
      }
    }, 220);

    return () => {
      if (scrubAudioTimer.current) clearTimeout(scrubAudioTimer.current);
    };
  }, [state.playhead, state.playing]);

  // When any image or video completes decoding, redraw the current frame
  useEffect(() => {
    return onMediaLoaded(() => {
      if (!stateRef.current.playing) {
        draw(stateRef.current.playhead);
      }
    });
  }, [draw]);

  // Playback loop anchored to wall-clock so it never drifts.
  useEffect(() => {
    if (!state.playing) {
      anchorRef.current = null;
      syncAudio(stateRef.current.playhead, false);
      syncVideoElements(sceneRef.current, stateRef.current.playhead, false);
      return;
    }
    anchorRef.current = { wall: performance.now(), time: stateRef.current.playhead };
    lastUiSyncRef.current = 0;

    const loop = () => {
      const a = anchorRef.current;
      if (!a) return;
      const s = sceneRef.current;
      const dur = projectDuration(s.clips);
      const now = performance.now();
      const t = a.time + (now - a.wall) / 1000;
      if (t >= dur) {
        setPlayhead(dur);
        setPlaying(false);
        return;
      }
      // The canvas and media elements follow the wall clock every frame, but
      // the React playhead only needs to move fast enough to look smooth.
      if (now - lastUiSyncRef.current >= 33) {
        lastUiSyncRef.current = now;
        setPlayhead(t);
      }
      syncVideoElements(s, t, true);
      syncAudio(t, true);
      draw(t);
      rafRef.current = requestAnimationFrame(loop);
    };
    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [state.playing, draw, setPlayhead, setPlaying, syncAudio]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
      const step = e.shiftKey ? 1 : 1 / stateRef.current.settings.fps;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!stateRef.current.playing);
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        splitAt(stateRef.current.playhead);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (stateRef.current.selectedClipIds.length) {
          e.preventDefault();
          // Ripple by default; Shift keeps the gap where the clip was.
          removeClips(stateRef.current.selectedClipIds, !e.shiftKey);
        }
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        setPlayhead(Math.max(0, stateRef.current.playhead - step));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        setPlayhead(stateRef.current.playhead + step);
      } else if (e.key === "Home") {
        setPlayhead(0);
      } else if (e.key === "End") {
        setPlayhead(projectDuration(sceneRef.current.clips));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPlaying, splitAt, removeClips, setPlayhead, undo, redo]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-rail">
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2 sm:p-3"
      >
        {/* Letterbox stage: absolutely positioned and centred via translate, so
            a tall 9:16 canvas pushes a box outward instead of growing the
            container — which is what used to shove the whole UI down. */}
        <div
          className="absolute top-1/2 left-1/2"
          style={{
            width,
            height,
            transform: "translate(-50%, -50%)",
          }}
        >
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full rounded-none bg-black shadow-2xl ring-1 ring-border/80"
          />
          {showSafeArea && (
            <div className="pointer-events-none absolute inset-0 rounded-none">
              <div className="absolute top-1/2 left-1/2 h-[80%] w-[90%] -translate-x-1/2 -translate-y-1/2 border border-dashed border-white/50" />
            </div>
          )}
          {width === 0 && (
            <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
              {state.settings.width}×{state.settings.height}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-panel px-3 py-2">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="ghost" onClick={() => setPlayhead(0)} title="Go to start (Home)">
            <SkipBack className="size-4" />
          </Button>
          <Button
            size="icon"
            variant={state.playing ? "secondary" : "default"}
            onClick={() => setPlaying(!state.playing)}
            title="Play / pause (Space)"
          >
            {state.playing ? <Pause className="size-4" /> : <Play className="size-4" />}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            onClick={() => setPlayhead(total)}
            title="Go to end (End)"
          >
            <SkipForward className="size-4" />
          </Button>
          <span className="ml-2 font-mono text-xs tabular-nums text-muted-foreground">
            {formatTime(state.playhead)} / {formatTime(total)}
          </span>
          <span className="ml-2 hidden font-mono text-xs text-muted-foreground sm:inline">
            {state.settings.width}×{state.settings.height} · {state.settings.aspectRatio}
          </span>
        </div>

        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={showSafeArea ? "secondary" : "ghost"}
            onClick={() => setShowSafeArea((v) => !v)}
            title="Toggle safe area guide"
          >
            <ChevronsLeftRight className="size-4" /> Guides
          </Button>
          <Button size="sm" variant="ghost" onClick={() => splitAt(state.playhead)} title="Cut at playhead (S)">
            <Scissors className="size-4" /> Cut
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => removeClips(state.selectedClipIds)}
            disabled={state.selectedClipIds.length === 0}
            title="Ripple delete selection (Del) · Shift+Del keeps the gap"
          >
            <Trash2 className="size-4" /> Delete
          </Button>
          <Button size="icon" variant="ghost" onClick={undo} title="Undo (Ctrl+Z)">
            <Undo2 className="size-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={redo} title="Redo (Ctrl+Shift+Z)">
            <Redo2 className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
