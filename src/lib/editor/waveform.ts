import { useEffect, useState } from "react";

/**
 * Decoded peak data is shared between every clip that references the same
 * asset, so dragging a clip around never re-decodes the source audio.
 */
const BUCKETS = 4096;
const cache = new Map<string, number[] | null>();
const pending = new Map<string, Promise<number[] | null>>();

let audioContext: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (audioContext) return audioContext;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioContext = new Ctor();
    return audioContext;
  } catch (error) {
    console.warn("[waveform] could not create an AudioContext", error);
    return null;
  }
}

function peaksFrom(buffer: AudioBuffer): number[] {
  const data = buffer.getChannelData(0);
  const peaks = new Array<number>(BUCKETS).fill(0);
  const perBucket = Math.max(1, Math.floor(data.length / BUCKETS));
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    const start = bucket * perBucket;
    const end = Math.min(data.length, start + perBucket);
    let peak = 0;
    for (let i = start; i < end; i++) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
    }
    peaks[bucket] = peak;
  }
  return peaks;
}

export function loadWaveform(url: string): Promise<number[] | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url) ?? null);
  const inFlight = pending.get(url);
  if (inFlight) return inFlight;

  const job = (async (): Promise<number[] | null> => {
    try {
      const ctx = getAudioContext();
      if (!ctx) throw new Error("Web Audio is unavailable");
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bytes = await response.arrayBuffer();
      // decodeAudioData detaches the buffer, so hand it a private copy.
      const decoded = await ctx.decodeAudioData(bytes.slice(0));
      const peaks = peaksFrom(decoded);
      cache.set(url, peaks);
      return peaks;
    } catch (error) {
      console.warn("[waveform] could not decode audio for the timeline", url, error);
      cache.set(url, null);
      return null;
    } finally {
      pending.delete(url);
    }
  })();

  pending.set(url, job);
  return job;
}

export function useAudioWaveform(url: string | undefined): number[] | null {
  const [peaks, setPeaks] = useState<number[] | null>(() =>
    url ? cache.get(url) ?? null : null,
  );

  useEffect(() => {
    if (!url) {
      setPeaks(null);
      return;
    }
    const cached = cache.get(url);
    if (cached !== undefined) {
      setPeaks(cached);
      return;
    }
    let alive = true;
    void loadWaveform(url).then((value) => {
      if (alive) setPeaks(value);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  return peaks;
}
