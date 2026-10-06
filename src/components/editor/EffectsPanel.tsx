import { useState } from "react";
import { Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/lib/editor/store";
import type { AnimationKind, TransitionKind } from "@/lib/editor/types";

const ANIMATIONS: { id: AnimationKind; label: string }[] = [
  { id: "none", label: "None" },
  { id: "zoomIn", label: "Zoom in" },
  { id: "zoomOut", label: "Zoom out" },
  { id: "panLeft", label: "Pan left" },
  { id: "panRight", label: "Pan right" },
  { id: "panUp", label: "Pan up" },
  { id: "panDown", label: "Pan down" },
];

const TRANSITIONS: { id: TransitionKind; label: string }[] = [
  { id: "none", label: "Hard cut" },
  { id: "slideLeft", label: "Slide" },
  { id: "slideUp", label: "Slide up" },
  { id: "push", label: "Push" },
  { id: "wipe", label: "Wipe" },
  { id: "zoomPop", label: "Zoom pop" },
  { id: "flash", label: "Flash" },
];

const CYCLE: AnimationKind[] = ["zoomIn", "panRight", "zoomOut", "panLeft"];

export function EffectsPanel() {
  const { state, update, updateClips } = useEditor();
  const [amount, setAmount] = useState(0.14);
  const [transDur, setTransDur] = useState(0.3);

  /** The clips a motion command targets: the selection, or every visual clip. */
  const visualIds = () => {
    const sel = state.selectedClipIds.filter((id) =>
      state.clips.some((c) => c.id === id && (c.kind === "video" || c.kind === "overlay")),
    );
    return sel.length ? sel : state.clips.filter((c) => c.kind === "video").map((c) => c.id);
  };

  const applyAnimation = (kind: AnimationKind) => {
    const ids = visualIds();
    if (!ids.length) return toast.error("Add video clips to the timeline first");
    updateClips(ids, { animation: kind, animationAmount: amount });
    toast.success(
      kind === "none"
        ? `Animation cleared on ${ids.length} clip${ids.length > 1 ? "s" : ""}`
        : `Animation applied to ${ids.length} clip${ids.length > 1 ? "s" : ""}`,
    );
  };

  const applyTransition = (kind: TransitionKind) => {
    const ids = visualIds();
    if (!ids.length) return toast.error("Add video clips to the timeline first");
    updateClips(ids, { transition: kind, transitionDuration: transDur });
    toast.success(kind === "none" ? "Back to hard cuts" : "Transition applied");
  };

  const autoMotion = () => {
    const ids = visualIds();
    if (!ids.length) return toast.error("Add video clips to the timeline first");
    // Preserve timeline order so the motion pattern reads left to right.
    const ordered = state.clips
      .filter((c) => ids.includes(c.id))
      .sort((a, b) => a.start - b.start)
      .map((c) => c.id);
    update((s) => ({
      ...s,
      clips: s.clips.map((c) => {
        const i = ordered.indexOf(c.id);
        if (i < 0) return c;
        return { ...c, animation: CYCLE[i % CYCLE.length], animationAmount: amount };
      }),
    }));
    toast.success(`Auto motion applied to ${ordered.length} clips`);
  };

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Motion (Ken Burns)
          </p>
          <Button size="sm" onClick={autoMotion}>
            <Wand2 className="size-4" /> Auto
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          {ANIMATIONS.map((a) => (
            <Button key={a.id} size="sm" variant="secondary" onClick={() => applyAnimation(a.id)}>
              {a.label}
            </Button>
          ))}
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          Strength
          <input
            type="range"
            min={0.04}
            max={0.5}
            step={0.01}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="h-1 flex-1 appearance-none rounded-full bg-muted accent-primary"
          />
          <span className="w-8 text-right font-mono text-foreground">{Math.round(amount * 100)}%</span>
        </label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Applies to the selection, or to every video clip when nothing is selected.
        </p>
      </section>

      <section>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Transitions (snappy, no fades)
        </p>
        <div className="grid grid-cols-2 gap-2">
          {TRANSITIONS.map((t) => (
            <Button key={t.id} size="sm" variant="secondary" onClick={() => applyTransition(t.id)}>
              {t.label}
            </Button>
          ))}
        </div>
        <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          Length
          <input
            type="range"
            min={0.1}
            max={0.8}
            step={0.05}
            value={transDur}
            onChange={(e) => setTransDur(Number(e.target.value))}
            className="h-1 flex-1 appearance-none rounded-full bg-muted accent-primary"
          />
          <span className="w-10 text-right font-mono text-foreground">{transDur.toFixed(2)}s</span>
        </label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Transitions play at a clip's in-point. Neighbouring clips overlap naturally when you place
          them that way.
        </p>
      </section>
    </div>
  );
}
