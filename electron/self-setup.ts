/**
 * Runtime self-setup: makes a fresh install work with zero manual steps.
 *
 * When FFmpeg or the captioning runtime is missing from the shipped resources
 * (for example an antivirus quarantined them, or the install came from a build
 * that skipped `npm run setup:*`), the app downloads the same pinned artifacts
 * the build-time scripts use and installs them into a writable location:
 *
 *   ffmpeg  -> <userData>/bin/ffmpeg
 *   whisper -> <userData>/bin/whisper   (portable CPython + faster-whisper + base model)
 *
 * Downloads only ever run on Windows — that is the only platform with pinned
 * artifact URLs and the only one the packaged exe targets. Everywhere else the
 * app keeps its historical behaviour: FFmpeg from PATH, no captions runtime.
 *
 * Status is pushed over the `setup:status` IPC channel (see main.ts) so the
 * renderer can show what is happening instead of a silent 300 MB download.
 */
import { execFile, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import type { Dirent } from "node:fs";
import { Readable } from "node:stream";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import transcribePy from "../scripts/transcribe.py";
import { exeName, ffmpegSearchDirs, whisperSearchDirs, writableBinRoot } from "./paths.js";
import { isModelReady } from "./whisper.js";
import type { SetupComponent, SetupPhase, SetupSnapshot, SetupStatus } from "./preload-types.js";

export type { SetupComponent, SetupPhase, SetupSnapshot, SetupStatus };

const execFileAsync = promisify(execFile);

/* ------------------------------- status bus -------------------------------- */

let sink: ((status: SetupStatus) => void) | null = null;
const phases: Record<SetupComponent, SetupPhase> = { ffmpeg: "idle", whisper: "idle" };
let lastMessage: string | null = null;

/** main.ts registers the IPC broadcaster here before self-setup starts. */
export function setSetupSink(fn: ((status: SetupStatus) => void) | null): void {
  sink = fn;
}

export function getSetupSnapshot(): SetupSnapshot {
  return { ffmpeg: phases.ffmpeg, whisper: phases.whisper, message: lastMessage };
}

function emit(component: SetupComponent, phase: SetupPhase, detail?: string, progress?: number): void {
  phases[component] = phase;
  if (detail) lastMessage = detail;
  sink?.({ component, phase, detail, progress });
}

/* ------------------------------ shared bits -------------------------------- */

const log = (msg: string): void => console.log(`[self-setup] ${msg}`);

const have = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).size > 1024;
  } catch {
    return false;
  }
};

/** Streams `url` to `dest` via a `.part` temp file so a truncated download is never reused. */
async function download(
  url: string,
  dest: string,
  onProgress?: (seen: number, total: number) => void,
): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  const body = res.body;
  if (!res.ok || !body) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let seen = 0;
  let lastEmit = 0;
  try {
    const stream = Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream);
    stream.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 500) {
        lastEmit = now;
        onProgress?.(seen, total);
      }
    });
    await pipeline(stream, createWriteStream(part));
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
  if (total && seen !== total) {
    rmSync(part, { force: true });
    throw new Error(`truncated download: ${seen}/${total}`);
  }
  renameSync(part, dest);
}

/** tar.exe (Win10 1803+) understands zip; PowerShell 5.1 is the fallback. */
async function extractZip(zipPath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true });
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

function findDirContaining(dir: string, fileName: string, depth = 4): string | null {
  if (depth < 0) return null;
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  if (dirents.some((e) => e.isFile() && e.name.toLowerCase() === fileName)) return dir;
  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    const hit = findDirContaining(join(dir, e.name), fileName, depth - 1);
    if (hit) return hit;
  }
  return null;
}

/** Runs a helper process, resolving with its combined output. */
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolvePromise(out) : reject(new Error(`${cmd} ${args.join(" ")} → exit ${code}\n${out.slice(-2000)}`)),
    );
  });
}

/* --------------------------------- FFmpeg ---------------------------------- */

