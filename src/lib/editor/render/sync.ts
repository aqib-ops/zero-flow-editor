import { getAudio, getVideo, isAudioAsset, isVideoAsset } from "../media";
import type { Clip } from "../types";
import {
  clipEnd,
  mediaOwnerForClip,
  resolveClipAsset,
  type RenderScene,
} from "./scene";

const warned = new Set<string>();

function warnOnce(key: string, error: unknown) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[render] ${key}`, error);
}

function syncElement(
  element: HTMLVideoElement | HTMLAudioElement,
  clip: Clip,
  time: number,
  playing: boolean,
  volume: number,
  muted: boolean,
) {
  const inside = time >= clip.start && time < clipEnd(clip);
  if (!inside) {
    if (!element.paused) element.pause();
    return;
  }

  const target = clip.offset + (time - clip.start) * clip.speed;
  const sourceDuration =
    Number.isFinite(element.duration) && element.duration > 0 ? element.duration : 0;

  // When a clip is trimmed longer than its source media, loop the media so it
  // covers the full clip duration instead of freezing on the last frame.
  if (sourceDuration > 0 && target >= sourceDuration) {
    element.loop = true;
    const wrapped = target % sourceDuration;
    if (Math.abs(element.currentTime - wrapped) > 0.25) {
      try {
        element.currentTime = Math.max(0, wrapped);
      } catch (error) {
        warnOnce(`seek ${element.currentSrc || element.src || clip.name}`, error);
      }
    }
  } else {
    element.loop = false;
    if (Math.abs(element.currentTime - target) > 0.25) {
      try {
        element.currentTime = Math.max(0, target);
      } catch (error) {
        warnOnce(`seek ${element.currentSrc || element.src || clip.name}`, error);
      }
    }
  }

  element.playbackRate = Math.min(4, Math.max(0.25, clip.speed));
  element.muted = muted;
  element.volume = muted ? 0 : Math.min(1, Math.max(0, volume));
  if (playing && element.paused) {
    void element.play().catch((error) => {
      warnOnce(`play ${element.currentSrc || element.src || clip.name}`, error);
    });
  }
  if (!playing && !element.paused) element.pause();
}

export function syncVideoElements(
  scene: RenderScene,
  time: number,
  playing: boolean,
) {
  for (const clip of scene.mediaClips) {
    const asset = resolveClipAsset(scene, clip);
    if (!asset || !isVideoAsset(asset)) continue;
    const track = scene.tracks.get(clip.trackId);
    // Imported overlays are visual-only. A video clip uses its video element
    // as the audio source too, so its track mute state controls both streams.
    const muted = clip.kind === "overlay" || (track?.muted ?? false);
    syncElement(
      getVideo(asset.url, mediaOwnerForClip(scene, clip)),
      clip,
      time,
      playing,
      clip.volume,
      muted,
    );
  }
}

export function syncAudioElements(
  scene: RenderScene,
  time: number,
  playing: boolean,
) {
  for (const clip of scene.mediaClips) {
    if (clip.kind !== "audio") continue;
    const asset = resolveClipAsset(scene, clip);
    if (!asset || !isAudioAsset(asset)) continue;
    const track = scene.tracks.get(clip.trackId);
    syncElement(
      getAudio(asset.url, mediaOwnerForClip(scene, clip)),
      clip,
      time,
      playing,
      clip.volume,
      track?.muted ?? false,
    );
  }
}
