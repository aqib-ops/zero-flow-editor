import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { releaseAsset, toFileUrl, uid } from "./media";
import { BLEND_MODES } from "./styles";
import type {
  AnimationKind,
  Clip,
  EditorState,
  MediaAsset,
  OverlaySource,
  TextAnchor,
  Track,
  TrackKind,
  TransitionKind,
} from "./types";

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

const ASPECT_RATIOS = new Set<EditorState["settings"]["aspectRatio"]>([
  "16:9",
  "9:16",
  "1:1",
  "4:3",
  "3:4",
  "21:9",
  "4:5",
]);
const TRACK_KINDS = new Set<TrackKind>(["video", "audio", "text", "overlay"]);
const ASSET_KINDS = new Set<MediaAsset["kind"]>(["image", "audio", "video", "overlay"]);
const ANIMATIONS = new Set<AnimationKind>([
  "none",
  "zoomIn",
  "zoomOut",
  "panLeft",
  "panRight",
  "panUp",
  "panDown",
]);
const TRANSITIONS = new Set<TransitionKind>([
  "none",
  "fade",
  "slideLeft",
  "slideUp",
  "wipe",
  "push",
  "flash",
  "zoomPop",
]);
const TEXT_ANCHORS = new Set<TextAnchor>(["top", "middle", "bottom"]);

const clampNumber = (value: unknown, min: number, max: number, fallback: number): number => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
};

const asText = (value: unknown, fallback = ""): string =>
  typeof value === "string" && value.trim() ? value : fallback;

function uniqueId(prefix: string, used: Set<string>, preferred?: string): string {
  const requested = typeof preferred === "string" && preferred.trim() ? preferred.trim() : "";
  let id = requested && !used.has(requested) ? requested : `${prefix}${uid()}`;
  while (used.has(id)) id = `${prefix}${uid()}`;
  used.add(id);
  return id;
}

function sanitizeSettings(raw: unknown): EditorState["settings"] {
  const candidate =
    raw && typeof raw === "object" ? (raw as Partial<EditorState["settings"]>) : {};
  const aspectRatio =
    typeof candidate.aspectRatio === "string" &&
    ASPECT_RATIOS.has(candidate.aspectRatio as EditorState["settings"]["aspectRatio"])
      ? (candidate.aspectRatio as EditorState["settings"]["aspectRatio"])
      : "16:9";
  const [ratioWidth, ratioHeight] = aspectRatio.split(":").map(Number);
  const height = Math.round(clampNumber(candidate.height, 2, 4320, 1080));
  const width = Math.round((height * ratioWidth) / Math.max(1, ratioHeight));

  return {
    width: Math.max(2, width),
    height,
    aspectRatio,
    fps: Math.round(clampNumber(candidate.fps, 1, 120, 30)),
    background: asText(candidate.background, "#000000"),
  };
}

function sanitizeTracks(raw: unknown): { tracks: Track[]; idMap: Map<string, string> } {
  const source = Array.isArray(raw) ? raw : [];
  const used = new Set<string>();
  const idMap = new Map<string, string>();
  const tracks: Track[] = [];

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<Track>;
    if (!candidate.kind || !TRACK_KINDS.has(candidate.kind)) continue;
    const kind = candidate.kind;
    const originalId = typeof candidate.id === "string" && candidate.id ? candidate.id : undefined;
    const id = uniqueId("t-", used, candidate.id);
    if (originalId && !idMap.has(originalId)) idMap.set(originalId, id);
    tracks.push({
      id,
      kind,
      name: asText(candidate.name, `${kind[0].toUpperCase()}${kind.slice(1)}`),
      muted: Boolean(candidate.muted),
      hidden: Boolean(candidate.hidden),
      locked: Boolean(candidate.locked),
    });
  }

  // The editor assumes each core track type exists. Add a missing default
  // rather than allowing malformed project files to break a panel later.
  for (const kind of ["text", "overlay", "video", "audio"] as const) {
    if (tracks.some((track) => track.kind === kind)) continue;
    const fallback = defaultTracks.find((track) => track.kind === kind);
    if (!fallback) continue;
    const id = uniqueId("t-", used);
    tracks.push({ ...fallback, id });
  }

  return { tracks, idMap };
}

