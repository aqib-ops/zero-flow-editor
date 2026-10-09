import { useCallback, useEffect, useState } from "react";
import { Download, ExternalLink, Film, HardDrive, Info, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AppInfo, UpdateStatus } from "@/types/window";

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabId = "updates" | "about";

const TABS: { id: TabId; label: string; icon: typeof Info }[] = [
  { id: "updates", label: "Updates", icon: Download },
  { id: "about", label: "About", icon: Info },
];

const EMPTY_UPDATE: UpdateStatus = { phase: "idle" };

export function SettingsDialog({ isOpen, onClose }: SettingsDialogProps) {
  const [tab, setTab] = useState<TabId>("updates");
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [update, setUpdate] = useState<UpdateStatus>(EMPTY_UPDATE);

  const refresh = useCallback(async () => {
    const api = window.zf?.app;
    if (!api) return;
    const [i, u] = await Promise.all([
      api.info().catch(() => null),
      api.updateStatus().catch(() => EMPTY_UPDATE),
    ]);
    if (i) setInfo(i);
    setUpdate(u ?? EMPTY_UPDATE);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void refresh();
    const off = window.zf?.app?.onUpdateStatus?.(setUpdate);
    return () => off?.();
  }, [isOpen, refresh]);

  // ESC closes the dialog — the standard escape hatch for any modal.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const openExternal = (url: string) => void window.zf?.app?.openExternal(url);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm animate-in fade-in duration-150"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[min(520px,88vh)] w-[min(720px,96vw)] flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl animate-in pop-in"
      >
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-md bg-accent text-foreground">
              <Sparkles className="size-4" />
            </span>
            <div className="leading-tight">
              <h2 className="text-sm font-semibold">Settings</h2>
              <p className="text-[11px] text-muted-foreground">
                {info ? `${info.name} ${info.version}` : "Zero Flow"}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close settings"
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="flex min-h-0 grow">
          <nav className="flex w-36 shrink-0 flex-col gap-1 border-r border-border p-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-2 text-left text-xs font-medium transition-colors",
                  tab === t.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-rail hover:text-foreground",
                )}
              >
                <t.icon className="size-4" />
                {t.label}
              </button>
            ))}
          </nav>

          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-5">
            {tab === "updates" && <UpdatesTab update={update} currentVersion={info?.version} />}

            {tab === "about" && <AboutTab info={info} openExternal={openExternal} />}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- sub views ------------------------------- */

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {hint && <p className="mb-3 mt-1 text-[11px] text-muted-foreground">{hint}</p>}
      <div className={hint ? "mt-3" : "mt-2"}>{children}</div>
    </section>
  );
}

function UpdatesTab({
  update,
  currentVersion,
}: {
  update: UpdateStatus;
  currentVersion?: string;
}) {
  const [busy, setBusy] = useState(false);
  const desktop = !!window.zf?.app;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const check = () => run(() => window.zf!.app.updateCheck());
  const download = () => run(() => window.zf!.app.updateDownload());
  const install = () => run(() => window.zf!.app.updateInstall());

  return (
    <Section title="Software updates" hint="Updates are fetched from GitHub Releases.">
      <div className="rounded-lg border border-border bg-background/60 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium">Installed version</div>
            <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              {currentVersion ? `v${currentVersion}` : "—"}
            </div>
          </div>
          <StatusPill phase={update.phase} />
        </div>

        <div className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
          {update.phase === "idle" && (desktop ? "Ready to check." : "Not available in the browser.")}
          {update.phase === "checking" && "Checking for a newer version…"}
          {update.phase === "not-available" &&
            (update.message ?? "You're on the latest version.")}
          {update.phase === "available" && (
            <>
              Version <span className="text-foreground">v{update.version}</span> is available
              {update.releaseDate ? ` (${update.releaseDate.slice(0, 10)})` : ""}.
            </>
          )}
          {update.phase === "downloading" && (
            <span className="text-foreground">Downloading… {update.percent ?? 0}%</span>
          )}
          {update.phase === "downloaded" && (
            <span className="text-foreground">
              v{update.version} is ready. Restart to finish installing.
            </span>
          )}
          {update.phase === "error" && <span className="text-destructive">{update.message}</span>}
        </div>

        {update.phase === "downloading" && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-accent">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${update.percent ?? 0}%` }}
            />
          </div>
        )}

        <div className="mt-4 flex flex-wrap gap-2">
          {(update.phase === "idle" ||
            update.phase === "not-available" ||
            update.phase === "error") && (
            <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={!desktop || busy} onClick={check}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Check for updates
            </Button>
          )}

          {update.phase === "available" && (
            <>
              <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={busy} onClick={download}>
                <Download className="size-3.5" />
                Download update
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={check} disabled={busy}>
                Check again
              </Button>
            </>
          )}

          {update.phase === "downloaded" && (
            <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={busy} onClick={install}>
              <RotateCcw className="size-3.5" />
              Restart now
            </Button>
          )}
        </div>
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Zero Flow checks once at launch and never downloads without your confirmation. Updates also
        install automatically the next time you quit the app.
      </p>
    </Section>
  );
}

