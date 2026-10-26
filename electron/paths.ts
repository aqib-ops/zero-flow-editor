/**
 * Shared locations for the bundled and the runtime-installed engines.
 *
 * Every module that looks for FFmpeg or the captioning runtime goes through
 * these helpers so the search order never drifts apart: what we shipped first
 * (read-only resources), then whatever `self-setup.ts` downloaded on this
 * machine (writable userData), then PATH fallbacks owned by the callers.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

/**
 * Directory of the bundled main-process file (dist-electron in dev). Anchoring
 * off `import.meta.url` rather than `app.getAppPath()` matters in dev: Electron
 * launched with a file path reports that file's directory as the app path, so
 * getAppPath() points at dist-electron/ and never at the project root.
 */
export function bundleDir(): string {
  try {
    return dirname(fileURLToPath(import.meta.url));
  } catch {
    return app.getAppPath();
  }
}

/** Project root while developing (`<bundle>/..`). Never valid once packaged. */
export function devProjectRoot(): string {
  return join(bundleDir(), "..");
}

/**
 * Writable root for binaries the app downloads itself: `<project>/bin` in dev,
 * `<userData>/bin` when packaged.
 *
 * Program Files installs are read-only, so `resources/` can only ever be the
 * shipped copy — anything fetched at runtime has to land somewhere the user
 * account can write to.
 */
export function writableBinRoot(): string {
  if (app.isPackaged) return join(app.getPath("userData"), "bin");
  return join(devProjectRoot(), "bin");
}

/** `name.exe` on Windows, plain `name` everywhere else. */
export function exeName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/** Shipped (read-only) folder where `scripts/setup-binaries.mjs` stages ffmpeg. */
export function shippedFfmpegDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "bin", "ffmpeg")
    : join(devProjectRoot(), "bin", "ffmpeg");
}

/** Folders where ffmpeg may exist, most authoritative first. */
export function ffmpegSearchDirs(): string[] {
  const dirs = [shippedFfmpegDir(), join(writableBinRoot(), "ffmpeg")];
  if (!app.isPackaged) dirs.push(join(app.getAppPath(), "bin", "ffmpeg"));
  return [...new Set(dirs)];
}

/** Shipped (read-only) captioning runtime folder. */
export function shippedWhisperDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "bin", "whisper")
    : join(devProjectRoot(), "bin", "whisper");
}

/**
 * Folders where the captioning runtime may live, most authoritative first:
 * the shipped copy, legacy dev fallbacks, then the runtime-downloaded copy.
 */
export function whisperSearchDirs(): string[] {
  const dirs = [shippedWhisperDir()];
  if (!app.isPackaged) dirs.push(join(app.getAppPath(), "bin", "whisper"));
  dirs.push(join(writableBinRoot(), "whisper"));
  return [...new Set(dirs)];
}

/** First candidate folder that actually contains `probe`, else `null`. */
export function firstDirWith(candidates: string[], probe: string): string | null {
  for (const dir of candidates) {
    if (existsSync(join(dir, probe))) return dir;
  }
  return null;
}