function sanitizeAssets(raw: unknown): {
  assets: MediaAsset[];
  idMap: Map<string, string>;
} {
  const source = Array.isArray(raw) ? raw : [];
  const used = new Set<string>();
  const idMap = new Map<string, string>();
  const assets: MediaAsset[] = [];

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<MediaAsset>;
    if (!candidate.kind || !ASSET_KINDS.has(candidate.kind)) continue;

    const originalId = asText(candidate.id, `asset-${uid()}`);
    const id = uniqueId("asset-", used, originalId);
    if (!idMap.has(originalId)) idMap.set(originalId, id);
    const path = typeof candidate.path === "string" ? candidate.path : "";
    const url = asText(candidate.url, toFileUrl(path));
    if (!path && !url) continue;

    const kind = candidate.kind;
    const defaultDuration = kind === "image" ? 4 : 10;
    assets.push({
      id,
      name: asText(candidate.name, path.split(/[\\/]/).pop() || "Media"),
      kind,
      path,
      url,
      duration: clampNumber(candidate.duration, 0.05, 86400, defaultDuration),
      width: Math.round(clampNumber(candidate.width, 1, 16384, 1920)),
      height: Math.round(clampNumber(candidate.height, 1, 16384, 1080)),
      hasAudio: Boolean(candidate.hasAudio),
      ...(typeof candidate.thumb === "string" && candidate.thumb
        ? { thumb: candidate.thumb }
        : {}),
    });
  }

  return { assets, idMap };
}

function sanitizeOverlay(
  raw: unknown,
  assets: ReadonlyMap<string, MediaAsset>,
  idMap: Map<string, string>,
): OverlaySource | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<OverlaySource>;
  if (candidate.type === "builtin") {
    const kind = candidate.kind;
    if (
      kind === "grain" ||
      kind === "particles" ||
      kind === "dust" ||
      kind === "vignette" ||
      kind === "scanlines" ||
      kind === "light"
    ) {
      return { type: "builtin", kind };
    }
    return undefined;
  }
  if (candidate.type === "video" || candidate.type === "image") {
    const source = candidate as { type: "video" | "image"; assetId?: string };
    const assetId = source.assetId ? idMap.get(source.assetId) ?? source.assetId : undefined;
    if (assetId && assets.has(assetId)) return { type: candidate.type, assetId };
  }
  return undefined;
}

function sanitizeClips(
  raw: unknown,
  assets: readonly MediaAsset[],
  tracks: readonly Track[],
  assetIdMap: Map<string, string>,
  trackIdMap: Map<string, string>,
): Clip[] {
  const source = Array.isArray(raw) ? raw : [];
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const used = new Set<string>();
  const clips: Clip[] = [];

  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<Clip>;
    const originalTrackId = candidate.trackId ?? "";
    const track = trackById.get(trackIdMap.get(originalTrackId) ?? originalTrackId);
    if (!track) continue;

    const kind = track.kind;
    const id = uniqueId("clip-", used, candidate.id);
    const assetIdRaw = typeof candidate.assetId === "string" ? candidate.assetId : undefined;
    const assetId = assetIdRaw ? assetIdMap.get(assetIdRaw) ?? assetIdRaw : undefined;
    if (assetId && !assetById.has(assetId)) continue;
    if ((kind === "video" || kind === "audio") && !assetId) continue;

    const overlay =
      kind === "overlay"
        ? sanitizeOverlay(candidate.overlay, assetById, assetIdMap)
        : undefined;
    if (kind === "overlay" && !overlay) continue;

    const animation = ANIMATIONS.has(candidate.animation as AnimationKind)
      ? (candidate.animation as AnimationKind)
      : "none";
    const transition = TRANSITIONS.has(candidate.transition as TransitionKind)
      ? (candidate.transition as TransitionKind)
      : "none";
    const anchor = TEXT_ANCHORS.has(candidate.anchor as TextAnchor)
      ? (candidate.anchor as TextAnchor)
      : "bottom";
    const blend = BLEND_MODES.includes(candidate.blend as GlobalCompositeOperation)
      ? (candidate.blend as GlobalCompositeOperation)
      : DEFAULT_OVERLAY_BLEND;

    clips.push({
      id,
      trackId: track.id,
      kind,
      name: asText(candidate.name, kind === "text" ? "Text" : "Clip"),
      ...(assetId ? { assetId } : {}),
      start: clampNumber(candidate.start, 0, 86400, 0),
      duration: clampNumber(candidate.duration, 0.05, 86400, 4),
      offset: clampNumber(candidate.offset, 0, 86400, 0),
      speed: clampNumber(candidate.speed, 0.25, 4, 1),
      volume: clampNumber(candidate.volume, 0, 4, 1),
      animation,
      animationAmount: clampNumber(candidate.animationAmount, 0, 1, 0.12),
      transition,
      transitionDuration: clampNumber(candidate.transitionDuration, 0, 10, 0.25),
      opacity: clampNumber(candidate.opacity, 0, 1, 1),
      blend,
      ...(kind === "text"
        ? {
            text: typeof candidate.text === "string" ? candidate.text : "",
            styleId: asText(candidate.styleId, "capcut-yellow"),
            anchor,
            singleLine: candidate.singleLine ?? true,
            sizeScale: clampNumber(candidate.sizeScale, 0.1, 5, 1),
            letterSpacing: clampNumber(candidate.letterSpacing, -20, 100, 0),
            wordSpacing: clampNumber(candidate.wordSpacing, -20, 100, 0),
            lineHeight: clampNumber(candidate.lineHeight, 0.5, 3, 1.18),
          }
        : {}),
      ...(overlay ? { overlay } : {}),
    });
  }

  return clips;
}

