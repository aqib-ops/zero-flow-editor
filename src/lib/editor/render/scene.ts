import type { Clip, EditorState, MediaAsset, Track, TrackKind } from "../types";

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration;
}

export function projectDuration(clips: readonly Clip[]): number {
  return clips.reduce((max, clip) => Math.max(max, clipEnd(clip)), 0);
}

/**
 * Overlay clips keep their imported media id on the overlay source. Every
 * renderer/export path must use the same resolver so imported overlays behave
 * like regular visual clips.
 */
export function resolveClipAssetId(clip: Clip): string | undefined {
  if (clip.assetId) return clip.assetId;
  if (clip.overlay && clip.overlay.type !== "builtin") return clip.overlay.assetId;
  return undefined;
}

export interface RenderScene {
  settings: EditorState["settings"];
  /**
   * Namespace for cached media elements. Preview and export intentionally use
   * separate namespaces so an export seek can never disturb a playing preview.
   */
  mediaOwnerPrefix: string;
  assets: ReadonlyMap<string, MediaAsset>;
  tracks: ReadonlyMap<string, Track>;
  clips: readonly Clip[];
  clipsByTrack: ReadonlyMap<string, readonly Clip[]>;
  /**
   * For each track, `prefixMaxEnd[i]` is the latest end time among clips
   * `0..i`. The renderer uses it to stop scanning backwards as soon as no
   * earlier clip can still be on screen, which keeps long timelines cheap.
   */
  prefixMaxEndByTrack: ReadonlyMap<string, readonly number[]>;
  mediaClips: readonly Clip[];
  layerTracks: {
    video: readonly Track[];
    overlay: readonly Track[];
    text: readonly Track[];
  };
}

/**
 * Build the immutable lookup tables once per edit, then reuse them for every
 * preview frame and every export frame.
 */
export function buildRenderScene(state: EditorState, mediaOwnerPrefix = ""): RenderScene {
  const assets = new Map(state.assets.map((asset) => [asset.id, asset]));
  const tracks = new Map(state.tracks.map((track) => [track.id, track]));
  const clipsByTrack = new Map<string, Clip[]>();
  const mediaClips: Clip[] = [];

  for (const clip of state.clips) {
    const trackClips = clipsByTrack.get(clip.trackId) ?? [];
    trackClips.push(clip);
    clipsByTrack.set(clip.trackId, trackClips);
    if (resolveClipAssetId(clip)) mediaClips.push(clip);
  }

  for (const trackClips of clipsByTrack.values()) {
    trackClips.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  }

  const prefixMaxEndByTrack = new Map<string, number[]>();
  for (const [trackId, trackClips] of clipsByTrack) {
    const prefix: number[] = new Array(trackClips.length);
    let running = 0;
    for (let i = 0; i < trackClips.length; i++) {
      running = Math.max(running, clipEnd(trackClips[i]));
      prefix[i] = running;
    }
    prefixMaxEndByTrack.set(trackId, prefix);
  }

  const tracksForKind = (kind: TrackKind) =>
    state.tracks.filter((track) => track.kind === kind && !track.hidden);

  return {
    settings: state.settings,
    mediaOwnerPrefix,
    assets,
    tracks,
    clips: state.clips,
    clipsByTrack,
    prefixMaxEndByTrack,
    mediaClips,
    layerTracks: {
      video: tracksForKind("video"),
      overlay: tracksForKind("overlay"),
      text: tracksForKind("text"),
    },
  };
}

export function mediaOwnerForClip(scene: RenderScene, clip: Clip): string {
  return `${scene.mediaOwnerPrefix}${clip.id}`;
}

export function resolveClipAsset(
  scene: RenderScene,
  clip: Clip,
): MediaAsset | undefined {
  const assetId = resolveClipAssetId(clip);
  return assetId ? scene.assets.get(assetId) : undefined;
}

/**
 * Return active clips in timeline order without allocating a filtered copy of
 * the full clip list on every frame.
 */
export function activeClipsForTrack(
  clips: readonly Clip[],
  time: number,
  prefixMaxEnd?: readonly number[],
): Clip[] {
  if (!clips.length) return [];

  let low = 0;
  let high = clips.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (clips[mid].start <= time) low = mid + 1;
    else high = mid;
  }

  const active: Clip[] = [];
  for (let i = low - 1; i >= 0; i--) {
    if (prefixMaxEnd && prefixMaxEnd[i] <= time) break;
    const clip = clips[i];
    if (time >= clip.start && time < clipEnd(clip) - 0.0001) active.push(clip);
  }
  active.reverse();
  return active;
}

export function activeClips(scene: RenderScene, time: number): Clip[] {
  const active: Clip[] = [];
  for (const [trackId, clips] of scene.clipsByTrack) {
    active.push(...activeClipsForTrack(clips, time, scene.prefixMaxEndByTrack.get(trackId)));
  }
  return active;
}
