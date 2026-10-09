import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Ban,
  Wand2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useEditor } from "@/lib/editor/store";
import type { AnimationKind, Clip, TransitionKind } from "@/lib/editor/types";

const ANIMATIONS: { id: AnimationKind; label: string; Icon: typeof Ban }[] = [
  { id: "none", label: "None", Icon: Ban },
  { id: "zoomIn", label: "Zoom in", Icon: ZoomIn },
  { id: "zoomOut", label: "Zoom out", Icon: ZoomOut },
  { id: "panLeft", label: "Pan left", Icon: ArrowLeft },
  { id: "panRight", label: "Pan right", Icon: ArrowRight },
  { id: "panUp", label: "Pan up", Icon: ArrowUp },
  { id: "panDown", label: "Pan down", Icon: ArrowDown },
];

const TRANSITIONS: { id: TransitionKind; label: string; hint: string }[] = [
  { id: "none", label: "Hard cut", hint: "Instant" },
  { id: "slideLeft", label: "Slide", hint: "Left → right" },
  { id: "slideUp", label: "Slide up", hint: "Bottom → top" },
  { id: "push", label: "Push", hint: "Shoves aside" },
  { id: "wipe", label: "Wipe", hint: "Reveals" },
  { id: "zoomPop", label: "Zoom pop", hint: "Punches in" },
  { id: "flash", label: "Flash", hint: "White burst" },
];

const CYCLE: AnimationKind[] = ["zoomIn", "panRight", "zoomOut", "panLeft"];

/** Timeline order, with a stable tiebreak so distribution is deterministic. */
function byStart(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

/** Keeps first-seen order — that order becomes the cycle the clips play out. */
function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/** Collapses to one value when the selection agrees, otherwise "mixed". */
function uniform<T extends string | number>(clips: Clip[], pick: (c: Clip) => T): T | "mixed" {
  if (!clips.length) return "mixed";
  const first = pick(clips[0]);
  return clips.every((c) => pick(c) === first) ? first : "mixed";
}

/** One entry in a picker. Picked entries carry their position in the cycle. */
function Tile({
  active,
  order,
  onClick,
  title,
  children,
}: {
  active: boolean;
  order?: number;
  onClick: () => void;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-2 text-left text-xs font-medium transition-all",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary/15 text-primary shadow-[0_0_0_1px_var(--primary)]"
          : "border-border bg-secondary/60 text-secondary-foreground hover:border-primary/40 hover:bg-secondary",
      )}
    >
      {children}
      {active && order !== undefined && (
        <span className="ml-auto grid size-4 shrink-0 place-items-center rounded-full bg-primary text-[9px] font-bold text-primary-foreground">
          {order}
        </span>
      )}
    </button>
  );
}

function Slider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <label className={cn("block text-xs text-muted-foreground", disabled && "opacity-50")}>
      <span className="flex items-baseline justify-between">
        <span>{label}</span>
        <span className="font-mono text-foreground">{display}</span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1.5 h-1 w-full appearance-none rounded-full bg-muted accent-primary"
      />
    </label>
  );
}