function sanitizeLoadedState(data: Partial<EditorState> | null | undefined): EditorState {
  const settings = sanitizeSettings(data?.settings);
  const { tracks, idMap: trackIdMap } = sanitizeTracks(data?.tracks);
  const { assets, idMap } = sanitizeAssets(data?.assets);
  const clips = sanitizeClips(data?.clips, assets, tracks, idMap, trackIdMap);
  return {
    ...initialState,
    settings,
    tracks,
    assets,
    clips,
    selectedClipIds: [],
    playhead: 0,
    playing: false,
    zoom: 80,
    snap: true,
  };
}

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

function splitTextAtBoundary(text: string, ratio: number): [string, string] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [text, words.length === 1 ? "" : ""];
  const cut = Math.min(words.length - 1, Math.max(1, Math.round(words.length * ratio)));
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

interface ClipPatch {
  id: string;
  patch: Partial<Clip>;
}

/**
 * Ripple-delete semantics: removing a clip closes its time range on that
 * timeline and pulls later clips left by the removed amount. Intervals are
 * merged globally so linked clips on different tracks stay in sync and
 * overlapping selections never subtract the same time twice.
 */
export function rippleDeleteClips(clips: Clip[], removed: Clip[]): Clip[] {
  const intervals: Array<{ start: number; end: number }> = [];
  for (const clip of removed) {
    intervals.push({ start: clip.start, end: clip.start + clip.duration });
  }

  const sorted = intervals.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (!last || interval.start > last.end + 0.0001) {
      merged.push({ ...interval });
    } else {
      last.end = Math.max(last.end, interval.end);
    }
  }

  return clips.map((clip) => {
    let removedBefore = 0;
    for (const interval of merged) {
      if (interval.start >= clip.start) break;
      removedBefore += Math.max(0, Math.min(interval.end, clip.start) - interval.start);
    }
    return removedBefore > 0 ? { ...clip, start: Math.max(0, clip.start - removedBefore) } : clip;
  });
}

