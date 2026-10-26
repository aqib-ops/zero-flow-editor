/**
 * Local project store — the Recent Projects system.
 *
 * Every project autosaves to its own single file under
 * `<userData>/projects/<id>.zfp.json`. Media is referenced by absolute path,
 * never copied, so a project file stays a few KB; the heavy data (video,
 * audio, images) remains wherever the user imported it from.
 *
 * Reliability rules:
 *  - Writes are atomic: content goes to `<id>.zfp.json.tmp` first, then a
 *    rename lands it. A crash mid-write can never corrupt the previous save.
 *  - The directory listing *is* the recents index. There is no second list to
 *    drift out of sync, and "delete" is one file removal.
 *  - Startup sweep removes orphaned `.tmp` files from interrupted writes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

export interface StoredProject {
  id: string;
  name: string;
  savedAt: number;
  /** Full serialisable project (settings/tracks/clips/assets). */
  data: unknown;
}

let projectsDir: string | null = null;

function dir(): string {
  if (!projectsDir) {
    projectsDir = join(app.getPath("userData"), "projects");
    mkdirSync(projectsDir, { recursive: true });
  }
  return projectsDir;
}

const fileFor = (id: string): string => join(dir(), `${id}.zfp.json`);

/** Delete `<id>.zfp.json.tmp` leftovers from crashed writes. */
export function sweepTempFiles(): void {
  try {
    for (const entry of readdirSync(dir())) {
      if (!entry.endsWith(".tmp")) continue;
      try {
        rmSync(join(dir(), entry), { force: true });
      } catch {
        /* locked this run — next startup tries again */
      }
    }
  } catch {
    /* dir missing — nothing to sweep */
  }
}

/** Save (create or overwrite) atomically. Returns the stored record. */
export function saveProject(id: string, name: string, data: unknown): StoredProject {
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) throw new Error(`Invalid project id: ${id}`);
  const record: StoredProject = { id, name, savedAt: Date.now(), data };
  const target = fileFor(id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), "utf8");
  renameSync(tmp, target);
  return record;
}

export function loadProject(id: string): StoredProject | null {
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) return null;
  try {
    const parsed = JSON.parse(readFileSync(fileFor(id), "utf8")) as Partial<StoredProject>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.data !== "object") return null;
    return {
      id,
      name: typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : "Untitled project",
      savedAt: typeof parsed.savedAt === "number" ? parsed.savedAt : 0,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

/** Newest first. Corrupt files are skipped, not fatal. */
export function listProjects(): StoredProject[] {
  const out: StoredProject[] = [];
  try {
    for (const entry of readdirSync(dir())) {
      if (!entry.endsWith(".zfp.json")) continue;
      const id = entry.slice(0, -".zfp.json".length);
      const p = loadProject(id);
      if (p) out.push(p);
    }
  } catch {
    /* dir missing — empty list */
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function deleteProject(id: string): boolean {
  if (!/^[a-z0-9-]{1,64}$/i.test(id)) return false;
  const target = fileFor(id);
  if (!existsSync(target)) return false;
  rmSync(target, { force: true });
  return true;
}

/** Bytes used by the projects folder — surfaced in Settings → Storage. */
export function projectsDiskUsage(): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir())) {
      try {
        total += statSync(join(dir(), entry)).size;
      } catch {
        /* vanished mid-scan */
      }
    }
  } catch {
    /* dir missing */
  }
  return total;
}
