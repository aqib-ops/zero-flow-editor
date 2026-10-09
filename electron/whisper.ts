/**
 * Locates the captioning runtime (portable Python + faster-whisper + model).
 *
 * Everything is staged by `scripts/setup-whisper.mjs` into `bin/whisper/` and
 * shipped as an extra resource, so captions work on machines with no Python
 * and no network.
 *
 * Layout:
 *   bin/whisper/python/          CPython 3.12 + faster-whisper
 *   bin/whisper/models/<size>/   converted CTranslate2 model
 *   bin/whisper/transcribe.py    the CLI entry point
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

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

/** Root of the staged runtime: inside resources when packaged, project when dev. */
function runtimeRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "bin", "whisper")
    : join(app.getAppPath(), "bin", "whisper");
}

/**
 * Preferred model size. `base` balances speed and accuracy for captions;
 * it is the size we bundle (141 MB).
 */
export const DEFAULT_MODEL = "base";

export function findWhisperRuntime(): WhisperRuntime | null {
  const root = runtimeRoot();
  const bundledPython = join(root, "python", process.platform === "win32" ? "python.exe" : "python3");
  const script = join(root, "transcribe.py");
  const modelRoot = join(root, "models");

  if (existsSync(script)) {
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
    const devScript = join(app.getAppPath(), "scripts", "transcribe.py");
    if (existsSync(devScript)) {
      return { python: "python", script: devScript, modelRoot, source: "system" };
    }
  }

  return null;
}