interface Ctx {
  state: EditorState;
  /** Raw state setter — use for transient UI state that must not be undoable. */
  set: React.Dispatch<React.SetStateAction<EditorState>>;
  /** History-committing update. */
  update: (
    fn: (s: EditorState) => EditorState,
    commit?: boolean,
    coalesceKey?: string,
  ) => void;
  /** Start a pointer gesture whose transient updates should become one undo step. */
  beginGesture: () => void;
  /** Finish a pointer gesture, committing it to history or restoring its base. */
  endGesture: (commit?: boolean) => void;
  addAssets: (assets: MediaAsset[]) => void;
  removeAsset: (id: string) => void;
  addClips: (clips: Clip[]) => void;
  updateClip: (id: string, patch: Partial<Clip>, commit?: boolean) => void;
  updateClips: (ids: string[], patch: Partial<Clip>, commit?: boolean) => void;
  applyClipPatches: (patches: ClipPatch[], commit?: boolean) => void;
  /** `ripple` (default true) closes the gap the removed clips left behind. */
  removeClips: (ids: string[], ripple?: boolean) => void;
  moveClip: (id: string, start: number, trackId?: string, commit?: boolean) => void;
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
  const stateRef = useRef(state);
  stateRef.current = state;
  const past = useRef<EditorState[]>([]);
  const future = useRef<EditorState[]>([]);
  const [version, bump] = useState(0);
  /**
   * Coalescing: rapid drags / slider moves should land as one undo step.
   * A committing update within this window of a previous one is folded in.
   *
   * History mutations live outside the React state updater so StrictMode's
   * double-invocation cannot record the same edit twice.
   */
  const lastCommitAt = useRef(Number.NEGATIVE_INFINITY);
  const lastCoalesceKey = useRef<string | null>(null);
  const gestureActive = useRef(false);
  const gestureBase = useRef<EditorState | null>(null);

  const update = useCallback(
    (
      fn: (s: EditorState) => EditorState,
      commit = true,
      coalesceKey?: string,
    ) => {
      if (commit) {
        const now = performance.now();
        const key = coalesceKey?.trim() || null;
        const coalesce =
          key !== null &&
          key === lastCoalesceKey.current &&
          now - lastCommitAt.current < 450;
        if (!coalesce) {
          past.current = [...past.current, stateRef.current].slice(-HISTORY_LIMIT);
          future.current = [];
        }
        lastCoalesceKey.current = key;
        lastCommitAt.current = now;
      }
      set((s) => fn(s));
      if (commit) bump((v) => v + 1);
    },
    [],
  );

  const beginGesture = useCallback(() => {
    gestureActive.current = true;
    gestureBase.current = stateRef.current;
  }, []);

  const endGesture = useCallback((commit = true) => {
    const base = gestureBase.current;
    gestureActive.current = false;
    gestureBase.current = null;
    lastCommitAt.current = Number.NEGATIVE_INFINITY;
    lastCoalesceKey.current = null;

    if (!base) return;
    const current = stateRef.current;
    if (!commit) {
      // Cancelling a drag restores the clips but keeps whatever selection the
      // user made on pointer-down, since selection itself is not undoable.
      set({
        ...base,
        selectedClipIds: current.selectedClipIds,
        playhead: current.playhead,
        playing: current.playing,
        zoom: current.zoom,
        snap: current.snap,
      });
      bump((v) => v + 1);
      return;
    }
    if (
      base.clips !== current.clips ||
      base.tracks !== current.tracks ||
      base.settings !== current.settings
    ) {
      past.current = [...past.current, base].slice(-HISTORY_LIMIT);
      future.current = [];
    }
    bump((v) => v + 1);
  }, []);

  const commitNow = useCallback(() => {
    lastCommitAt.current = Number.NEGATIVE_INFINITY;
    lastCoalesceKey.current = null;
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current = [stateRef.current, ...future.current.slice(0, HISTORY_LIMIT)];
    gestureActive.current = false;
    gestureBase.current = null;
    lastCommitAt.current = Number.NEGATIVE_INFINITY;
    lastCoalesceKey.current = null;
    set({ ...prev, playing: false });
    bump((v) => v + 1);
  }, []);

  const redo = useCallback(() => {
    const next = future.current.shift();
    if (!next) return;
    past.current = [...past.current, stateRef.current].slice(-HISTORY_LIMIT);
    gestureActive.current = false;
    gestureBase.current = null;
    lastCommitAt.current = Number.NEGATIVE_INFINITY;
    lastCoalesceKey.current = null;
    set({ ...next, playing: false });
    bump((v) => v + 1);
  }, []);

  const addAssets = useCallback(
    (assets: MediaAsset[]) => update((s) => ({ ...s, assets: [...s.assets, ...assets] })),
    [update],
  );

