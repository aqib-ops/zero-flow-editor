/**
 * Auto-update via GitHub Releases (electron-updater).
 *
 * Requires a `publish` block in the electron-builder config so the builder
 * writes `resources/app-update.yml` — without it `checkForUpdates()` throws,
 * which is why every call site here is wrapped and dev runs are skipped.
 *
 * Nothing downloads until the user explicitly asks to, so a background check
 * only ever reports that a newer version exists.
 */
import { app } from "electron";
import type { UpdateStatus } from "./preload-types.js";

type Send = (channel: string, ...args: unknown[]) => void;

let status: UpdateStatus = { phase: "idle" };
let started = false;
/** Set once the window exists so any code path can push a status update. */
let send: Send | null = null;

export function currentUpdateStatus(): UpdateStatus {
  return status;
}

function publish(next: UpdateStatus): void {
  status = next;
  send?.("app:update-status", next);
}

const toMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * GitHub answers 404 until the first release with a `latest.yml` exists, and
 * that reads like a failure in the UI. Report it as "nothing to update to"
 * instead of leaking an HTTP status at the user.
 */
function toOutcome(err: unknown): UpdateStatus {
  const message = toMessage(err);
  // electron-updater phrases the empty-repo 404 a few different ways depending
  // on version: "No published versions on GitHub" / "No published releases" /
  // a bare 404 status. None of those are real failures.
  if (/\b404\b|ERR_STATUS_404|Cannot find latest version|No published (?:releases|versions)/i.test(message)) {
    return { phase: "not-available", message: "No releases published for this channel yet." };
  }
  return { phase: "error", message };
}

type UpdaterModule = typeof import("electron-updater");

/**
 * electron-updater is CommonJS and exposes `autoUpdater` through a getter that
 * Node's ESM named-export lexer cannot see, so `import("electron-updater")`
 * hands back a namespace where `autoUpdater` is `undefined`. Read the named
 * export first, then fall back to the CommonJS namespace (`module.exports`).
 */
async function loadUpdater(): Promise<UpdaterModule> {
  const ns = (await import("electron-updater")) as unknown as {
    autoUpdater?: UpdaterModule["autoUpdater"];
    default?: { autoUpdater?: UpdaterModule["autoUpdater"] } & UpdaterModule;
  };
  if (ns.autoUpdater) return ns as unknown as UpdaterModule;
  if (ns.default?.autoUpdater) return ns.default;
  throw new Error("electron-updater did not export autoUpdater");
}

/** Wire the single autoUpdater instance to our status stream. */
async function configure(): Promise<void> {
  const { autoUpdater } = await loadUpdater();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => publish({ phase: "checking" }));
  autoUpdater.on("update-available", (info) =>
    publish({ phase: "available", version: info.version, releaseDate: info.releaseDate }),
  );
  autoUpdater.on("update-not-available", () => publish({ phase: "not-available" }));
  autoUpdater.on("download-progress", (p) =>
    publish({ phase: "downloading", percent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    publish({ phase: "downloaded", version: info.version, releaseDate: info.releaseDate }),
  );
  autoUpdater.on("error", (err) => publish(toOutcome(err)));

  return autoUpdater.checkForUpdates().then(
    () => undefined,
    (err: unknown) => publish(toOutcome(err)),
  );
}

/**
 * Silent background check on launch so Settings → Updates is never a blank
 * slate. Only meaningful in the installed build; dev has no app-update.yml.
 */
export function startAutoUpdates(channel: Send): void {
  send = channel;
  if (!app.isPackaged || started) return;
  started = true;
  void configure().catch((err: unknown) =>
    publish(toOutcome(err)),
  );
}

export async function checkForUpdates(channel: Send): Promise<UpdateStatus> {
  send = channel;
  if (!app.isPackaged) {
    publish({
      phase: "not-available",
      message: "You're running an un-packaged dev build — updates are checked in the installed app.",
    });
    return status;
  }
  publish({ phase: "checking" });
  try {
    const { autoUpdater } = await loadUpdater();
    await autoUpdater.checkForUpdates();
  } catch (err) {
    publish(toOutcome(err));
  }
  return status;
}

/** Download the update the user already confirmed they want. */
export async function downloadUpdate(channel: Send): Promise<UpdateStatus> {
  send = channel;
  if (!app.isPackaged) return status;
  if (status.phase !== "available" && status.phase !== "error") {
    publish({ ...status, phase: "available" });
  }
  publish({ phase: "downloading", percent: 0, version: status.version });
  try {
    const { autoUpdater } = await loadUpdater();
    await autoUpdater.downloadUpdate();
  } catch (err) {
    publish(toOutcome(err));
  }
  return status;
}

/** Quit and install a downloaded update. */
export function quitAndInstall(): void {
  if (!app.isPackaged || status.phase !== "downloaded") return;
  void loadUpdater()
    .then(({ autoUpdater }) => autoUpdater.quitAndInstall(true, true))
    .catch((err: unknown) => publish(toOutcome(err)));
}
