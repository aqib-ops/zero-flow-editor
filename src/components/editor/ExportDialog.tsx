import { useState, useMemo, useRef, useEffect } from "react";
import {
  CheckCircle2,
  Download,
  FolderOpen,
  HardDrive,
  Loader2,
  Settings,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  EXPORT_HEIGHTS,
  exportVideo,
  resolveExportSize,
  type ExportHeightLabel,
  type ExportHandle,
} from "@/lib/editor/export";
import { projectDuration } from "@/lib/editor/render";
import { formatTime, baseName } from "@/lib/editor/media";
import type { EditorState } from "@/lib/editor/types";

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  state: EditorState;
}

const RESOLUTION_OPTIONS: { id: ExportHeightLabel; label: string; badge?: string }[] = [
  { id: "720p", label: "720p HD" },
  { id: "1080p", label: "1080p Full HD", badge: "Recommended" },
  { id: "1440p", label: "2K 1440p" },
  { id: "4K", label: "4K Ultra HD" },
];

const FPS_OPTIONS = [
  { value: 24, label: "24 fps (Cinematic)" },
  { value: 30, label: "30 fps (Standard)" },
  { value: 60, label: "60 fps (Smooth)" },
];

const FORMAT_OPTIONS = [
  { value: "mp4", label: "MP4 (H.264 + AAC)" },
  { value: "mov", label: "QuickTime MOV" },
  { value: "mkv", label: "Matroska MKV" },
];

const BITRATE_PRESETS = [
  { value: 8, label: "Fast (8M)" },
  { value: 12, label: "Standard (12M)" },
  { value: 20, label: "High Quality (20M)" },
  { value: 32, label: "Ultra (32M)" },
];