function StatusPill({ phase }: { phase: UpdateStatus["phase"] }) {
  const map: Record<UpdateStatus["phase"], { text: string; cls: string }> = {
    idle: { text: "Up to date", cls: "border-border text-muted-foreground" },
    checking: { text: "Checking", cls: "border-border text-muted-foreground" },
    "not-available": { text: "Up to date", cls: "border-primary/40 bg-primary/10 text-primary" },
    available: { text: "Update available", cls: "border-amber-500/40 bg-amber-500/10 text-amber-500" },
    downloading: { text: "Downloading", cls: "border-amber-500/40 bg-amber-500/10 text-amber-500" },
    downloaded: { text: "Ready to install", cls: "border-primary/40 bg-primary/10 text-primary" },
    error: { text: "Failed", cls: "border-destructive/50 bg-destructive/10 text-destructive" },
  };
  const { text, cls } = map[phase] ?? map.idle;
  const spinning = phase === "checking" || phase === "downloading";
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium",
        cls,
      )}
    >
      {spinning && <Loader2 className="size-3 animate-spin" />}
      {text}
    </span>
  );
}

function AboutTab({
  info,
  openExternal,
}: {
  info: AppInfo | null;
  openExternal: (url: string) => void;
}) {
  const rows: [string, string][] = info
    ? [
        ["Version", info.version],
        ["Electron", info.electron],
        ["Chromium", info.chrome],
        ["Node.js", info.node],
        ["Platform", info.platform],
        ["Build", info.packaged ? "Installed" : "Development"],
      ]
    : [];

  return (
    <>
      <Section title="About Zero Flow" hint="An offline, desktop-first video editor.">
        <div className="rounded-lg border border-border bg-background/60 p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-primary to-primary/60 text-primary-foreground">
              <Film className="size-5" />
            </span>
            <div>
              <div className="text-sm font-semibold">{info?.name ?? "Zero Flow"}</div>
              <div className="text-[11px] text-muted-foreground">
                {info?.version ? `Version ${info.version}` : "Version unknown"}
              </div>
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t border-border pt-3">
            {rows.map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2">
                <dt className="text-[11px] text-muted-foreground">{k}</dt>
                <dd className="truncate font-mono text-[11px]" title={v}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      <Section title="Offline by design">
        <div className="rounded-lg border border-border bg-background/60 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          <div className="mb-1 flex items-center gap-2 text-foreground">
            <HardDrive className="size-3.5" />
            <span className="text-xs font-medium">Nothing leaves your machine</span>
          </div>
          Rendering, transcription and updates all happen locally. Media is never uploaded, and no
          analytics or telemetry are collected.
        </div>
      </Section>

      {info?.repo && (
        <button
          onClick={() => openExternal(info.repo)}
          className="flex items-center gap-1.5 text-[11px] text-primary transition-colors hover:underline"
        >
          {info.repo}
          <ExternalLink className="size-3" />
        </button>
      )}
    </>
  );
}
