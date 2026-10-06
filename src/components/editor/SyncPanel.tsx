import { useState } from "react";
import { FileText, Trash2, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { numberKey, parseScript } from "@/lib/editor/script";
import { makeClip, useEditor } from "@/lib/editor/store";
import { formatTime } from "@/lib/editor/media";
import type { Clip } from "@/lib/editor/types";

const MOTION = ["zoomIn", "panRight", "zoomOut", "panLeft"] as const;

export function SyncPanel() {
  const { state, update } = useEditor();
  const [raw, setRaw] = useState("");

  const lines = parseScript(raw);

  const loadScript = async () => {
    const opened = await window.zf?.dialog?.openScript();
    if (opened) {
      setRaw(opened.text);
      toast.success(`Loaded ${opened.path.split(/[\\/]/).pop()}`);
    }
  };

  const syncImages = () => {
    if (!lines.length) return toast.error("Paste or load a timing list first");
    const visual = state.assets
      .filter((a) => a.kind !== "audio")
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!visual.length) return toast.error("Import your images or video first");

    const videoTrack = state.tracks.find((t) => t.kind === "video");
    if (!videoTrack) return toast.error("No video track available");

    const clips: Clip[] = [];
    let matched = 0;
    lines.forEach((line, i) => {
      const key = numberKey(line.label);
      let asset = key !== null ? visual.find((a) => numberKey(a.name) === key) : undefined;
      if (asset) matched++;
      else asset = visual[i % visual.length];
      if (!asset) return;
      clips.push(
        makeClip({
          trackId: videoTrack.id,
          kind: "video",
          name: asset.name,
          assetId: asset.id,
          start: line.start,
          duration: line.duration,
          animation: MOTION[i % MOTION.length],
          animationAmount: 0.14,
        }),
      );
    });

    update((s) => ({
      ...s,
      clips: [...s.clips.filter((c) => c.trackId !== videoTrack.id), ...clips],
      selectedClipIds: [],
    }));
    toast.success(
      `Synced ${clips.length} shots (${matched} matched by file number) with motion`,
    );
  };

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto pr-1">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Script sync
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          Paste a timing list. One line per shot:
          <br />
          <span className="font-mono text-foreground">
            Image 001 | 00:00.0 - 00:05.7 (5.7s) | narration…
          </span>
          <br />
          Assets are matched by the number in their filename, otherwise in order.
        </p>
      </div>

      <div className="flex gap-2">
        <Button size="sm" variant="secondary" className="flex-1" onClick={loadScript}>
          <FileText className="size-4" /> Load .txt
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="w-24"
          onClick={() => setRaw("")}
          disabled={!raw}
        >
          Clear
        </Button>
      </div>

      <Textarea
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder={"Image 001 | 00:00.0 - 00:05.7 (5.7s) | Five women vanished…"}
        className="min-h-40 resize-none bg-panel-raised font-mono text-[11px]"
      />

      <div className="flex items-center justify-between rounded-md border border-border bg-rail px-2 py-1.5 text-[11px]">
        <span>
          <span className="font-medium">{lines.length}</span> timed lines
        </span>
        {lines.length > 0 && (
          <span className="text-muted-foreground">ends at {formatTime(lines[lines.length - 1].end)}</span>
        )}
      </div>

      <Button onClick={syncImages}>
        <Wand2 className="size-4" /> Sync assets to these timings
      </Button>

      <p className="flex items-start gap-1 text-[11px] leading-relaxed text-muted-foreground">
        <Trash2 className="mt-0.5 size-3 shrink-0" />
        Syncing replaces the video track clips with the timed shots, so you can rebuild freely.
      </p>
    </div>
  );
}
