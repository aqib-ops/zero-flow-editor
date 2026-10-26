import { useCallback, useEffect, useRef, useState } from "react";
import { Film, Image as ImageIcon, Music, Plus, Trash2, FolderOpen, Play, Pause, Sparkles, Volume2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { assetFromPath, baseName, formatTime, naturalCompare } from "@/lib/editor/media";
import { makeClip, useEditor } from "@/lib/editor/store";
import type { MediaAsset, TrackKind } from "@/lib/editor/types";

/** Largest batch we probe at once, so the UI never locks up on a big import. */
const BATCH = 4;

export function ImportPanel() {
  const { state, addAssets, removeAsset, addClips } = useEditor();
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  const toggleAudioPreview = useCallback((asset: MediaAsset) => {
    if (playingAudioId === asset.id) {
      audioPreviewRef.current?.pause();
      setPlayingAudioId(null);
      return;
    }
    if (!audioPreviewRef.current) {
      audioPreviewRef.current = new Audio();
    }
    audioPreviewRef.current.src = asset.url;
    audioPreviewRef.current.onended = () => setPlayingAudioId(null);
    audioPreviewRef.current.onerror = () => {
      toast.error(`Could not play audio: ${asset.name}`);
      setPlayingAudioId(null);
    };
    audioPreviewRef.current
      .play()
      .then(() => {
        setPlayingAudioId(asset.id);
      })
      .catch((err) => {
        toast.error(`Audio playback error: ${err.message}`);
        setPlayingAudioId(null);
      });
  }, [playingAudioId]);

  useEffect(() => {
    return () => {
      if (audioPreviewRef.current) {
        audioPreviewRef.current.pause();
        audioPreviewRef.current = null;
      }
    };
  }, []);

  const ingest = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      setBusy(true);
      const found: MediaAsset[] = [];
      const skipped: string[] = [];
      try {
        for (let i = 0; i < paths.length; i += BATCH) {
          const slice = paths.slice(i, i + BATCH);
          const results = await Promise.all(
            slice.map(async (path) => {
              const probe = window.zf?.ffmpeg ? () => window.zf.ffmpeg.probe(path) : undefined;
              return assetFromPath(path, probe);
            }),
          );
          for (const r of results) {
            if (r) found.push(r);
          }
        }
        for (const p of paths) {
          if (!found.some((a) => a.path === p)) skipped.push(baseName(p));
        }
      } finally {
        setBusy(false);
      }

      if (found.length) {
        found.sort((a, b) => naturalCompare(a.name, b.name));
        addAssets(found);
        toast.success(`Imported ${found.length} file${found.length > 1 ? "s" : ""}`);
      }
      if (skipped.length) {
        toast.error(`Could not read ${skipped.length} file${skipped.length > 1 ? "s" : ""}: ${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}`);
      }
      if (!found.length && !skipped.length) toast.error("No supported media found");
    },
    [addAssets],
  );

  const pickFiles = useCallback(async () => {
    const paths = (await window.zf?.dialog?.openMedia()) ?? [];
    await ingest(paths);
  }, [ingest]);

  /** Shared drop-into-panel handler for both the import bar and the empty state. */
  const acceptDroppedFiles = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    // Electron 37 dropped `File.path`; the preload resolves real paths via webUtils.
    const getPath = window.zf?.files?.getPathForFile;
    const paths = getPath ? files.map((f) => getPath(f)).filter(Boolean) : [];
    if (paths.length) void ingest(paths);
    else toast.error("Could not read those files — use Click to import instead");
  };

  const trackFor = (kind: TrackKind) =>
    state.tracks.find((t) => t.kind === kind)?.id ?? state.tracks[0].id;

  const appendAsset = (asset: MediaAsset) => {
    const kind: TrackKind = asset.kind === "audio" ? "audio" : asset.kind === "overlay" ? "overlay" : "video";
    const trackId = trackFor(kind);
    const end = state.clips
      .filter((c) => c.trackId === trackId)
      .reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    addClips([
      makeClip({
        trackId,
        kind,
        name: asset.name,
        assetId: asset.id,
        start: end,
        duration: asset.duration,
      }),
    ]);
    toast.success(`Added ${asset.name} to timeline`);
  };

  const addAllToTimeline = () => {
    const videoId = trackFor("video");
    const audioId = trackFor("audio");
    const clips = state.assets
      .filter((a) => a.kind !== "overlay")
      .map((asset) => ({ asset, kind: asset.kind === "audio" ? "audio" : "video" } as const))
      .sort((a, b) => naturalCompare(a.asset.name, b.asset.name));

    let vEnd = state.clips.filter((c) => c.trackId === videoId).reduce((m, c) => Math.max(m, c.start + c.duration), 0);
    let aEnd = state.clips.filter((c) => c.trackId === audioId).reduce((m, c) => Math.max(m, c.start + c.duration), 0);

    const built = clips.map(({ asset, kind }) => {
      const trackId = kind === "audio" ? audioId : videoId;
      const start = kind === "audio" ? aEnd : vEnd;
      const clip = makeClip({
        trackId,
        kind,
        name: asset.name,
        assetId: asset.id,
        start,
        duration: asset.duration,
      });
      if (kind === "audio") aEnd += asset.duration;
      else vEnd += asset.duration;
      return clip;
    });

    if (!built.length) return toast.error("Nothing importable in the library");
    addClips(built);
    toast.success(`Added ${built.length} clips to the timeline`);
  };

  const icon = (kind: MediaAsset["kind"]) =>
    kind === "image" ? (
      <ImageIcon className="size-4" />
    ) : kind === "video" ? (
      <Film className="size-4" />
    ) : (
      <Music className="size-4" />
    );

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto pr-1">
      {/* Compact one-row import action — the old tall drop zone made repeated
          imports push the library down. Still accepts file drops directly. */}
      <button
        className={cn(
          "flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-left transition-colors",
          dragOver ? "border-primary bg-primary/10" : "border-border hover:border-primary/60",
        )}
        onClick={pickFiles}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={acceptDroppedFiles}
      >
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {busy ? "Reading files…" : "Import media"}
          </span>
          <span className="block truncate text-[10px] text-muted-foreground">
            Click or drop files — MP4, MOV, MKV, PNG, JPG, MP3, WAV…
          </span>
        </span>
      </button>

      {state.assets.length > 0 && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">{state.assets.length} items</span>
          <Button size="sm" variant="secondary" onClick={addAllToTimeline} className="h-7 text-xs font-medium">
            Add all to timeline
          </Button>
        </div>
      )}

      {state.assets.length > 0 && state.clips.length === 0 && (
        <div className="rounded-md border border-primary/30 bg-primary/10 p-2 text-xs text-primary flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            <Sparkles className="size-3.5 shrink-0" />
            Click below to preview on monitor:
          </span>
          <Button size="sm" className="h-6 text-[11px] px-2" onClick={addAllToTimeline}>
            Add to timeline
          </Button>
        </div>
      )}

      {/* Auto-fill thumbnail grid: ~76px cards so 3-4 assets share a row even
          at the default side-panel width, and the column count self-adjusts as
          the panel is resized — viewport breakpoints can't see the container
          width, so the panel being user-resizable rules them out. */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(76px,1fr))] gap-1.5">
        {state.assets.map((asset) => (
          <div
            key={asset.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("text/asset-id", asset.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
            onDoubleClick={() => appendAsset(asset)}
            className="group flex cursor-grab flex-col rounded-md border border-border bg-panel-raised p-1 active:cursor-grabbing hover:border-primary/40 transition-colors"
          >
            <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded bg-rail text-muted-foreground">
              {asset.thumb ? (
                <img
                  src={asset.thumb}
                  alt=""
                  className="size-full object-cover"
                  onError={(e) => {
                    // If thumb fails, hide img so icon fallback shows
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : (
                icon(asset.kind)
              )}

              {/* Audio: play/pause lives on the thumbnail */}
              {asset.kind === "audio" && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAudioPreview(asset);
                  }}
                  className={cn(
                    "absolute inset-0 flex items-center justify-center transition-opacity",
                    playingAudioId === asset.id
                      ? "bg-primary/70 text-primary-foreground opacity-100"
                      : "bg-black/45 text-white opacity-0 group-hover:opacity-100",
                  )}
                  title={playingAudioId === asset.id ? "Pause" : "Listen"}
                  aria-label={playingAudioId === asset.id ? "Pause preview" : "Listen to audio preview"}
                >
                  {playingAudioId === asset.id ? (
                    <Pause className="size-4 animate-pulse" />
                  ) : (
                    <Play className="size-4 ml-0.5 fill-current" />
                  )}
                </button>
              )}
            </div>

            <p className="mt-1 truncate px-0.5 text-[10px] font-medium" title={asset.path}>
              {asset.name}
            </p>

            <div
              className="truncate px-0.5 font-mono text-[9px] leading-3 text-muted-foreground"
              title={[
                asset.kind,
                asset.kind === "overlay" ? "" : formatTime(asset.duration),
                asset.kind === "image" || asset.kind === "video" ? `${asset.width}×${asset.height}` : "",
                asset.kind === "video" && asset.hasAudio ? "has audio" : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <span className="capitalize">{asset.kind}</span>
              {asset.kind === "overlay" ? "" : <span> · {formatTime(asset.duration)}</span>}
              {asset.kind === "image" || asset.kind === "video" ? (
                <span> · {asset.width}×{asset.height}</span>
              ) : ""}
              {asset.kind === "video" && asset.hasAudio ? (
                <span className="inline-flex items-center gap-0.5 align-[-1px]" title="Has audio track">
                  <Volume2 className="size-2.5" aria-label="Has audio track" />
                </span>
              ) : ""}
            </div>

            <div className="mt-0.5 flex items-center justify-end gap-0.5">
              {asset.kind === "audio" && (
                <Button
                  size="icon"
                  variant="ghost"
                  className={cn(
                    "size-5 shrink-0",
                    playingAudioId === asset.id ? "text-primary" : "text-muted-foreground",
                  )}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleAudioPreview(asset);
                  }}
                  title={playingAudioId === asset.id ? "Pause audio" : "Play audio"}
                >
                  {playingAudioId === asset.id ? (
                    <Pause className="size-3 fill-current" />
                  ) : (
                    <Play className="size-3 ml-px fill-current" />
                  )}
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="size-5 shrink-0 opacity-70 group-hover:opacity-100 hover:text-primary"
                onClick={() => appendAsset(asset)}
                title="Add to timeline"
              >
                <Plus className="size-3" />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                className="size-5 shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive"
                onClick={() => removeAsset(asset.id)}
                title="Remove"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
          </div>
        ))}

        {state.assets.length === 0 && (
          /* Empty state fills the leftover panel height so it reads as a real
             drop zone instead of a stray sentence at the bottom. */
          <button
            type="button"
            onClick={pickFiles}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={acceptDroppedFiles}
            className={cn(
              "group flex min-h-28 flex-1 cursor-pointer flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-4 py-8 text-center transition-colors",
              dragOver ? "border-primary bg-primary/10" : "border-border hover:border-primary/60 hover:bg-panel-raised/50",
            )}
          >
            <div className="mb-1 flex size-11 items-center justify-center rounded-full bg-rail text-muted-foreground transition-colors group-hover:text-primary">
              <FolderOpen className="size-5" />
            </div>
            <span className="text-sm font-medium">Nothing imported yet</span>
            <span className="text-xs text-muted-foreground">
              Drop files here or click to import — video, image, or audio
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