/** Pinned, redistributable (GPL) static Windows build — same one setup-binaries.mjs stages. */
const FFMPEG_ZIP_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";

/** First search dir that already holds both binaries, else null. */
export function findFfmpegDir(): string | null {
  const ff = exeName("ffmpeg");
  const fp = exeName("ffprobe");
  for (const dir of ffmpegSearchDirs()) {
    if (have(join(dir, ff)) && have(join(dir, fp))) return dir;
  }
  return null;
}

export function ffmpegReady(): boolean {
  return findFfmpegDir() !== null;
}

let ffmpegInflight: Promise<boolean> | null = null;

/**
 * Guarantees a usable ffmpeg+ffprobe pair exists on disk. Serialized: concurrent
 * callers (startup self-setup + a mid-session export retry) share one install.
 * Resolves true when the binaries are present afterwards, false on any failure.
 */
export function ensureFfmpeg(): Promise<boolean> {
  if (ffmpegReady()) return Promise.resolve(true);
  if (!ffmpegInflight) {
    ffmpegInflight = installFfmpeg().then(
      (ok) => {
        if (!ok) ffmpegInflight = null; // allow a retry later
        return ok;
      },
      () => {
        ffmpegInflight = null;
        return false;
      },
    );
  }
  return ffmpegInflight;
}

async function installFfmpeg(): Promise<boolean> {
  if (process.platform !== "win32") return false; // no pinned artifact — PATH stays the model
  const outDir = join(writableBinRoot(), "ffmpeg");
  try {
    emit("ffmpeg", "downloading", "Downloading FFmpeg (~80 MB, one-time)…");
    const zip = join(writableBinRoot(), ".ffmpeg-release-essentials.zip");
    if (!have(zip)) {
      await download(FFMPEG_ZIP_URL, zip, (seen, total) =>
        emit("ffmpeg", "downloading", `Downloading FFmpeg… ${Math.round(seen / 1048576)} MB`, total ? Math.round((seen / total) * 100) : undefined),
      );
    }

    emit("ffmpeg", "extracting", "Extracting FFmpeg…");
    const tmp = join(writableBinRoot(), ".ffmpeg-extract");
    rmSync(tmp, { recursive: true, force: true });
    await extractZip(zip, tmp);
    const binDir = findDirContaining(tmp, "ffmpeg.exe");
    if (!binDir) throw new Error("extracted archive contains no ffmpeg.exe");

    mkdirSync(outDir, { recursive: true });
    let copied = 0;
    for (const name of readdirSync(binDir)) {
      const lower = name.toLowerCase();
      const wanted = lower === "ffmpeg.exe" || lower === "ffprobe.exe" || lower.endsWith(".dll");
      if (!wanted) continue;
      copyFileSync(join(binDir, name), join(outDir, name));
      copied++;
    }
    rmSync(tmp, { recursive: true, force: true });
    if (copied === 0) throw new Error("no binaries copied out of the archive");

    if (!ffmpegReady()) throw new Error("ffmpeg.exe/ffprobe.exe still missing after install");
    rmSync(zip, { force: true }); // ~80 MB: keep it only for a failed retry
    log(`ffmpeg ready -> ${outDir}`);
    emit("ffmpeg", "ready", "FFmpeg ready");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`ffmpeg setup failed: ${msg}`);
    emit("ffmpeg", "error", `FFmpeg setup failed: ${msg}`);
    return false;
  }
}

/* --------------------------- captioning runtime ---------------------------- */

/** Pinned inputs — kept byte-for-byte in line with scripts/setup-whisper.mjs. */
const PY_VERSION = "3.12.10";
const PY_TAG = `python${PY_VERSION.split(".").slice(0, 2).join("")}`; // python312
const PY_ZIP_URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";
const HF_BASE = "https://huggingface.co/Systran/faster-whisper-base/resolve/main";
const MODEL_SIZE = "base";
const MODEL_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"];

