import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { uid } from "./media";
import type { Clip, EditorState, MediaAsset, OverlaySource, Track, TrackKind } from "./types";

const defaultTracks: Track[] = [
  { id: "t-text", kind: "text", name: "Text" },
  { id: "t-overlay", kind: "overlay", name: "Overlays" },
  { id: "t-video", kind: "video", name: "Video 1" },
  { id: "t-audio", kind: "audio", name: "Audio 1" },
];

const initialState: EditorState = {
  assets: [],
  tracks: defaultTracks,
  clips: [],
  settings: { width: 1920, height: 1080, aspectRatio: "16:9", fps: 30, background: "#000000" },
  selectedClipIds: [],
  playhead: 0,
  playing: false,
  zoom: 80,
  snap: true,
};

export const DEFAULT_OVERLAY_BLEND: GlobalCompositeOperation = "screen";

export function makeClip(partial: Partial<Clip> & { trackId: string; kind: TrackKind }): Clip {
  return {
    id: uid(),
    name: "Clip",
    start: 0,
    duration: 4,
    offset: 0,
    speed: 1,
    volume: 1,
    animation: "none",
    animationAmount: 0.12,
    transition: "none",
    transitionDuration: 0.25,
    opacity: 1,
    blend: DEFAULT_OVERLAY_BLEND,
    ...partial,
  };
}

export function isOverlayClip(clip: Clip): boolean {
  return clip.kind === "overlay" && clip.overlay !== undefined;
}

export function overlayKey(overlay: OverlaySource): string {
  return overlay.type === "builtin" ? `builtin:${overlay.kind}` : `${overlay.type}:${overlay.assetId}`;
}

