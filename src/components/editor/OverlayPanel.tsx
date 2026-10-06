import { useCallback, useState } from "react";
import { Layers, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { naturalCompare, assetFromPath } from "@/lib/editor/media";
import { makeClip, useEditor } from "@/lib/editor/store";
import { projectDuration } from "@/lib/editor/render";
import { BLEND_MODES } from "@/lib/editor/styles";
import type { OverlaySource } from "@/lib/editor/types";

/**
 * Overlay hosting.
 *
 * Bring your own overlay videos (or PNG sequences / stills) and blend
 * them over the timeline. Each overlay becomes a real timeline clip you can
 * move, trim, retime, fade and re-blend.
 */
export function OverlayPanel() {
  const { state, addAssets, addClips, removeClips, select } = useEditor();
  const [busy, setBusy] = useState(false);
  const [defaultBlend, setDefaultBlend] = useState<GlobalCompositeOperation>("screen");
  const [defaultOpacity, setDefaultOpacity] = useState(1);

  const overlayTrack = state.tracks.find((t) => t.kind === "overlay");
  const overlayAssets = state.assets
    .filter((a) => a.kind === "video" || a.kind === "image" || a.kind === "overlay")
    .sort((a, b) => naturalCompare(a.name, b.name));

  const total = projectDuration(state.clips);

  const overlayClips = state.clips.filter((c) => c.kind === "overlay");

  const addOverlay = useCallback(
    (
      source: OverlaySource,
      name: string,
      duration?: number,
      preset?: { blend?: GlobalCompositeOperation; opacity?: number },
    ) => {
      if (!overlayTrack) return toast.error("No overlay track available");
      const dur = duration ?? total;
      if (dur <= 0) return toast.error("Add clips to the timeline first");

      const clip = makeClip({
        trackId: overlayTrack.id,
        kind: "overlay",
        name,
        start: 0,
        duration: dur,
        opacity: preset?.opacity ?? defaultOpacity,
        blend: preset?.blend ?? defaultBlend,
        overlay: source,
      });
      addClips([clip]);
      select([clip.id]);
    },
    [overlayTrack, total, defaultOpacity, defaultBlend, addClips, select],
  );

  const importOverlays = useCallback(async () => {
    const paths = (await window.zf?.dialog?.openMedia()) ?? [];
    if (!paths.length) return;
    setBusy(true);
    try {
      const assets = [];
      for (const p of paths) {
        const probe = window.zf?.ffmpeg ? () => window.zf.ffmpeg.probe(p) : undefined;
        const a = await assetFromPath(p, probe);
        if (a) assets.push(a);
      }
      if (assets.length) {
        addAssets(assets);
        toast.success(`Imported ${assets.length} overlay file${assets.length > 1 ? "s" : ""}`);
      } else {
        toast.error("No supported overlay media found");
      }
    } finally {
      setBusy(false);
    }
  }, [addAssets]);

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Your overlays
          </p>
          <Button size="sm" onClick={importOverlays} disabled={busy}>
            <Upload className="size-3.5" /> {busy ? "Reading…" : "Import"}
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-1.5">
          {overlayAssets
            .filter((a) => a.kind !== "image")
            .map((asset) => (
              <button
                key={asset.id}
                onClick={() => {
                  const existing = overlayClips.filter(
                    (c) => c.overlay?.type === "video" && c.overlay.assetId === asset.id,
                  );
                  if (existing.length) {
                    removeClips(existing.map((c) => c.id));
                    toast.success(`${asset.name} removed`);
                    return;
                  }
                  addOverlay({ type: "video", assetId: asset.id }, asset.name, asset.duration);
                  toast.success(`${asset.name} placed on the overlay track`);
                }}
                title={`${asset.path}\n${asset.width}×${asset.height}`}
                className="flex h-16 flex-col items-start justify-center gap-0.5 rounded-md border border-border bg-rail px-2.5 text-left hover:border-primary"
              >
                <span className="flex w-full items-center gap-1 text-xs font-medium">
                  <Layers className="size-3.5 shrink-0" />
                  <span className="truncate">{asset.name}</span>
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  video · {asset.duration.toFixed(1)}s
                </span>
              </button>
            ))}
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
          Import MP4/MOV overlays with alpha (transparency) or WebM with alpha. They are placed on
          the Overlays track — drag, trim and re-blend them like any clip.
        </p>
      </section>

      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Defaults for new overlays
        </p>
        <label className="block text-xs text-muted-foreground">
          Blend mode
          <select
            value={defaultBlend}
            onChange={(e) => setDefaultBlend(e.target.value as GlobalCompositeOperation)}
            className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
          >
            {BLEND_MODES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted-foreground">
          <span className="flex justify-between">
            <span>Opacity</span>
            <span className="font-mono text-foreground">{Math.round(defaultOpacity * 100)}%</span>
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={defaultOpacity}
            onChange={(e) => setDefaultOpacity(Number(e.target.value))}
            className="mt-1 h-1 w-full appearance-none rounded-full bg-muted accent-primary"
          />
        </label>
      </section>

      {overlayClips.length > 0 && (
        <section>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            On the overlay track
          </p>
          <div className="space-y-1">
            {overlayClips.map((clip) => (
              <div
                key={clip.id}
                className="flex items-center gap-2 rounded-md border border-border bg-panel-raised px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-xs">
                  {state.assets.find((a) => a.id === (clip.overlay as { assetId?: string })?.assetId)?.name ?? clip.name}
                </span>
                <span className="font-mono text-[10px] text-muted-foreground">{clip.blend}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={() => removeClips([clip.id])}
                  title="Remove overlay"
                >
                  <Trash2 className="size-3" />
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
