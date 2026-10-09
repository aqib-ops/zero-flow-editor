#!/usr/bin/env node
/**
 * Stages a fully self-contained captioning runtime into `bin/whisper/` so the
 * packaged app can transcribe audio offline, on machines that have neither
 * Python nor Whisper installed.
 *
 * Layout produced:
 *
 *   bin/whisper/
 *     python/                 portable CPython 3.12 + faster-whisper + deps
 *     models/base/            Systran/faster-whisper-base (141 MB, 4 files)
 *
 * Resolution order for each piece: reuse what is already staged -> copy from
 * this machine (HF cache / PATH) -> download.
 *
 * Python is pinned to 3.12 because it is the newest version where wheels
 * exist on Windows for *every* heavy dependency (ctranslate2, av,
 * onnxruntime, tokenizers, numpy, hf-xet).
 *
 * Run: `node scripts/setup-whisper.mjs`
 */
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "bin", "whisper");
const PY_DIR = join(OUT, "python");
const MODELS_DIR = join(OUT, "models");

// --- pinned inputs ---------------------------------------------------------

/** Newest 3.12 embeddable release that still publishes python-embed-amd64.zip. */
const PY_VERSION = "3.12.10";
const PY_TAG = `python${PY_VERSION.split(".").slice(0, 2).join("")}`; // python312
const PY_ZIP_URL = `https://www.python.org/ftp/python/${PY_VERSION}/python-${PY_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py";

const HF_BASE = "https://huggingface.co/Systran/faster-whisper-base/resolve/main";
const MODEL_SIZE = "base";
const MODEL_FILES = ["config.json", "model.bin", "tokenizer.json", "vocabulary.txt"];

// --- small helpers ---------------------------------------------------------

const log = (m) => console.log(`[setup-whisper] ${m}`);

/** `scripts/transcribe.py` must sit next to the runtime: Python cannot read
 *  files out of app.asar, so it is staged as a plain resource. */
const stageScript = () => {
  copyFileSync(join(ROOT, "scripts", "transcribe.py"), join(OUT, "transcribe.py"));
  log("staged transcribe.py");
};

const have = (p) => {
  try {
    return existsSync(p) && statSync(p).size > 1024;
  } catch {
    return false;
  }
};


function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "inherit", windowsHide: true });
    p.on("error", rej);
    p.on("close", (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${args.join(" ")} exited with code ${code}`)),
    );
  });
}

async function download(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  let seen = 0;
  let last = 0;
  const tracker = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    if (now - last < 5) return;
    last = now;
    const mb = (seen / 1048576).toFixed(0);
    log(`  ... ${mb} MB${total ? ` (${Math.round((seen / total) * 100)}%)` : ""}`);
  }, 1000);
  try {
    await pipeline(
      (async function* () {
        for await (const chunk of res.body) {
          seen += chunk.length;
          yield chunk;
        }
      })(),
      createWriteStream(dest),
    );
  } finally {
    clearInterval(tracker);
  }
  if (total && seen !== total) throw new Error(`truncated download: ${seen}/${total}`);
}

async function extractZip(zipPath, destDir) {
  mkdirSync(destDir, { recursive: true });
  log("extracting…");
  try {
    await run("tar", ["-xf", zipPath, "-C", destDir]);
    return;
  } catch {
    /* fall through to PowerShell */
  }
  await run("powershell.exe", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${destDir}'`,
  ]);
}

// --- step 1: portable CPython ----------------------------------------------