interface Ctx {
  state: EditorState;
  /** Raw state setter — use for transient UI state that must not be undoable. */
  set: React.Dispatch<React.SetStateAction<EditorState>>;
  /** History-committing update. */
  update: (fn: (s: EditorState) => EditorState, commit?: boolean) => void;
  addAssets: (assets: MediaAsset[]) => void;
  removeAsset: (id: string) => void;
  addClips: (clips: Clip[]) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  updateClips: (ids: string[], patch: Partial<Clip>) => void;
  removeClips: (ids: string[]) => void;
  moveClip: (id: string, start: number, trackId?: string) => void;
  splitAt: (time: number) => void;
  select: (ids: string[]) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  addTrack: (kind: TrackKind) => string;
  setAspectRatio: (ratio: EditorState["settings"]["aspectRatio"]) => void;
  loadProject: (data: Partial<EditorState>) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

const EditorContext = createContext<Ctx | null>(null);

const HISTORY_LIMIT = 60;

export function EditorProvider({ children }: { children: React.ReactNode }) {
  const [state, set] = useState<EditorState>(initialState);
  const past = useRef<EditorState[]>([]);
  const future = useRef<EditorState[]>([]);
  const [version, bump] = useState(0);
  /**
   * Coalescing: rapid drags / slider moves should land as one undo step.
   * A non-committing update within this window of a previous one is folded in.
   */
  const lastCommitAt = useRef(0);
  const pendingBase = useRef<EditorState | null>(null);

  const update = useCallback((fn: (s: EditorState) => EditorState, commit = true) => {
    set((s) => {
      if (commit) {
        const now = performance.now();
        const coalesce = now - lastCommitAt.current < 450 && pendingBase.current;
        past.current = [
          ...(coalesce ? past.current : [...past.current, pendingBase.current ?? s]).slice(
            -HISTORY_LIMIT,
          ),
        ];
        if (!coalesce) pendingBase.current = s;
        else {
          // Keep the original base the gesture started from.
          if (!pendingBase.current) pendingBase.current = s;
        }
        lastCommitAt.current = now;
        future.current = [];
      }
      return fn(s);
    });
    if (commit) bump((v) => v + 1);
  }, []);

  const commitNow = useCallback(() => {
    lastCommitAt.current = 0;
    pendingBase.current = null;
  }, []);

  const undo = useCallback(() => {
    set((s) => {
      const prev = past.current.pop();
      if (!prev) return s;
      future.current = [s, ...future.current.slice(0, HISTORY_LIMIT)];
      pendingBase.current = null;
      lastCommitAt.current = 0;
      return { ...prev, playing: false };
    });
    bump((v) => v + 1);
  }, []);

  const redo = useCallback(() => {
    set((s) => {
      const next = future.current.shift();
      if (!next) return s;
      past.current = [...past.current, s].slice(-HISTORY_LIMIT);
      pendingBase.current = null;
      lastCommitAt.current = 0;
      return { ...next, playing: false };
    });
    bump((v) => v + 1);
  }, []);

  const addAssets = useCallback(
    (assets: MediaAsset[]) => update((s) => ({ ...s, assets: [...s.assets, ...assets] })),
    [update],
  );

  const removeAsset = useCallback(
    (id: string) =>
      update((s) => ({
        ...s,
        assets: s.assets.filter((a) => a.id !== id),
        // Drop clips that referenced it, and detach overlays that used it.
        clips: s.clips
          .filter((c) => c.assetId !== id)
          .map((c) => {
            if (!c.overlay) return c;
            if (c.overlay.type !== "builtin" && c.overlay.assetId === id) {
              const { overlay, ...rest } = c;
              return { ...rest, overlay: { type: "builtin", kind: "grain" } } as Clip;
            }
            return c;
          }),
        selectedClipIds: s.selectedClipIds.filter(
          (cid) => !s.clips.some((c) => c.id === cid && c.assetId === id),
        ),
      })),
    [update],
  );

  const addClips = useCallback(
    (clips: Clip[]) =>
      update((s) => {
        commitNow();
        return { ...s, clips: [...s.clips, ...clips] };
      }),
    [update, commitNow],
  );

  const updateClip = useCallback(
    (id: string, patch: Partial<Clip>) =>
      update((s) => ({
        ...s,
        clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      })),
    [update],
  );

  const updateClips = useCallback(
    (ids: string[], patch: Partial<Clip>) =>
      update((s) => {
        const set = new Set(ids);
        return { ...s, clips: s.clips.map((c) => (set.has(c.id) ? { ...c, ...patch } : c)) };
      }),
    [update],
  );

  const moveClip = useCallback(
    (id: string, start: number, trackId?: string) =>
      update(
        (s) => ({
          ...s,
          clips: s.clips.map((c) =>
            c.id === id
              ? { ...c, start: Math.max(0, start), trackId: trackId && trackId !== c.trackId ? trackId : c.trackId }
              : c,
          ),
        }),
        false,
      ),
    [update],
  );

  const removeClips = useCallback(
    (ids: string[]) =>
      update((s) => {
        const set = new Set(ids);
        if (!set.size) return s;
        return {
          ...s,
          clips: s.clips.filter((c) => !set.has(c.id)),
          selectedClipIds: [],
        };
      }),
    [update],
  );

  const splitAt = useCallback(
    (time: number) =>
      update((s) => {
        const sel = s.selectedClipIds;
        const targets = s.clips.filter(
          (c) =>
            time > c.start + 0.05 &&
            time < c.start + c.duration - 0.05 &&
            (sel.length === 0 ? c.kind !== "overlay" : sel.includes(c.id)),
        );
        if (targets.length === 0) return s;
        const ids = new Set(targets.map((t) => t.id));
        const rest = s.clips.filter((c) => !ids.has(c.id));
        const pieces: Clip[] = [];
        for (const c of targets) {
          const leftDur = time - c.start;
          pieces.push({ ...c, duration: leftDur });
          pieces.push({
            ...c,
            id: uid(),
            start: time,
            duration: c.duration - leftDur,
            offset: c.offset + leftDur * c.speed,
            transition: "none",
          });
        }
        return { ...s, clips: [...rest, ...pieces], selectedClipIds: [] };
      }),
    [update],
  );

  const select = useCallback((ids: string[]) => set((s) => ({ ...s, selectedClipIds: ids })), []);

  const setPlayhead = useCallback(
    (t: number) => set((s) => ({ ...s, playhead: Math.max(0, t) })),
    [],
  );

  const setPlaying = useCallback((p: boolean) => set((s) => ({ ...s, playing: p })), []);

  const addTrack = useCallback(
    (kind: TrackKind) => {
      const id = "t-" + uid();
      update((s) => {
        const count = s.tracks.filter((t) => t.kind === kind).length;
        const position = s.tracks.findIndex((t) => t.kind === kind);
        const track: Track = {
          id,
          kind,
          name: `${kind[0].toUpperCase() + kind.slice(1)} ${count + 1}`,
        };
        const tracks = [...s.tracks];
        // insert right after the last track of the same kind
        if (position >= 0) tracks.splice(position + count, 0, track);
        else tracks.push(track);
        return { ...s, tracks };
      });
      return id;
    },
    [update],
  );

  const setAspectRatio = useCallback(
    (ratio: EditorState["settings"]["aspectRatio"]) =>
      update((s) => {
        const [rw, rh] = ratio.split(":").map(Number) as [number, number];
        const height = 1080;
        const width = Math.round((height * rw) / rh);
        return { ...s, settings: { ...s.settings, aspectRatio: ratio, width, height } };
      }),
    [update],
  );

  const loadProject = useCallback(
    (data: Partial<EditorState>) =>
      update((s) => ({
        ...s,
        settings: data.settings ?? s.settings,
        tracks: data.tracks?.length ? data.tracks : s.tracks,
        clips: data.clips ?? s.clips,
        assets: data.assets ?? s.assets,
        selectedClipIds: [],
        playhead: 0,
        playing: false,
      })),
    [update],
  );

  const value = useMemo<Ctx>(
    () => ({
      state,
      set,
      update,
      addAssets,
      removeAsset,
      addClips,
      updateClip,
      updateClips,
      moveClip,
      removeClips,
      splitAt,
      select,
      setPlayhead,
      setPlaying,
      addTrack,
      setAspectRatio,
      loadProject,
      undo,
      redo,
      canUndo: past.current.length > 0,
      canRedo: future.current.length > 0,
    }),
    [
      state, version, update, addAssets, removeAsset, addClips, updateClip, updateClips, moveClip,
      removeClips, splitAt, select, setPlayhead, setPlaying, addTrack, setAspectRatio, loadProject,
      undo, redo,
    ],
  );

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor() {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used inside EditorProvider");
  return ctx;
}