/** True when `dir` is a complete runtime: interpreter, script, deps and model. */
export function whisperRuntimeComplete(dir: string): boolean {
  return (
    have(join(dir, "python", "python.exe")) &&
    have(join(dir, "transcribe.py")) &&
    isModelReady(join(dir, "models"), MODEL_SIZE) &&
    existsSync(join(dir, "python", "Lib", "site-packages", "faster_whisper"))
  );
}

/** First search dir holding a complete runtime, else null. */
export function findCompleteWhisperDir(): string | null {
  for (const dir of whisperSearchDirs()) {
    if (whisperRuntimeComplete(dir)) return dir;
  }
  return null;
}

export function whisperReady(): boolean {
  return findCompleteWhisperDir() !== null;
}

let whisperInflight: Promise<boolean> | null = null;

/** Same contract as ensureFfmpeg(), for the captioning runtime. */
export function ensureWhisper(): Promise<boolean> {
  if (whisperReady()) return Promise.resolve(true);
  if (!whisperInflight) {
    whisperInflight = installWhisper().then(
      (ok) => {
        if (!ok) whisperInflight = null;
        return ok;
      },
      () => {
        whisperInflight = null;
        return false;
      },
    );
  }
  return whisperInflight;
}

async function installWhisper(): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const root = join(writableBinRoot(), "whisper");
  const pyDir = join(root, "python");
  const modelsDir = join(root, "models");
  try {
    mkdirSync(root, { recursive: true });

    // 1. portable CPython ---------------------------------------------------
    const pyExe = join(pyDir, "python.exe");
    const pth = join(pyDir, `${PY_TAG}._pth`);
    if (!(have(pyExe) && existsSync(pth))) {
      emit("whisper", "downloading", `Downloading Python ${PY_VERSION}…`);
      const zip = join(writableBinRoot(), `.python-${PY_VERSION}-embed.zip`);
      if (!have(zip)) {
        await download(PY_ZIP_URL, zip, (seen, total) =>
          emit("whisper", "downloading", `Downloading Python… ${Math.round(seen / 1048576)} MB`, total ? Math.round((seen / total) * 100) : undefined),
        );
      }
      emit("whisper", "extracting", "Installing Python…");
      await extractZip(zip, pyDir);
      rmSync(zip, { force: true }); // ~11 MB, only needed if extraction is retried

      // The embeddable distro ships with `import site` commented out and no
      // site-packages dir — both are required for pip to install anywhere sane.
      let content = readFileSync(pth, "utf8");
      content = content.replace(/^#import site$/m, "import site");
      if (!content.includes("Lib\\site-packages")) content = `${content.trimEnd()}\nLib\\site-packages\n`;
      writeFileSync(pth, content, "utf8");
      mkdirSync(join(pyDir, "Lib", "site-packages"), { recursive: true });
    }

    // 2. pip + faster-whisper ----------------------------------------------
    const sitePkgs = join(pyDir, "Lib", "site-packages");
    if (!existsSync(join(sitePkgs, "faster_whisper"))) {
      emit("whisper", "installing", "Installing the transcription engine…");
      const getPip = join(writableBinRoot(), ".get-pip.py");
      if (!have(getPip)) await download(GET_PIP_URL, getPip);
      await run(pyExe, [getPip, "--no-warn-script-location", "--disable-pip-version-check"]);
      rmSync(getPip, { force: true }); // pip is installed now; the script is not reused

      const common = [
        "-m", "pip", "install",
        "--no-warn-script-location", "--disable-pip-version-check", "--no-cache-dir", "--upgrade",
      ];
      // `av` 19 removed `av.open(..., metadata_errors=...)`, which faster-whisper
      // still passes — every transcription would die with a TypeError.
      const specs = ["faster-whisper", "av<19"];
      try {
        await run(pyExe, [...common, "--only-binary=:all:", ...specs]);
      } catch {
        // A dep without a Windows wheel makes --only-binary bail; retry anyway.
        await run(pyExe, [...common, ...specs]);
      }

      // Import alone would not catch the `av` breakage — assert on the signature.
      await run(pyExe, [
        "-c",
        "import inspect, av.container.core as c, faster_whisper.audio as a; " +
          "assert 'metadata_errors' in str(inspect.signature(c.open)), 'av dropped metadata_errors support'",
      ]);
    }

    // 3. the base model -----------------------------------------------------
    const dest = join(modelsDir, MODEL_SIZE);
    mkdirSync(dest, { recursive: true });
    if (MODEL_FILES.some((f) => !have(join(dest, f)))) {
      // Prefer the local HuggingFace cache — a copy instead of a 138 MB download.
      const hub = join(process.env.USERPROFILE ?? "", ".cache", "huggingface", "hub", "models--Systran--faster-whisper-base", "snapshots");
      if (existsSync(hub)) {
        for (const entry of readdirSync(hub)) {
          const dir = join(hub, entry);
          if (!MODEL_FILES.every((f) => existsSync(join(dir, f)))) continue;
          for (const f of MODEL_FILES) copyFileSync(join(dir, f), join(dest, f));
          break;
        }
      }
      for (const f of MODEL_FILES) {
        if (have(join(dest, f))) continue;
        emit("whisper", "downloading", `Downloading the ${MODEL_SIZE} speech model…`);
        await download(`${HF_BASE}/${f}`, join(dest, f), (seen, total) =>
          emit("whisper", "downloading", `Downloading the speech model… ${Math.round(seen / 1048576)} MB`, total ? Math.round((seen / total) * 100) : undefined),
        );
      }
      if (!MODEL_FILES.every((f) => have(join(dest, f)))) throw new Error("speech model download incomplete");
    }

    // 4. the CLI entry point — embedded, so no .py file has to ship as a resource
    writeFileSync(join(root, "transcribe.py"), transcribePy, "utf8");

    if (!whisperRuntimeComplete(root)) throw new Error("runtime incomplete after install");
    log(`whisper runtime ready -> ${root}`);
    emit("whisper", "ready", "Captions engine ready");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`whisper setup failed: ${msg}`);
    emit("whisper", "error", `Captions setup failed: ${msg}`);
    return false;
  }
}