async function ensurePython() {
  const exe = join(PY_DIR, "python.exe");
  const pth = join(PY_DIR, `${PY_TAG}._pth`);

  if (have(exe) && existsSync(pth)) {
    log(`portable python already staged (${PY_VERSION})`);
    return;
  }

  const zip = join(ROOT, "bin", `.python-${PY_VERSION}-embed.zip`);
  if (have(zip)) {
    log("reusing previously downloaded python archive");
  } else {
    await download(PY_ZIP_URL, zip);
  }
  await extractZip(zip, PY_DIR);

  // The embeddable distribution ships with `import site` commented out and no
  // site-packages directory — both are required for pip to install anywhere
  // sane. See https://docs.python.org/3/using/windows.html#embedded-distribution
  let content = readFileSync(pth, "utf8");
  content = content.replace(/^#import site$/m, "import site");
  if (!content.includes("Lib\\site-packages")) {
    content = `${content.trimEnd()}\nLib\\site-packages\n`;
  }
  writeFileSync(pth, content, "utf8");
  mkdirSync(join(PY_DIR, "Lib", "site-packages"), { recursive: true });

  log(`staged portable python ${PY_VERSION} -> ${PY_DIR}`);
}

// --- step 2: pip + faster-whisper ------------------------------------------

async function ensureDeps() {
  const sitePkgs = join(PY_DIR, "Lib", "site-packages");
  if (existsSync(join(sitePkgs, "faster_whisper"))) {
    log("faster-whisper already installed");
    return;
  }

  const exe = join(PY_DIR, "python.exe");

  const getPip = join(ROOT, "bin", ".get-pip.py");
  if (!have(getPip)) await download(GET_PIP_URL, getPip);

  log("bootstrapping pip…");
  await run(exe, [getPip, "--no-warn-script-location", "--disable-pip-version-check"]);

  log("installing faster-whisper (wheels only)…");
  const common = [
    "-m",
    "pip",
    "install",
    "--no-warn-script-location",
    "--disable-pip-version-check",
    "--no-cache-dir",
    "--upgrade",
  ];
  // `av` 19 removed `av.open(..., metadata_errors=...)`, which faster-whisper's
  // audio decoder still passes — every transcription dies with a TypeError.
  // Pin below 19 until faster-whisper catches up.
  const specs = ["faster-whisper", "av<19"];
  try {
    await run(exe, [...common, "--only-binary=:all:", ...specs]);
  } catch (err) {
    // A dependency without a Windows wheel would make --only-binary bail out.
    // Retry without it so pip can still resolve whatever *is* prebuilt.
    log(`wheel-only install failed (${err.message}) — retrying…`);
    await run(exe, [...common, ...specs]);
  }

  log("smoke-testing the runtime…");
  // Import alone would not have caught the `av` breakage — the failure only
  // surfaces when the decoder opens a file, so assert on the signature too.
  await run(exe, [
    "-c",
    "import inspect, av.container.core as c, faster_whisper.audio as a; " +
      "assert 'metadata_errors' in str(inspect.signature(c.open)), " +
      "'av dropped metadata_errors support'; " +
      "print('faster-whisper OK')",
  ]);
}

// --- step 3: the base model ------------------------------------------------

function findCachedModel() {
  const hub = join(process.env.USERPROFILE ?? "", ".cache", "huggingface", "hub");
  const repo = join(hub, "models--Systran--faster-whisper-base");
  const snaps = join(repo, "snapshots");
  if (!existsSync(snaps)) return null;
  for (const entry of readdirSync(snaps)) {
    const dir = join(snaps, entry);
    if (MODEL_FILES.every((f) => existsSync(join(dir, f)))) return dir;
  }
  return null;
}

async function ensureModel() {
  const dest = join(MODELS_DIR, MODEL_SIZE);
  mkdirSync(dest, { recursive: true });

  const missing = MODEL_FILES.filter((f) => !have(join(dest, f)));
  if (missing.length === 0) {
    log(`model "${MODEL_SIZE}" already staged`);
    return;
  }

  // Prefer the local HuggingFace cache — a 138 MB copy instead of a download.
  const cached = findCachedModel();
  if (cached) {
    log(`copying model from local HuggingFace cache (${cached})`);
    try {
      for (const f of MODEL_FILES) {
        const src = join(cached, f);
        if (!existsSync(src)) continue;
        copyFileSync(src, join(dest, f));
      }
    } catch (err) {
      log(`cache copy failed (${err.message}) — falling back to download`);
    }
  }

  for (const f of MODEL_FILES) {
    if (have(join(dest, f))) continue;
    await download(`${HF_BASE}/${f}`, join(dest, f));
  }

  if (!MODEL_FILES.every((f) => have(join(dest, f)))) {
    throw new Error(`model staging incomplete in ${dest}`);
  }
  log(`model "${MODEL_SIZE}" staged -> ${dest}`);
}

// --- boot ------------------------------------------------------------------

async function main() {
  mkdirSync(OUT, { recursive: true });
  await ensurePython();
  await ensureDeps();
  await ensureModel();
  stageScript();
  log(`done -> ${OUT}`);
}

main().catch((err) => {
  console.error(`[setup-whisper] ${err?.stack ?? err}`);
  process.exitCode = 1;
});