  const removeAsset = useCallback(
    (id: string) => {
      const asset = stateRef.current.assets.find((candidate) => candidate.id === id);
      if (!asset) return;
      // Media elements are keyed by URL and must be released outside the
      // React state updater so a re-render cannot double-release them.
      releaseAsset(asset.url);
      commitNow();
      update((s) => {
        const clips = s.clips.filter((clip) => {
          if (clip.assetId === id) return false;
          return !(clip.overlay && clip.overlay.type !== "builtin" && clip.overlay.assetId === id);
        });
        const remainingIds = new Set(clips.map((clip) => clip.id));
        return {
          ...s,
          assets: s.assets.filter((candidate) => candidate.id !== id),
          clips,
          selectedClipIds: s.selectedClipIds.filter((clipId) => remainingIds.has(clipId)),
        };
      });
    },
    [commitNow, update],
  );

  const addClips = useCallback(
    (clips: Clip[]) => {
      // A fresh drop/insert is always its own undo step, never folded into a
      // previous slider or drag.
      commitNow();
      update((s) => ({ ...s, clips: [...s.clips, ...clips] }));
    },
    [update, commitNow],
  );

  const updateClip = useCallback(
    (id: string, patch: Partial<Clip>, commit = true) =>
      update(
        (s) => ({
          ...s,
          clips: s.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        }),
        commit,
        `clip:${id}`,
      ),
    [update],
  );

  const updateClips = useCallback(
    (ids: string[], patch: Partial<Clip>, commit = true) =>
      update(
        (s) => {
          const set = new Set(ids);
          return { ...s, clips: s.clips.map((c) => (set.has(c.id) ? { ...c, ...patch } : c)) };
        },
        commit,
        ids.slice().sort().join("|"),
      ),
    [update],
  );

  const applyClipPatches = useCallback(
    (patches: ClipPatch[], commit = true) => {
      if (!patches.length) return;
      const byId = new Map(patches.map(({ id, patch }) => [id, patch]));
      update(
        (s) => ({
          ...s,
          clips: s.clips.map((clip) => {
            const patch = byId.get(clip.id);
            return patch ? { ...clip, ...patch } : clip;
          }),
        }),
        commit,
        patches
          .map(({ id }) => id)
          .sort()
          .join("|"),
      );
    },
    [update],
  );

  const moveClip = useCallback(
    (id: string, start: number, trackId?: string, commit = false) =>
      update(
        (s) => ({
          ...s,
          clips: s.clips.map((c) =>
            c.id === id
              ? { ...c, start: Math.max(0, start), trackId: trackId && trackId !== c.trackId ? trackId : c.trackId }
              : c,
          ),
        }),
        commit,
        `clip:${id}`,
      ),
    [update],
  );

  const removeClips = useCallback(
    (ids: string[], ripple = true) =>
      update((s) => {
        const set = new Set(ids);
        if (!set.size) return s;
        const removed = s.clips.filter((c) => set.has(c.id));
        const remaining = s.clips.filter((c) => !set.has(c.id));
        return {
          ...s,
          clips: ripple ? rippleDeleteClips(remaining, removed) : remaining,
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
          const ratio = Math.min(1, Math.max(0, leftDur / Math.max(0.001, c.duration)));
          const [leftText, rightText] =
            c.kind === "text" ? splitTextAtBoundary(c.text ?? "", ratio) : [c.text, c.text];
          pieces.push({ ...c, duration: leftDur, text: leftText });
          pieces.push({
            ...c,
            id: uid(),
            start: time,
            duration: c.duration - leftDur,
            offset: c.offset + leftDur * c.speed,
            transition: "none",
            text: rightText,
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
    (data: Partial<EditorState>) => {
      // Release the previous media elements before replacing the asset map.
      for (const asset of stateRef.current.assets) {
        if (asset.url) releaseAsset(asset.url);
      }
      commitNow();
      update(() => sanitizeLoadedState(data));
    },
    [commitNow, update],
  );

  const value = useMemo<Ctx>(
    () => ({
      state,
      set,
      update,
      beginGesture,
      endGesture,
      addAssets,
      removeAsset,
      addClips,
      updateClip,
      updateClips,
      applyClipPatches,
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
      state, version, update, beginGesture, endGesture, addAssets, removeAsset, addClips,
      updateClip, updateClips, applyClipPatches, moveClip, removeClips, splitAt, select,
      setPlayhead, setPlaying, addTrack, setAspectRatio, loadProject, undo, redo,
    ],
  );

  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}

export function useEditor() {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor must be used inside EditorProvider");
  return ctx;
}