export function EffectsPanel() {
  const { state, applyClipPatches } = useEditor();

  // The picks form an ordered cycle that spreads across clips, one per clip,
  // repeating once it runs out. At least one is always kept.
  const [anims, setAnims] = useState<AnimationKind[]>(["zoomIn"]);
  const [transs, setTranss] = useState<TransitionKind[]>(["none"]);
  const [amount, setAmount] = useState(0.14);
  const [transDur, setTransDur] = useState(0.3);

  const selected = useMemo(
    () =>
      state.clips.filter(
        (c) => state.selectedClipIds.includes(c.id) && (c.kind === "video" || c.kind === "overlay"),
      ),
    [state.clips, state.selectedClipIds],
  );
  const allVisual = useMemo(
    () => state.clips.filter((c) => c.kind === "video" || c.kind === "overlay"),
    [state.clips],
  );
  const selKey = selected.map((c) => c.id).join(",");

  // Seed from the selection so the tiles show what those clips already do.
  // Keyed on the set alone, so a later move or trim can't revert a choice the
  // user has picked but not yet applied.
  useEffect(() => {
    if (!selected.length) return;
    const ordered = byStart(selected);
    setAnims(unique(ordered.map((c) => c.animation)));
    setTranss(unique(ordered.map((c) => c.transition)));
    const amt = uniform(ordered, (c) => c.animationAmount);
    if (amt !== "mixed") setAmount(amt);
    const dur = uniform(ordered, (c) => c.transitionDuration);
    if (dur !== "mixed") setTransDur(dur);
  }, [selKey]);

  const toggleAnim = (id: AnimationKind) =>
    setAnims((cur) =>
      cur.includes(id) ? (cur.length > 1 ? cur.filter((x) => x !== id) : cur) : [...cur, id],
    );
  const toggleTrans = (id: TransitionKind) =>
    setTranss((cur) =>
      cur.includes(id) ? (cur.length > 1 ? cur.filter((x) => x !== id) : cur) : [...cur, id],
    );

  const applyTo = (ids: string[], scope: string) => {
    if (!ids.length) return toast.error("Add video clips to the timeline first");
    const wanted = new Set(ids);
    const ordered = byStart(state.clips.filter((c) => wanted.has(c.id)));
    applyClipPatches(
      ordered.map((c, i) => ({
        id: c.id,
        patch: {
          animation: anims[i % anims.length],
          animationAmount: amount,
          transition: transs[i % transs.length],
          transitionDuration: transDur,
        },
      })),
    );
    toast.success(`Applied to ${ordered.length} clip${ordered.length > 1 ? "s" : ""} · ${scope}`);
  };

  const loadCyclePreset = () => {
    setAnims(CYCLE.slice());
    toast.info("Loaded a 4-motion cycle — click tiles to adjust the order");
  };

  const animLabels = anims.map((id) => ANIMATIONS.find((a) => a.id === id)?.label ?? id);
  const transLabels = transs.map((id) => TRANSITIONS.find((t) => t.id === id)?.label ?? id);
  const transIsOff = transs.length === 1 && transs[0] === "none";
  const selectedNote = selected.length
    ? `${selected.length} clip${selected.length > 1 ? "s" : ""} selected`
    : "Nothing selected";

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto pr-1">
      <section>
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Motion <span className="normal-case tracking-normal">(Ken Burns)</span>
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={loadCyclePreset}
            title="Fill with a standard 4-motion cycle"
          >
            <Wand2 className="size-4" /> Cycle
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {ANIMATIONS.map(({ id, label, Icon }) => {
            const i = anims.indexOf(id);
            return (
              <Tile
                key={id}
                title={i >= 0 ? `${label} — position ${i + 1} in the cycle` : label}
                active={i >= 0}
                order={i + 1}
                onClick={() => toggleAnim(id)}
              >
                <Icon className="size-4 shrink-0" />
                <span className="min-w-0 truncate">{label}</span>
              </Tile>
            );
          })}
        </div>

        <div className="mt-3">
          <Slider
            label="Strength"
            value={amount}
            display={`${Math.round(amount * 100)}%`}
            min={0.04}
            max={0.5}
            step={0.01}
            onChange={setAmount}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Click several — clips cycle through them in order.
        </p>
      </section>

      <section>
        <p className="mb-2.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Transition
        </p>
        <div className="grid grid-cols-2 gap-2">
          {TRANSITIONS.map(({ id, label, hint }) => {
            const i = transs.indexOf(id);
            return (
              <Tile
                key={id}
                title={i >= 0 ? `${hint} — position ${i + 1} in the cycle` : hint}
                active={i >= 0}
                order={i + 1}
                onClick={() => toggleTrans(id)}
              >
                <span className="min-w-0">
                  <span className="block truncate">{label}</span>
                  <span className="block truncate text-[10px] font-normal text-muted-foreground">
                    {hint}
                  </span>
                </span>
              </Tile>
            );
          })}
        </div>

        <div className="mt-3">
          <Slider
            label="Length"
            value={transDur}
            display={`${transDur.toFixed(2)}s`}
            min={0.1}
            max={0.8}
            step={0.05}
            onChange={setTransDur}
            disabled={transIsOff}
          />
        </div>
        <p className="mt-1.5 text-[11px] text-muted-foreground">
          Transitions play at a clip's in-point.
        </p>
      </section>

      <section className="mt-auto border-t border-border pt-4">
        <div className="mb-2.5 flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Apply
          </p>
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-medium",
              selected.length
                ? "bg-primary/15 text-primary"
                : "bg-secondary text-muted-foreground",
            )}
          >
            {selectedNote}
          </span>
        </div>

        <div className="mb-3 space-y-1 text-[11px] text-muted-foreground">
          <p>
            Motion <span className="text-foreground">{animLabels.join(" → ")}</span>{" "}
            {Math.round(amount * 100)}%
          </p>
          <p>
            Transition <span className="text-foreground">{transLabels.join(" → ")}</span>{" "}
            {transIsOff ? "" : `${transDur.toFixed(2)}s`}
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            disabled={!selected.length}
            onClick={() => applyTo(selected.map((c) => c.id), "selection")}
          >
            Apply to selection
          </Button>
          <Button
            size="sm"
            variant="secondary"
            disabled={!allVisual.length}
            onClick={() => applyTo(allVisual.map((c) => c.id), "all clips")}
          >
            Apply to all
          </Button>
        </div>
      </section>
    </div>
  );
}
