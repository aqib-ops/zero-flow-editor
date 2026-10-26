/**
 * Session cache hygiene.
 *
 * The editor keeps no project files: everything a user builds lives in renderer
 * memory and references their original media. The only data the app accumulates
 * on disk is Chromium's derived caches (HTTP cache, code cache, GPU/shader
 * caches) inside the userData folder. This module clears those after every
 * successful export and on quit, so closing the app leaves a near-pristine
 * profile. Local Storage is kept — it holds a few bytes of UI prefs (panel and
 * timeline sizes), never project data.
 */
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { app, session } from "electron";

/** Derived cache folders inside userData — all safe to delete while running. */
const CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DIPS",
  "Shared Dictionary",
  "blob_storage",
];

function rmCacheDirs(): void {
  const root = app.getPath("userData");
  for (const dir of CACHE_DIRS) {
    const full = join(root, dir);
    try {
      if (existsSync(full)) rmSync(full, { recursive: true, force: true });
    } catch {
      /* a locked file just survives until the next sweep */
    }
  }
}

/**
 * Best-effort cache flush; safe to call while the app is in use. Chromium may
 * hold open handles right after an encode, so failures are tolerated — the
 * quit-time sweep catches whatever survived.
 */
export async function clearSessionCache(): Promise<void> {
  try {
    await session.defaultSession.clearCache();
  } catch {
    /* ignore */
  }
  rmCacheDirs();
}

/** Wire the quit-time sweep. Call once after app.whenReady(). */
export function startCacheSweeper(): void {
  app.on("will-quit", () => {
    rmCacheDirs();
  });
}
