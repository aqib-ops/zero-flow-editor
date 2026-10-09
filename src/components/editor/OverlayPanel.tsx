import { useCallback, useState } from "react";
import { Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { assetFromPath } from "@/lib/editor/media";
import { makeClip, useEditor } from "@/lib/editor/store";
import { projectDuration } from "@/lib/editor/render";
import { BLEND_MODES } from "@/lib/editor/styles";
import { cn } from "@/lib/utils";
import type { OverlaySource } from "@/lib/editor/types";

/**
 * Overlay hosting.
 *
 * Overlays are imported straight onto the Overlays track — the panel only
 * deals with clips actually placed there, never the general media library.
 * Select one to edit its opacity and blend mode.
 */
export function OverlayPanel() {
  const { state, addAssets, addClips, removeClips, select, updateClip } = useEditor();
  const [busy, setBusy] = useState(false);

  const overlayTrack = state.tracks.find((t) => t.kind === "overlay");
  const total = projectDuration(state.clips);
  const overlayClips = state.clips.filter((c) => c.kind === "overlay");

  // The overlay clip currently edited in the Appearance section.
  const selectedOverlay = state.clips.find(
    (c) => c.kind === "overlay" && state.selectedClipIds.includes(c.id),
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
      if (!assets.length) {
        toast.error("No supported overlay media found");
        return;
      }
      addAssets(assets);
      if (!overlayTrack) {
        toast.error("No overlay track available");
        return;
      }
      // Place each imported file directly onto the overlay track.
      const clips = assets.map((asset) => {
        const source: OverlaySource =
          asset.kind === "image"
            ? { type: "image", assetId: asset.id }
            : { type: "video", assetId: asset.id };
        return makeClip({
          trackId: overlayTrack.id,
          kind: "overlay",
          name: asset.name,
          start: 0,
          duration: asset.duration || total > 0 ? total : 4,
          opacity: 1,
          blend: "screen",
          overlay: source,
        });
      });
      addClips(clips);
      select([clips[0]?.id].filter(Boolean) as string[]);
      toast.success(`Imported ${assets.length} overlay file${assets.length > 1 ? "s" : ""}`);
    } finally {
      setBusy(false);
    }
  }, [addAssets, addClips, overlayTrack, select, total]);

  const setOpacity = (v: number) => {
    if (!selectedOverlay) return;
    updateClip(selectedOverlay.id, { opacity: Math.min(1, Math.max(0, v)) });
  };

  const setBlend = (blend: GlobalCompositeOperation) => {
    if (!selectedOverlay) return;
    updateClip(selectedOverlay.id, { blend });
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Overlays
          </p>
          <Button size="sm" onClick={importOverlays} disabled={busy}>
            <Upload className="size-3.5" /> {busy ? "Reading…" : "Import"}
          </Button>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Import MP4/MOV/WebM with alpha (transparency), or stills. Each file is placed on the
          Overlays track — drag, trim and re-blend them like any clip.
        </p>
      </section>

      <section className="space-y-3 rounded-md border border-border bg-panel-raised p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Overlay appearance
        </p>

        {selectedOverlay ? (
          <>
            <div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Opacity</span>
                <span className="font-mono text-xs text-foreground">
                  {Math.round(selectedOverlay.opacity * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={selectedOverlay.opacity}
                onChange={(e) => setOpacity(Number(e.target.value))}
                className="mt-1.5 h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(selectedOverlay.opacity * 100)}
                  onChange={(e) => setOpacity(Number(e.target.value) / 100)}
                  className="h-7 w-16 rounded-md border border-input bg-background px-2 text-right font-mono text-xs text-foreground"
                  aria-label="Opacity percent"
                />
                <span className="text-[11px] text-muted-foreground">%</span>
                <div className="ml-auto flex gap-1">
                  {[0, 25, 50, 75, 100].map((p) => (
                    <button
                      key={p}
                      onClick={() => setOpacity(p / 100)}
                      className={cn(
                        "rounded border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                        Math.round(selectedOverlay.opacity * 100) === p
                          ? "border-primary bg-primary/15 text-foreground"
                          : "border-border bg-rail text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <span className="text-xs text-muted-foreground">Blend mode</span>
              <div className="mt-1.5 grid grid-cols-2 gap-1">
                {BLEND_MODES.map((b) => (
                  <button
                    key={b}
                    onClick={() => setBlend(b)}
                    className={cn(
                      "rounded-md border px-2 py-1.5 text-left font-mono text-[11px] transition-colors",
                      b === selectedOverlay.blend
                        ? "border-primary bg-primary/15 text-foreground"
                        : "border-border bg-rail text-muted-foreground hover:border-primary/60 hover:text-foreground",
                    )}
                  >
                    {b}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Select an overlay on the timeline to edit its opacity and blend mode here.
          </p>
        )}
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
                  onClick={() => removeClips([clip.id], false)}
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
