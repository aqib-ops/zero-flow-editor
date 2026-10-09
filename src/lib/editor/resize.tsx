import * as React from "react";
import { cn } from "@/lib/utils";

export type ResizeAxis = "x" | "y";

export interface AxisResizeOptions {
  axis: ResizeAxis;
  /** Panel size at pointer-down. */
  start: number;
  /** Pointer coordinate at pointer-down. */
  origin: number;
  /**
   * Multiplier applied to the pointer delta.
   *
   * Use `-1` when the panel grows by moving the divider *against* the pointer
   * direction. A panel pinned to the bottom of the window is the case that
   * matters: its divider can never travel downward, so dragging up must grow
   * it.
   */
  sign?: 1 | -1;
  min: number;
  max: number;
  onChange: (size: number) => void;
}

/**
 * Starts a pointer-driven resize of a docked panel.
 *
 * Listens on `window` rather than the handle element because the pointer
 * routinely outruns a 6px divider at speed, and capture on the handle alone
 * would drop the gesture.
 */
export function beginAxisResize(
  event: React.PointerEvent<HTMLElement>,
  options: AxisResizeOptions,
): void {
  const { axis, start, origin, sign = 1, min, max, onChange } = options;
  event.preventDefault();
  event.stopPropagation();

  const body = document.body;
  const previousCursor = body.style.cursor;
  const previousUserSelect = body.style.userSelect;
  body.style.cursor = axis === "x" ? "col-resize" : "row-resize";
  body.style.userSelect = "none";

  let latest = start;

  const move = (ev: PointerEvent) => {
    const pointer = axis === "x" ? ev.clientX : ev.clientY;
    const next = Math.min(max, Math.max(min, start + sign * (pointer - origin)));
    if (next === latest) return;
    latest = next;
    onChange(next);
  };

  const done = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", done);
    window.removeEventListener("pointercancel", done);
    body.style.cursor = previousCursor;
    body.style.userSelect = previousUserSelect;
  };

  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", done);
  window.addEventListener("pointercancel", done);
}

/**
 * Panel size state mirrored into localStorage so the layout survives a
 * restart. These are workspace preferences, not project data, so they stay out
 * of the project file.
 */
export function useStoredSize(
  key: string,
  fallback: number,
  min: number,
  max: number,
): readonly [number, (size: number) => void] {
  const clamp = React.useCallback(
    (value: number) => Math.min(max, Math.max(min, value)),
    [max, min],
  );

  const [size, setSize] = React.useState(() => {
    try {
      const raw = Number(window.localStorage.getItem(key));
      if (Number.isFinite(raw) && raw > 0) return Math.min(max, Math.max(min, raw));
    } catch {
      /* storage blocked — fall through to the default */
    }
    return fallback;
  });

  const set = React.useCallback(
    (next: number) => {
      const clamped = clamp(next);
      setSize(clamped);
      try {
        window.localStorage.setItem(key, String(Math.round(clamped)));
      } catch {
        /* storage blocked — keep the in-memory value */
      }
    },
    [key, clamp],
  );

  return [size, set] as const;
}

interface ResizeHandleProps extends Omit<React.ComponentProps<"div">, "onDoubleClick"> {
  axis: ResizeAxis;
  label: string;
  onResizeStart: (event: React.PointerEvent<HTMLDivElement>) => void;
  onReset: () => void;
}

/**
 * The grab affordance between two docked panels.
 *
 * The visible hairline is 1px but the hit area is ~20px and bleeds a few px
 * into both neighbours via negative margin, so the divider is reachable without
 * pixel-hunting. Double-click restores the default size.
 */
export function ResizeHandle({
  axis,
  label,
  onResizeStart,
  onReset,
  className,
  ...rest
}: ResizeHandleProps) {
  const vertical = axis === "x";
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label={label}
      title={`${label} — drag to resize, double-click to reset`}
      onPointerDown={onResizeStart}
      onDoubleClick={onReset}
      className={cn(
        "group relative z-30 shrink-0 touch-none",
        vertical
          ? "-mx-1 w-2 cursor-col-resize"
          : "-my-1 h-2 cursor-row-resize",
        className,
      )}
      {...rest}
    >
      {/* full-bleed hover tint so the grab zone is discoverable */}
      <div
        className={cn(
          "absolute bg-primary/0 transition-colors group-hover:bg-primary/10 group-active:bg-primary/20",
          vertical ? "inset-y-0 left-1/2 w-px -translate-x-1/2" : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        )}
      />
      {/* structural hairline — always visible, brightens on hover */}
      <div
        className={cn(
          "absolute bg-border transition-colors group-hover:bg-primary/70 group-active:bg-primary",
          vertical ? "inset-y-0 left-1/2 w-px -translate-x-1/2" : "inset-x-0 top-1/2 h-px -translate-y-1/2",
        )}
      />
      {/* grip nub, revealed on hover */}
      <div
        className={cn(
          "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-muted-foreground/0 transition-colors group-hover:bg-muted-foreground/70",
          vertical ? "h-8 w-0.5" : "h-0.5 w-8",
        )}
      />
    </div>
  );
}