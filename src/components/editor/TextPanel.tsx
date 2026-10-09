import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Loader2, SlidersHorizontal, Sparkles, Wand2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CAPTION_STYLES, TEXT_ANCHORS } from "@/lib/editor/styles";
import { makeClip, useEditor } from "@/lib/editor/store";
import { chunkCaption } from "@/lib/editor/script";
import { CAPTIONS_MODELS, getCaptionsModel } from "@/lib/editor/captions";
import { projectDuration } from "@/lib/editor/render";
import type { TextAnchor, TransitionKind } from "@/lib/editor/types";

const MOTION_OPTIONS: { id: TransitionKind; label: string; badge?: string }[] = [
  { id: "fade", label: "Smooth Fade", badge: "Clean" },
  { id: "none", label: "None (Static)", badge: "No bounce" },
  { id: "slideUp", label: "Slide Up" },
  { id: "slideLeft", label: "Slide Left" },
  { id: "push", label: "Punch In" },
  { id: "flash", label: "Flash" },
  { id: "zoomPop", label: "Elastic Pop" },
];

export function TextPanel() {
  const { state, addClips, updateClips } = useEditor();
  const [styleId, setStyleId] = useState(CAPTION_STYLES[0].id);
  const [maxWords, setMaxWords] = useState(3);
  const [anchor, setAnchor] = useState<TextAnchor>("bottom");
  const [singleLine, setSingleLine] = useState(true);
  const [motion, setMotion] = useState<TransitionKind>("fade");
  const [sizeScale, setSizeScale] = useState(1);
  const [letterSpacing, setLetterSpacing] = useState(0);
  const [wordSpacing, setWordSpacing] = useState(0);
  const [lineHeight, setLineHeight] = useState(1.18);
  const [transcribing, setTranscribing] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [animationOpen, setAnimationOpen] = useState(false);
  const [typographyOpen, setTypographyOpen] = useState(false);

  const textTrack = state.tracks.find((t) => t.kind === "text");
  const total = projectDuration(state.clips);
  const captionCount = state.clips.filter((c) => c.kind === "text").length;

  // Read live from Settings → Captions. Not reactive, but every render after a
  // settings change picks the new value up, which is close enough for a label.
  const modelId = getCaptionsModel();
  const modelLabel =
    CAPTIONS_MODELS.find((m) => m.id === modelId)?.label ?? modelId;

  const applyMotionToTimeline = (newMotion: TransitionKind) => {
    setMotion(newMotion);
    const ids = state.clips.filter((c) => c.kind === "text").map((c) => c.id);
    if (ids.length > 0) {
      updateClips(ids, {
        transition: newMotion,
        transitionDuration: newMotion === "fade" ? 0.16 : 0.22,
      });
      toast.success(`Applied "${newMotion}" animation to all ${ids.length} captions`);
    }
  };

  const applyStyleToTimeline = (newStyleId: string) => {
    setStyleId(newStyleId);
    const ids = state.clips.filter((c) => c.kind === "text").map((c) => c.id);
    if (ids.length > 0) {
      updateClips(ids, {
        styleId: newStyleId,
      });
      toast.success(`Applied template to all ${ids.length} captions`);
    }
  };

  const applyTypographyToTimeline = (updates: {
    sizeScale?: number;
    letterSpacing?: number;
    wordSpacing?: number;
    lineHeight?: number;
  }) => {
    if (updates.sizeScale !== undefined) setSizeScale(updates.sizeScale);
    if (updates.letterSpacing !== undefined) setLetterSpacing(updates.letterSpacing);
    if (updates.wordSpacing !== undefined) setWordSpacing(updates.wordSpacing);
    if (updates.lineHeight !== undefined) setLineHeight(updates.lineHeight);

    const ids = state.clips.filter((c) => c.kind === "text").map((c) => c.id);
    if (ids.length > 0) {
      updateClips(ids, updates);
    }
  };

  const applyAllSettings = () => {
    const ids = state.clips.filter((c) => c.kind === "text").map((c) => c.id);
    if (!ids.length) return toast.error("No captions on timeline yet");
    updateClips(ids, {
      styleId,
      anchor,
      singleLine,
      sizeScale,
      letterSpacing,
      wordSpacing,
      lineHeight,
      transition: motion,
      transitionDuration: motion === "fade" ? 0.16 : 0.22,
    });
    toast.success(`Template, size (${Math.round(sizeScale * 100)}%), spacing, and ${motion} motion applied to ${ids.length} captions`);
  };

  /**
   * Automatically transcribes the timeline audio with the local faster-whisper
   * runtime, using whichever model size is selected in Settings → Captions.
   */
  const autoTranscribeWithWhisper = async () => {
    if (transcribing) return;
    if (!textTrack) return toast.error("No caption track available");

    // Identify audio source from timeline or imported media
    const audioClips = state.clips.filter(
      (c) => c.kind === "audio" || (c.kind === "video" && c.assetId),
    );
    let targetAsset = state.assets.find((a) =>
      audioClips.some((c) => c.assetId === a.id && (a.hasAudio || a.kind === "audio")),
    );

    if (!targetAsset) {
      targetAsset = state.assets.find((a) => a.hasAudio || a.kind === "audio");
    }

    if (!targetAsset) {
      return toast.error("Please import a video or audio file with speech first");
    }

    setTranscribing(true);
    const toastId = toast.loading(
      `Transcribing "${targetAsset.name}" with local Whisper ${modelLabel}…`,
    );

    try {
      if (!window.zf?.whisper?.transcribe) {
        throw new Error("Local Whisper bridge not ready. Please restart the app.");
      }

      const res = await window.zf.whisper.transcribe(targetAsset.path, modelId);

      if (!res.ok || !res.segments || res.segments.length === 0) {
        throw new Error(res.error || "No speech detected in this media file.");
      }

      // Generate punchy 1-3 word caption cards from the Whisper segments
      const generatedClips = [];
      for (const seg of res.segments) {
        const text = seg.text.trim();
        if (!text) continue;

        const chunks = chunkCaption(text, maxWords);
        const words = text.split(/\s+/).filter(Boolean);
        const totalWords = Math.max(1, words.length);
        let cursor = seg.start;

        for (const chunk of chunks) {
          const w = chunk.split(/\s+/).filter(Boolean).length;
          const dur = Math.max(0.35, (w / totalWords) * seg.duration);
          generatedClips.push(
            makeClip({
              trackId: textTrack.id,
              kind: "text",
              name: chunk.slice(0, 16),
              start: cursor,
              duration: Math.min(dur, Math.max(0.35, seg.end - cursor)),
              text: chunk,
              styleId,
              sizeScale,
              letterSpacing,
              wordSpacing,
              lineHeight,
              anchor,
              singleLine: true,
              transition: motion,
              transitionDuration: motion === "fade" ? 0.16 : 0.22,
            }),
          );
          cursor += dur;
        }
      }

      if (generatedClips.length > 0) {
        addClips(generatedClips);
        toast.success(
          `✨ Generated ${generatedClips.length} one-line captions with Whisper ${modelLabel}!`,
          { id: toastId },
        );
      } else {
        toast.error("Could not parse speech segments into captions", { id: toastId });
      }
    } catch (err) {
      toast.error((err as Error).message || "Whisper transcription failed", { id: toastId });
    } finally {
      setTranscribing(false);
    }
  };

  return (
    <div className="h-full min-h-0 space-y-3 overflow-y-auto pr-1">
      {/* ⚡ Instant local caption generation */}
      <div className="relative overflow-hidden rounded-xl border border-primary/40 bg-gradient-to-br from-primary/20 via-background to-panel p-3.5 shadow-lg">
        <div className="flex items-center justify-between mb-1.5">
          <span className="flex items-center gap-1.5 text-xs font-bold text-primary">
            <Sparkles className="size-4 text-primary animate-pulse" />
            AI Auto-Captions
          </span>
          <span className="rounded-full bg-primary/20 px-2 py-0.5 text-[9px] font-bold tracking-wider text-primary uppercase border border-primary/30">
            Local Whisper · {modelLabel}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground mb-3 leading-relaxed">
          Transcribe your video speech into animated one-line CapCut captions offline.
        </p>
        <Button
          size="sm"
          onClick={autoTranscribeWithWhisper}
          disabled={transcribing}
          className="w-full bg-primary hover:bg-primary/90 font-semibold text-primary-foreground shadow-md transition-all hover:scale-[1.01]"
        >
          {transcribing ? (
            <>
              <Loader2 className="size-4 animate-spin mr-2" />
              Transcribing audio with Whisper…
            </>
          ) : (
            <>
              <Zap className="size-4 mr-1.5 text-yellow-300 fill-yellow-300" />
              Auto-Generate Captions
            </>
          )}
        </Button>
      </div>

      {/* Foldable Animation Section */}
      <div className="rounded-lg border border-border/80 bg-panel-raised/60 overflow-hidden shadow-sm">
        <button
          type="button"
          onClick={() => setAnimationOpen((prev) => !prev)}
          className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-rail/50 transition-colors cursor-pointer"
        >
          <span className="text-xs font-semibold tracking-tight text-foreground flex items-center gap-1.5">
            <Sparkles className="size-3.5 text-primary" />
            Caption Animation
            <span className="text-[10px] font-mono text-primary font-medium capitalize bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">
              {motion === "none" ? "Static (No Motion)" : motion}
            </span>
          </span>
          {animationOpen ? (
            <ChevronUp className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          )}
        </button>

        {animationOpen && (
          <div className="p-2.5 pt-1.5 border-t border-border/50 space-y-1.5">
            <div className="grid grid-cols-3 gap-1.5">
              {MOTION_OPTIONS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => applyMotionToTimeline(m.id)}
                  className={cn(
                    "flex flex-col items-center justify-center rounded-md border py-1.5 px-1 text-center transition-all cursor-pointer",
                    motion === m.id
                      ? "border-primary bg-primary text-primary-foreground font-bold shadow-sm"
                      : "border-border/80 bg-background hover:bg-rail hover:text-foreground text-muted-foreground",
                  )}
                >
                  <span className="text-[11px] leading-tight font-medium">{m.label}</span>
                  {m.badge && (
                    <span
                      className={cn(
                        "text-[8px] mt-0.5",
                        motion === m.id ? "text-primary-foreground/90 font-medium" : "text-muted-foreground",
                      )}
                    >
                      {m.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Foldable Size & Spacing Section */}
      <div className="rounded-lg border border-border/80 bg-panel-raised/60 overflow-hidden shadow-sm">
        <button
          type="button"
          onClick={() => setTypographyOpen((prev) => !prev)}
          className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-rail/50 transition-colors cursor-pointer"
        >
          <span className="text-xs font-semibold tracking-tight text-foreground flex items-center gap-1.5">
            <SlidersHorizontal className="size-3.5 text-primary" />
            Size & Spacing
            <span className="text-[10px] font-mono text-primary font-medium bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded">
              {Math.round(sizeScale * 100)}% · L:{letterSpacing > 0 ? `+${letterSpacing}` : letterSpacing}px · W:{wordSpacing > 0 ? `+${wordSpacing}` : wordSpacing}px
            </span>
          </span>
          {typographyOpen ? (
            <ChevronUp className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          )}
        </button>

        {typographyOpen && (
          <div className="p-3 pt-2 space-y-3 border-t border-border/50">
            {/* Font Size Scale */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground font-medium">Font Size</span>
                <span className="font-mono font-bold text-foreground bg-rail px-1.5 py-0.5 rounded text-[11px]">
                  {Math.round(sizeScale * 100)}%
                </span>
              </div>
              <input
                type="range"
                min={0.5}
                max={2.4}
                step={0.05}
                value={sizeScale}
                onChange={(e) => applyTypographyToTimeline({ sizeScale: Number(e.target.value) })}
                className="h-1.5 w-full appearance-none rounded-full bg-muted accent-primary cursor-pointer"
              />
              <div className="flex gap-1 pt-0.5">
                {[
                  { label: "75%", val: 0.75 },
                  { label: "100%", val: 1.0 },
                  { label: "125%", val: 1.25 },
                  { label: "150%", val: 1.5 },
                  { label: "180%", val: 1.8 },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => applyTypographyToTimeline({ sizeScale: item.val })}
                    className={cn(
                      "flex-1 rounded border px-1 py-0.5 text-[9px] font-mono transition-colors cursor-pointer",
                      Math.abs(sizeScale - item.val) < 0.02
                        ? "border-primary bg-primary text-primary-foreground font-bold shadow-sm"
                        : "border-border bg-rail text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Character Spacing (Letter Spacing) */}
            <div className="space-y-1.5 pt-2 border-t border-border/40">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground font-medium">Letter Spacing (Chars)</span>
                <span className="font-mono font-bold text-foreground bg-rail px-1.5 py-0.5 rounded text-[11px]">
                  {letterSpacing > 0 ? `+${letterSpacing}px` : `${letterSpacing}px`}
                </span>
              </div>
              <input
                type="range"
                min={-2}
                max={16}
                step={0.5}
                value={letterSpacing}
                onChange={(e) => applyTypographyToTimeline({ letterSpacing: Number(e.target.value) })}
                className="h-1.5 w-full appearance-none rounded-full bg-muted accent-primary cursor-pointer"
              />
              <div className="flex gap-1 pt-0.5">
                {[
                  { label: "Tight (-1)", val: -1 },
                  { label: "Normal (0)", val: 0 },
                  { label: "Wide (+3)", val: 3 },
                  { label: "Cinema (+6)", val: 6 },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => applyTypographyToTimeline({ letterSpacing: item.val })}
                    className={cn(
                      "flex-1 rounded border px-1 py-0.5 text-[9px] font-medium transition-colors cursor-pointer",
                      letterSpacing === item.val
                        ? "border-primary bg-primary text-primary-foreground font-bold shadow-sm"
                        : "border-border bg-rail text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Space Between Words */}
            <div className="space-y-1.5 pt-2 border-t border-border/40">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground font-medium">Space Between Words</span>
                <span className="font-mono font-bold text-foreground bg-rail px-1.5 py-0.5 rounded text-[11px]">
                  {wordSpacing > 0 ? `+${wordSpacing}px` : `${wordSpacing}px`}
                </span>
              </div>
              <input
                type="range"
                min={-4}
                max={24}
                step={1}
                value={wordSpacing}
                onChange={(e) => applyTypographyToTimeline({ wordSpacing: Number(e.target.value) })}
                className="h-1.5 w-full appearance-none rounded-full bg-muted accent-primary cursor-pointer"
              />
              <div className="flex gap-1 pt-0.5">
                {[
                  { label: "Compact (-2)", val: -2 },
                  { label: "Normal (0)", val: 0 },
                  { label: "Open (+6)", val: 6 },
                  { label: "Spacious (+12)", val: 12 },
                ].map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => applyTypographyToTimeline({ wordSpacing: item.val })}
                    className={cn(
                      "flex-1 rounded border px-1 py-0.5 text-[9px] font-medium transition-colors cursor-pointer",
                      wordSpacing === item.val
                        ? "border-primary bg-primary text-primary-foreground font-bold shadow-sm"
                        : "border-border bg-rail text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Line Spacing */}
            <div className="space-y-1.5 pt-2 border-t border-border/40">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground font-medium">Line Spacing (Height)</span>
                <span className="font-mono font-bold text-foreground bg-rail px-1.5 py-0.5 rounded text-[11px]">
                  {lineHeight.toFixed(2)}x
                </span>
              </div>
              <input
                type="range"
                min={1.0}
                max={1.8}
                step={0.05}
                value={lineHeight}
                onChange={(e) => applyTypographyToTimeline({ lineHeight: Number(e.target.value) })}
                className="h-1.5 w-full appearance-none rounded-full bg-muted accent-primary cursor-pointer"
              />
            </div>
          </div>
        )}
      </div>

      {/* Foldable Settings Section */}
      <div className="rounded-lg border border-border/80 bg-panel-raised/60 overflow-hidden shadow-sm">
        <button
          type="button"
          onClick={() => setSettingsOpen((prev) => !prev)}
          className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-rail/50 transition-colors"
        >
          <span className="text-xs font-semibold tracking-tight text-foreground flex items-center gap-1.5">
            More Options
            <span className="text-[10px] font-normal text-muted-foreground">
              ({maxWords} words/card · {singleLine ? "1-line" : "wrap"} · {anchor})
            </span>
          </span>
          {settingsOpen ? (
            <ChevronUp className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 text-muted-foreground" />
          )}
        </button>

        {settingsOpen && (
          <div className="p-3 pt-1 space-y-2.5 border-t border-border/50">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Words per card: <span className="font-mono text-foreground font-bold">{maxWords}</span>
              </span>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={singleLine}
                  onChange={(e) => setSingleLine(e.target.checked)}
                  className="accent-primary rounded"
                />
                One-line auto-fit
              </label>
            </div>

            {/* Quick Word Count Chips */}
            <div className="flex gap-1">
              {[
                { count: 1, label: "1 Word" },
                { count: 2, label: "2 Words" },
                { count: 3, label: "3 Words (Ideal)" },
                { count: 4, label: "4 Words" },
              ].map((chip) => (
                <button
                  key={chip.count}
                  type="button"
                  onClick={() => {
                    setMaxWords(chip.count);
                    if (chip.count <= 3) setSingleLine(true);
                  }}
                  className={cn(
                    "flex-1 rounded border px-1 py-1 text-[10px] font-medium transition-colors",
                    maxWords === chip.count
                      ? "border-primary bg-primary text-primary-foreground font-bold shadow-sm"
                      : "border-border bg-rail text-muted-foreground hover:text-foreground",
                  )}
                >
                  {chip.label}
                </button>
              ))}
            </div>

            {/* Screen Position */}
            <div className="pt-1 border-t border-border/50">
              <label className="text-[11px] text-muted-foreground">
                Screen position
                <select
                  value={anchor}
                  onChange={(e) => {
                    const newAnchor = e.target.value as TextAnchor;
                    setAnchor(newAnchor);
                    const ids = state.clips.filter((c) => c.kind === "text").map((c) => c.id);
                    if (ids.length > 0) updateClips(ids, { anchor: newAnchor });
                  }}
                  className="mt-1 h-7 w-full rounded-md border border-input bg-background px-1.5 text-xs text-foreground font-medium"
                >
                  {TEXT_ANCHORS.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        )}
      </div>

      {/* CapCut Templates Grid */}
      <div className="pr-1">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            CapCut Caption Templates
          </p>
          <span className="text-[10px] text-muted-foreground font-mono">
            {captionCount} active
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {CAPTION_STYLES.map((s) => (
            <button
              key={s.id}
              onClick={() => applyStyleToTimeline(s.id)}
              className={cn(
                "group relative flex h-16 flex-col items-center justify-center rounded-xl border p-2 text-center transition-all hover:scale-[1.02] cursor-pointer",
                styleId === s.id
                  ? "border-primary ring-2 ring-primary/60 bg-accent/30 shadow-md shadow-primary/10"
                  : "border-border/80 bg-gradient-to-b from-rail/80 to-panel-raised/80 hover:border-primary/50",
              )}
            >
              <span
                style={{
                  fontFamily: s.font,
                  fontWeight: s.weight,
                  color: s.color,
                  backgroundColor: s.background ?? "transparent",
                  padding: s.background ? "2px 8px" : 0,
                  borderRadius: 4,
                  textTransform: s.uppercase ? "uppercase" : "none",
                  WebkitTextStroke: s.strokeWidth ? `1px ${s.stroke}` : undefined,
                  textShadow: s.shadow ? "0 2px 6px rgba(0,0,0,0.85)" : undefined,
                  fontSize: 13,
                  lineHeight: 1.15,
                  letterSpacing: `${s.letterSpacing}px`,
                }}
              >
                {s.name}
              </span>
              <div className="mt-1 flex items-center gap-1">
                <span className="text-[9px] text-muted-foreground/75 font-mono">
                  {s.singleLine ? "1-Line" : "Wrap"}
                </span>
                {s.background && (
                  <span className="rounded bg-white/10 px-1 text-[8px] text-muted-foreground font-mono">
                    Badge
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>

        <Button
          size="sm"
          variant="secondary"
          className="mt-3 w-full border border-border/80 font-medium hover:border-primary/50"
          onClick={applyAllSettings}
        >
          <Wand2 className="size-3.5 mr-1.5 text-primary" /> Apply all settings to timeline
        </Button>

        <p className="mt-2.5 text-[10px] leading-relaxed text-muted-foreground">
          {total > 0 ? `Timeline length: ${total.toFixed(1)}s.` : "Timeline is empty."} Click any animation or template to update all captions instantly.
        </p>
      </div>
    </div>
  );
}

export function TextPanelSummary() {
  const { state } = useEditor();
  const count = useMemo(
    () => state.clips.filter((c) => c.kind === "text").length,
    [state.clips],
  );
  return <span className="font-mono text-[10px] text-muted-foreground">{count}</span>;
}
