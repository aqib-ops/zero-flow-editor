/**
 * Locates the captioning runtime (portable Python + faster-whisper + model).
 *
 * The runtime is normally staged by `scripts/setup-whisper.mjs` into
 * `bin/whisper/` and shipped as an extra resource, so captions work on
 * machines with no Python and no network. If that copy is missing at runtime,
 * `self-setup.ts` can download the same stack into the writable root — both
 * locations are searched here, shipped copy first.
 *
 * Layout (identical in both locations):
 *   whisper/python/          CPython 3.12 + faster-whisper
 *   whisper/models/<size>/   converted CTranslate2 model
 *   whisper/transcribe.py    the CLI entry point
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import { devProjectRoot, whisperSearchDirs } from "./paths.js";

export interface WhisperRuntime {
  /** Executable used to run the script (bundled python, or a PATH fallback). */
  python: string;
  /** Absolute path to transcribe.py. */
  script: string;
  /** Folder containing `<model>/model.bin` — passed as argv[3]. */
  modelRoot: string;
  /** Where the interpreter came from, surfaced in Settings → Captions. */
  source: "bundled" | "system";
}

/**
 * Every folder the runtime may be staged in, most authoritative first: the
 * copy shipped inside resources, the dev-staged copy, then whatever
 * `self-setup.ts` downloaded into the writable root.
 */
function runtimeRoots(): string[] {
  return whisperSearchDirs();
}

/** Where findWhisperRuntime looked — surfaced in errors so a missing engine is debuggable. */
export function runtimeSearchRoot(): string {
  return runtimeRoots().join(", ");
}

/**
 * Preferred model size. `base` balances speed and accuracy for captions;
 * it is the size we bundle (141 MB).
 */
export const DEFAULT_MODEL = "base";

/**
 * Files a staged model must have before it counts as usable.
 *
 * Keep in sync with `_REQUIRED` in scripts/transcribe.py. If only `model.bin`
 * is present the Python side treats the folder as "not staged" and tries to
 * download the model over the network, which fails on an offline machine — so
 * checking anything less than the full set reports a false "ready".
 */
export const MODEL_REQUIRED_FILES = ["config.json", "model.bin", "tokenizer.json"] as const;

/** True when `<modelRoot>/<size>` holds a complete, locally runnable model. */
export function isModelReady(modelRoot: string | null, size = DEFAULT_MODEL): boolean {
  if (!modelRoot) return false;
  const dir = join(modelRoot, size);
  return MODEL_REQUIRED_FILES.every((file) => existsSync(join(dir, file)));
}

export function findWhisperRuntime(): WhisperRuntime | null {
  const pyName = process.platform === "win32" ? "python.exe" : "python3";

  // First root that holds a complete runtime wins. Each candidate is
  // self-contained (python/, models/, transcribe.py); a partially staged copy
  // is skipped in favour of a complete one later in the list. The script alone
  // is not enough: without the staged model, transcribe.py falls back to a
  // network download that cannot succeed offline.
  for (const root of runtimeRoots()) {
    const script = join(root, "transcribe.py");
    if (!existsSync(script)) continue;
    const modelRoot = join(root, "models");
    if (!isModelReady(modelRoot)) continue;
    const bundledPython = join(root, "python", pyName);
    return {
      python: existsSync(bundledPython) ? bundledPython : "python",
      script,
      modelRoot,
      source: existsSync(bundledPython) ? "bundled" : "system",
    };
  }

  // Development, before `npm run setup:whisper` has been run: use the source
  // copy of the script and whatever python is on PATH.
  if (!app.isPackaged) {
    const devScript = join(devProjectRoot(), "scripts", "transcribe.py");
    if (existsSync(devScript)) {
      return {
        python: "python",
        script: devScript,
        modelRoot: join(devProjectRoot(), "bin", "whisper", "models"),
        source: "system",
      };
    }
  }

  return null;
}