export function ExportDialog({ isOpen, onClose, state }: ExportDialogProps) {
  const [title, setTitle] = useState("Zero_Flow_Video");
  const [heightLabel, setHeightLabel] = useState<ExportHeightLabel>("1080p");
  const [fps, setFps] = useState<number>(30);
  const [bitrate, setBitrate] = useState<number>(12);
  const [format, setFormat] = useState<string>("mp4");
  const [customPath, setCustomPath] = useState<string>("");

  const [isExporting, setIsExporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressMsg, setProgressMsg] = useState("");
  const [exportComplete, setExportComplete] = useState(false);
  const [exportedFilePath, setExportedFilePath] = useState("");

  const exportHandleRef = useRef<ExportHandle | null>(null);

  const total = projectDuration(state.clips);
  const exportSize = useMemo(
    () => resolveExportSize(state, EXPORT_HEIGHTS[heightLabel]),
    [state, heightLabel],
  );

  const estimatedSizeMb = useMemo(() => {
    if (total <= 0) return 0;
    const mb = (bitrate * total) / 8 + (0.192 * total) / 8;
    return Math.max(0.1, Number(mb.toFixed(1)));
  }, [bitrate, total]);

  // ESC closes the dialog — but never mid-render, since abandoning an encode
  // is a separate, explicit decision.
  useEffect(() => {
    if (!isOpen || isExporting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, isExporting, onClose]);

  if (!isOpen) return null;

  const handleBrowseLocation = async () => {
    const api = window.zf;
    if (!api?.dialog) return;
    const defaultName = `${title.trim() || "video"}.${format}`;
    const chosen = await api.dialog.saveVideo(defaultName);
    if (chosen) {
      setCustomPath(chosen);
    }
  };

  const handleStartExport = async () => {
    if (isExporting) return;
    const api = window.zf;
    if (!api?.render) {
      return toast.error("Export is only supported in the desktop app.");
    }
    if (total <= 0) {
      return toast.error("Timeline is empty. Add media before exporting.");
    }

    let outputPath = customPath;
    if (!outputPath) {
      const defaultName = `${title.trim() || "video"}.${format}`;
      const chosen = await api.dialog.saveVideo(defaultName);
      if (!chosen) return;
      outputPath = chosen;
      setCustomPath(chosen);
    }

    setIsExporting(true);
    setProgress(0);
    setProgressMsg("Initializing FFmpeg encoder…");
    setExportComplete(false);

    const handle = exportVideo(
      state,
      {
        width: exportSize.width,
        height: exportSize.height,
        fps,
        bitrateMbps: bitrate,
        outputPath,
      },
      (p) => {
        setProgress(p.progress);
        setProgressMsg(p.message);
        if (p.phase === "error") {
          toast.error(p.error || p.message);
          setIsExporting(false);
        }
      },
    );

    exportHandleRef.current = handle;
    const result = await handle.promise;
    setIsExporting(false);

    if (result.ok && result.outputPath) {
      setExportComplete(true);
      setExportedFilePath(result.outputPath);
      toast.success(`Video exported successfully!`);
    } else if (result.error !== "cancelled") {
      toast.error(result.error || "Export failed");
    }
  };

  const handleCancelExport = () => {
    if (exportHandleRef.current) {
      exportHandleRef.current.cancel();
      setIsExporting(false);
      setProgress(0);
      toast.info("Export cancelled");
    }
  };

  const handleOpenFolder = () => {
    if (exportedFilePath && window.zf?.shell?.showItemInFolder) {
      window.zf.shell.showItemInFolder(exportedFilePath);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg rounded-2xl border border-border bg-panel-raised p-6 shadow-2xl overflow-hidden animate-in pop-in">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border/80 pb-3.5 mb-4">
          <div className="flex items-center gap-2">
            <div className="grid size-8 place-items-center rounded-lg bg-primary/20 text-primary">
              <Download className="size-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold tracking-tight text-foreground">
                Export Video
              </h2>
              <p className="text-[11px] text-muted-foreground">
                CapCut-grade H.264 rendering with mixed audio
              </p>
            </div>
          </div>
          {!isExporting && (
            <button
              onClick={onClose}
              className="grid size-7 place-items-center rounded-lg text-muted-foreground hover:bg-rail hover:text-foreground transition-colors"
            >
              <X className="size-4" />
            </button>
          )}
        </div>

        {/* Export In Progress Screen */}
        {isExporting ? (
          <div className="py-6 space-y-5 text-center">
            <div className="relative mx-auto flex size-24 items-center justify-center">
              <svg className="size-full -rotate-90" viewBox="0 0 36 36">
                <path
                  className="text-border"
                  strokeWidth="3.5"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
                <path
                  className="text-primary transition-all duration-300"
                  strokeDasharray={`${Math.round(progress * 100)}, 100`}
                  strokeLinecap="round"
                  strokeWidth="3.5"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
              </svg>
              <span className="absolute font-mono text-xl font-bold text-foreground">
                {Math.round(progress * 100)}%
              </span>
            </div>

            <div>
              <p className="text-sm font-semibold text-foreground">
                Rendering {exportSize.width}×{exportSize.height} Video…
              </p>
              <p className="mt-1 font-mono text-xs text-muted-foreground">
                {progressMsg || "Encoding frames with FFmpeg…"}
              </p>
            </div>

            <Button
              variant="destructive"
              size="sm"
              onClick={handleCancelExport}
              className="mt-4"
            >
              Cancel Export
            </Button>
          </div>
        ) : exportComplete ? (
          /* Export Done Screen */
          <div className="py-6 space-y-4 text-center">
            <div className="mx-auto grid size-16 place-items-center rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
              <CheckCircle2 className="size-9" />
            </div>
            <div>
              <h3 className="text-base font-bold text-foreground">
                Export Completed!
              </h3>
              <p className="mt-1 text-xs text-muted-foreground truncate max-w-sm mx-auto">
                {baseName(exportedFilePath)}
              </p>
            </div>

            <div className="flex justify-center gap-3 pt-3">
              <Button variant="secondary" size="sm" onClick={handleOpenFolder}>
                <FolderOpen className="size-4 mr-1.5" /> Open in Folder
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  setExportComplete(false);
                  onClose();
                }}
              >
                Done
              </Button>
            </div>
          </div>
        ) : (
          /* Main CapCut Settings Screen */
          <div className="space-y-4 text-xs">
            {/* Project Title */}
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Video Title
              </label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="My Awesome Video"
                className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary font-medium"
              />
            </div>

            {/* Resolution Selector */}
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Resolution ({exportSize.width}×{exportSize.height})
              </label>
              <div className="mt-1.5 grid grid-cols-2 gap-2">
                {RESOLUTION_OPTIONS.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setHeightLabel(r.id)}
                    className={cn(
                      "flex items-center justify-between rounded-lg border px-3 py-2 text-left transition-all",
                      heightLabel === r.id
                        ? "border-primary bg-primary/15 text-foreground font-bold shadow-sm ring-1 ring-primary/40"
                        : "border-border bg-rail/80 text-muted-foreground hover:bg-rail hover:text-foreground",
                    )}
                  >
                    <span>{r.label}</span>
                    {r.badge && (
                      <span className="rounded bg-primary/20 px-1 py-0.5 text-[9px] font-semibold text-primary">
                        {r.badge}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Frame Rate & Format Grid */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Frame Rate
                </label>
                <select
                  value={fps}
                  onChange={(e) => setFps(Number(e.target.value))}
                  className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-xs text-foreground"
                >
                  {FPS_OPTIONS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Format
                </label>
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                  className="mt-1 h-8 w-full rounded-lg border border-input bg-background px-2 text-xs text-foreground"
                >
                  {FORMAT_OPTIONS.map((fmt) => (
                    <option key={fmt.value} value={fmt.value}>
                      {fmt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Quality & Bitrate */}
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Bitrate & Quality: <span className="font-mono text-primary">{bitrate} Mbps</span>
                </label>
              </div>

              <div className="mt-1.5 flex gap-1.5">
                {BITRATE_PRESETS.map((b) => (
                  <button
                    key={b.value}
                    type="button"
                    onClick={() => setBitrate(b.value)}
                    className={cn(
                      "flex-1 rounded border px-2 py-1 text-[10px] font-medium transition-colors",
                      bitrate === b.value
                        ? "border-primary bg-primary text-primary-foreground font-bold"
                        : "border-border bg-rail text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Save Location Selector */}
            <div>
              <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Save Destination
              </label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={customPath || "Auto (Click browse to choose folder)"}
                  className="h-8 flex-1 truncate rounded-lg border border-input bg-background px-2.5 text-[11px] font-mono text-muted-foreground"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={handleBrowseLocation}
                  className="h-8 shrink-0"
                >
                  <FolderOpen className="size-3.5 mr-1" /> Browse
                </Button>
              </div>
            </div>

            {/* Details Footer Bar */}
            <div className="flex items-center justify-between rounded-lg border border-border/70 bg-rail/60 px-3 py-2 text-[11px]">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Video className="size-3.5 text-primary" />
                Duration: <strong className="font-mono text-foreground">{formatTime(total)}</strong>
              </span>
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <HardDrive className="size-3.5 text-primary" />
                Est. Size: <strong className="font-mono text-foreground">~{estimatedSizeMb} MB</strong>
              </span>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-end gap-2.5 pt-2">
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleStartExport}
                className="bg-primary hover:bg-primary/90 font-bold px-5 text-primary-foreground shadow-md"
              >
                <Download className="size-4 mr-1.5" /> Export Now
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