/* ---------------------------------- boot ----------------------------------- */

/**
 * Delete staging leftovers from a previous crashed/failed install: `.part`
 * download halves, the ffmpeg zip kept "only for a failed retry", and the
 * extraction scratch dir. Runs before any setup decision, so a kill -9
 * mid-download can never strand ~100 MB in the writable root.
 */
export function sweepStaleStaging(): void {
  const root = writableBinRoot();
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return; // root doesn't exist yet — nothing to sweep
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    const stale =
      entry.name.endsWith(".part") ||
      entry.name.startsWith(".ffmpeg-release-essentials.zip") ||
      entry.name.startsWith(".python-") ||
      entry.name === ".get-pip.py" ||
      entry.name === ".ffmpeg-extract";
    if (!stale) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      log(`swept stale staging artifact: ${entry.name}`);
    } catch {
      /* best effort — next run tries again */
    }
  }
}

/**
 * Startup self-check, run in the background after `app.whenReady()`. Never
 * throws: a failed download degrades to the previous behaviour (PATH lookup /
 * "run npm run setup:*" hints) instead of blocking the editor.
 */
export async function runSelfSetup(): Promise<void> {
  if (process.platform !== "win32") {
    // No pinned artifacts for other platforms: PATH lookup stays the model.
    emit("ffmpeg", "ready");
    emit("whisper", "ready");
    return;
  }
  sweepStaleStaging();
  emit("ffmpeg", "checking", "Checking video engine…");
  if (ffmpegReady()) {
    emit("ffmpeg", "ready");
  } else {
    await ensureFfmpeg();
  }

  emit("whisper", "checking", "Checking captions engine…");
  if (whisperReady()) {
    emit("whisper", "ready");
  } else {
    // The ~380 MB captioning runtime is not a first-run requirement: it is
    // fetched on demand the first time the user actually transcribes
    // (`ensureWhisper`), so startup never downloads it without consent.
    emit("whisper", "idle", "Captions engine installs on first use");
  }
}
