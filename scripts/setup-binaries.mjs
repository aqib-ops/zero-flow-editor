#!/usr/bin/env node
/**
 * Stages FFmpeg into `bin/ffmpeg/` so the packaged app never depends on the
 * end user having FFmpeg installed.
 *
 * Resolution order:
 *   1. `bin/ffmpeg/` already populated              -> nothing to do
 *   2. a working ffmpeg + ffprobe on PATH (or a
 *      well-known install dir)                      -> copy it in
 *   3. otherwise download the pinned gyan.dev build -> extract + copy
 *
 * Only ffmpeg.exe and ffprobe.exe are copied (plus any DLLs sitting next to
 * them, for non-static builds). ffplay is deliberately skipped.
 *
 * Run: `node scripts/setup-binaries.mjs`
 */
import { execFile, execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";

const execFileAsync = promisify(execFile);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "bin", "ffmpeg");

/** Pinned, redistributable (GPL) static Windows build. */
const ZIP_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
const ZIP_PATH = join(ROOT, "bin", ".ffmpeg-release-essentials.zip");

const log = (msg) => console.log(`[setup-binaries] ${msg}`);
const have = (p) => {
  try {
    return existsSync(p) && statSync(p).size > 1024;
  } catch {
    return false;
  }
};

/** Copies ffmpeg/ffprobe (and any DLLs beside them) from `fromDir` into bin/. */
function stageFrom(fromDir) {
  mkdirSync(OUT_DIR, { recursive: true });
  let copied = 0;
  for (const name of readdirSync(fromDir)) {
    const lower = name.toLowerCase();
    const wanted =
      lower === "ffmpeg.exe" ||
      lower === "ffprobe.exe" ||
      lower === "ffmpeg" ||
      lower === "ffprobe" ||
      lower.endsWith(".dll");
    if (!wanted) continue;
    copyFileSync(join(fromDir, name), join(OUT_DIR, name));
    copied++;
  }
  return copied;
}

function isComplete() {
  const ff = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const fp = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  return have(join(OUT_DIR, ff)) && have(join(OUT_DIR, fp));
}

/** Follows `where`/`which` output, including Windows .lnk-style shims, to the real folder. */
async function discover() {
  const names = process.platform === "win32" ? ["ffmpeg.exe", "ffprobe.exe"] : ["ffmpeg", "ffprobe"];
  const found = {};
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync(
        process.platform === "win32" ? "where" : "which",
        [name.replace(/\.exe$/i, "")],
        { windowsHide: true },
      );
      const hit = stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .find((p) => have(p));
      if (hit) found[name] = hit;
    } catch {
      /* not on PATH */
    }
  }
  if (found["ffmpeg.exe"] && found["ffprobe.exe"]) return dirname(found["ffmpeg.exe"]);
  if (found.ffmpeg && found.ffprobe) return dirname(found.ffmpeg);

  // Common manual-install locations.
  const roots = [
    process.env.LOCALAPPDATA ?? "",
    process.env.ProgramFiles ?? "",
    process.env["ProgramFiles(x86)"] ?? "",
    "C:\\ffmpeg",
    "D:\\ffmpeg",
  ].filter(Boolean);
  for (const root of roots) {
    for (const rel of [
      ["ffmpeg", "bin", "ffmpeg.exe"],
      ["bin", "ffmpeg.exe"],
      ["ffmpeg.exe"],
    ]) {
      const p = join(root, ...rel);
      const probe = join(dirname(p), "ffprobe.exe");
      if (have(p) && have(probe)) return dirname(p);
    }
  }
  return null;
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let seen = 0;
  let last = 0;
  const body = res.body;
  const out = createWriteStream(dest);
  const tracker = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    if (now - last < 5) return;
    last = now;
    const mb = (seen / 1048576).toFixed(0);
    const pct = total ? ` (${Math.round((seen / total) * 100)}%)` : "";
    log(`  ... ${mb} MB${pct}`);
  }, 1000);
  try {
    await pipeline(
      (async function* () {
        for await (const chunk of body) {
          seen += chunk.length;
          yield chunk;
        }
      })(),
      out,
    );
  } finally {
    clearInterval(tracker);
  }
  if (total && seen !== total) throw new Error(`truncated download: ${seen}/${total}`);
}

async function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  log("extracting…");
  // PowerShell 5.1 has Expand-Archive; tar.exe (bundled with Win10 1803+) also
  // understands zip. Prefer tar, fall back to PowerShell.
  try {
    await execFileAsync("tar", ["-xf", zipPath, "-C", destDir], { windowsHide: true });
    return;
  } catch {
    /* fall through */
  }
  await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`],
    { windowsHide: true },
  );
}

function findDirContaining(dir, fileName, depth = 4) {
  if (depth < 0) return null;
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (entries.some((e) => e.isFile() && e.name.toLowerCase() === fileName)) return dir;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const hit = findDirContaining(join(dir, e.name), fileName, depth - 1);
    if (hit) return hit;
  }
  return null;
}

async function main() {
  if (isComplete()) {
    log(`already staged at ${OUT_DIR}`);
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });

  // Default: fetch the pinned *essentials* build. It is far smaller than a
  // "full" build (~80 MB vs ~400 MB for the two binaries) and still ships
  // everything the renderer pipeline needs — rawvideo demux, libx264, AAC.
  // `--from-local` skips the download and copies the machine's own install.
  const preferLocal = process.argv.includes("--from-local");

  if (preferLocal) {
    log("--from-local: looking for an existing FFmpeg install…");
    const fromDir = await discover();
    if (!fromDir) throw new Error("--from-local: no FFmpeg found on this machine");
    const n = stageFrom(fromDir);
    log(`staged ${n} file(s) from ${fromDir}`);
  } else {
    if (have(ZIP_PATH)) {
      log("reusing previously downloaded archive");
    } else {
      log("downloading pinned FFmpeg essentials build (one-off, ~80 MB)…");
      await download(ZIP_URL, ZIP_PATH);
    }
    const tmp = join(ROOT, "bin", ".ffmpeg-extract");
    await extractZip(ZIP_PATH, tmp);
    const binDir = findDirContaining(tmp, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (!binDir) throw new Error("extracted archive has no ffmpeg binary");
    const n = stageFrom(binDir);
    log(`staged ${n} file(s) from ${binDir}`);
  }

  if (!isComplete()) throw new Error("FFmpeg staging failed — ffmpeg.exe/ffprobe.exe still missing");
  log(`done -> ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(`[setup-binaries] ${err?.message ?? err}`);
  process.exitCode = 1;
});
