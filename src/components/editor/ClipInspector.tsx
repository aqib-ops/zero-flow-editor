import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/editor/store";
import { BLEND_MODES, CAPTION_STYLES, TEXT_ANCHORS } from "@/lib/editor/styles";
import { baseName } from "@/lib/editor/media";
import type { Clip, TextAnchor } from "@/lib/editor/types";
import type { BuiltinOverlayKind } from "@/lib/editor/types";

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="block text-xs text-muted-foreground">
      <span className="flex justify-between">
        <span>{label}</span>
        <span className="font-mono text-foreground">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 h-1 w-full appearance-none rounded-full bg-muted accent-primary"
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="grid grid-cols-[1fr_5rem] items-center gap-2 text-xs text-muted-foreground">
      <span>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(2))}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-7 rounded-md border border-input bg-background px-2 text-right font-mono text-xs text-foreground"
      />
    </label>
  );
}

export function ClipInspector() {
  const { state, updateClip, removeClips } = useEditor();
  const clip = state.clips.find((item) => state.selectedClipIds.includes(item.id));

  if (!clip) {
    return (
      <div className="grid h-full place-items-center px-4 text-center text-sm text-muted-foreground">
        Select a clip in the timeline to edit it.
      </div>
    );
  }

  const change = <K extends keyof Clip>(key: K, value: Clip[K]) => updateClip(clip.id, { [key]: value });
  // Imported overlays keep their media id on the overlay source, not on
  // `clip.assetId`, so resolve both shapes here.
  const overlayAsset =
    clip.overlay && clip.overlay.type !== "builtin"
      ? state.assets.find((a) => a.id === (clip.overlay as { assetId: string }).assetId)
      : undefined;
  const asset = state.assets.find((a) => a.id === clip.assetId) ?? overlayAsset;
  const clipEnd = clip.start + clip.duration;

  const copyTimecode = async () => {
    const stamp = `${formatClock(clip.start)} - ${formatClock(clipEnd)}`;
    try {
      await navigator.clipboard.writeText(stamp);
      toast.success(`Copied ${stamp}`);
    } catch {
      toast.error("Could not copy to clipboard");
    }
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <div className="border-b border-border pb-3">
        <p className="truncate text-sm font-semibold" title={clip.name}>
          {clip.kind === "text" ? clip.text?.slice(0, 40) || "Text" : clip.name}
        </p>
        <p className="mt-0.5 text-xs capitalize text-muted-foreground">
          {clip.kind} clip
          {asset && ` · ${baseName(asset.path)}`}
        </p>
        {clip.kind === "overlay" && clip.overlay && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {clip.overlay.type === "builtin"
              ? `Built-in: ${(clip.overlay as { kind: BuiltinOverlayKind }).kind}`
              : `Imported: ${overlayAsset?.name ?? "missing file"}`}
          </p>
        )}
      </div>

      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Timing</p>
        <NumberField label="Start (s)" value={clip.start} min={0} step={0.05} onChange={(v) => change("start", Math.max(0, v))} />
        <NumberField
          label="Duration (s)"
          value={clip.duration}
          min={0.1}
          step={0.05}
          onChange={(v) => change("duration", Math.max(0.1, v))}
        />
        {clip.kind !== "overlay" && (
          <NumberField
            label="Speed"
            value={clip.speed}
            min={0.25}
            max={4}
            step={0.05}
            onChange={(v) => change("speed", Math.min(4, Math.max(0.25, v)))}
          />
        )}
        {(clip.kind === "audio" || clip.kind === "video") && (
          <Slider
            label="Volume"
            value={clip.volume}
            display={`${Math.round(clip.volume * 100)}%`}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => change("volume", v)}
          />
        )}
        {asset && (asset.kind === "video" || asset.kind === "audio") && (
          <NumberField
            label={`Trim in (s) · source ${asset.duration.toFixed(1)}s`}
            value={clip.offset}
            min={0}
            step={0.05}
            onChange={(v) => change("offset", Math.max(0, v))}
          />
        )}
        <Button size="sm" variant="ghost" className="h-7 w-full" onClick={copyTimecode}>
          Copy timecode
        </Button>
      </section>

      <section className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Appearance
        </p>
        <Slider
          label="Opacity"
          value={clip.opacity}
          display={`${Math.round(clip.opacity * 100)}%`}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => change("opacity", v)}
        />
        {(clip.kind === "overlay" || clip.kind === "video") && (
          <label className="block text-xs text-muted-foreground">
            Blend mode
            <select
              value={clip.blend}
              onChange={(e) => change("blend", e.target.value as GlobalCompositeOperation)}
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              {BLEND_MODES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {(clip.kind === "video" || clip.kind === "overlay") && (
        <section className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Motion & transition
          </p>
          <label className="block text-xs text-muted-foreground">
            Animation
            <select
              value={clip.animation}
              onChange={(e) => change("animation", e.target.value as Clip["animation"])}
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              {["none", "zoomIn", "zoomOut", "panLeft", "panRight", "panUp", "panDown"].map((a) => (
                <option key={a} value={a}>
                  {a === "none" ? "None" : a}
                </option>
              ))}
            </select>
          </label>
          <Slider
            label="Motion amount"
            value={clip.animationAmount}
            display={`${Math.round(clip.animationAmount * 100)}%`}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(v) => change("animationAmount", v)}
          />
          <label className="block text-xs text-muted-foreground">
            Transition in
            <select
              value={clip.transition}
              onChange={(e) => change("transition", e.target.value as Clip["transition"])}
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              {["none", "slideLeft", "slideUp", "wipe", "push", "flash", "zoomPop"].map((t) => (
                <option key={t} value={t}>
                  {t === "none" ? "Hard cut" : t}
                </option>
              ))}
            </select>
          </label>
          <Slider
            label="Transition length"
            value={clip.transitionDuration}
            display={`${clip.transitionDuration.toFixed(2)}s`}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(v) => change("transitionDuration", v)}
          />
        </section>
      )}

      {clip.kind === "text" && (
        <section className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Text</p>
          <textarea
            value={clip.text ?? ""}
            onChange={(e) => change("text", e.target.value)}
            placeholder="Caption text…"
            className="min-h-24 w-full resize-y rounded-md border border-input bg-background p-2 text-sm text-foreground"
          />
          <label className="block text-xs text-muted-foreground">
            Caption style
            <select
              value={clip.styleId}
              onChange={(e) => change("styleId", e.target.value)}
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              {CAPTION_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <Slider
            label="Size multiplier"
            value={clip.sizeScale ?? 1}
            display={`${Math.round((clip.sizeScale ?? 1) * 100)}%`}
            min={0.4}
            max={2.5}
            step={0.05}
            onChange={(v) => change("sizeScale", v)}
          />
          <Slider
            label="Letter spacing (chars)"
            value={clip.letterSpacing ?? 0}
            display={`${clip.letterSpacing ?? 0}px`}
            min={-2}
            max={16}
            step={0.5}
            onChange={(v) => change("letterSpacing", v)}
          />
          <Slider
            label="Word spacing"
            value={clip.wordSpacing ?? 0}
            display={`${clip.wordSpacing ?? 0}px`}
            min={-4}
            max={24}
            step={1}
            onChange={(v) => change("wordSpacing", v)}
          />
          <Slider
            label="Line spacing"
            value={clip.lineHeight ?? 1.18}
            display={`${(clip.lineHeight ?? 1.18).toFixed(2)}x`}
            min={1.0}
            max={2.0}
            step={0.05}
            onChange={(v) => change("lineHeight", v)}
          />
          <label className="block text-xs text-muted-foreground">
            Position
            <select
              value={clip.anchor ?? "bottom"}
              onChange={(e) => change("anchor", e.target.value as TextAnchor)}
              className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2 text-xs text-foreground"
            >
              {TEXT_ANCHORS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center justify-between pt-1">
            <span className="text-xs text-muted-foreground">Layout</span>
            <label className="flex items-center gap-1.5 text-xs text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={clip.singleLine ?? true}
                onChange={(e) => change("singleLine", e.target.checked)}
                className="accent-primary"
              />
              One-line auto-fit
            </label>
          </div>
        </section>
      )}

      <div className="rounded-md border border-border bg-rail p-2 text-[11px] text-muted-foreground">
        <div className="flex justify-between">
          <span>On screen</span>
          <span className="font-mono text-foreground">
            {formatClock(clip.start)} → {formatClock(clipEnd)}
          </span>
        </div>
        <div className="mt-1 flex justify-between">
          <span>Track</span>
          <span className="text-foreground">{state.tracks.find((t) => t.id === clip.trackId)?.name}</span>
        </div>
      </div>

      <Button
        variant="destructive"
        size="sm"
        className="mt-auto"
        onClick={() => removeClips([clip.id], false)}
      >
        <Trash2 className="size-4" /> Delete clip
      </Button>
    </div>
  );
}

function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}
