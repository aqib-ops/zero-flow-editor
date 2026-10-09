"""
Zero Flow — speech-to-text for AI captions.

Runs faster-whisper (CTranslate2) instead of openai-whisper: ~4x faster on
CPU, no PyTorch, and the models are plain directories we can bundle next to
the app.

Usage:
    python transcribe.py <media_path> [model] [model_root]

  model       size name: tiny | base | small | medium | large-v3 | turbo
  model_root  folder that contains `<model>/model.bin`. When a matching
              subfolder exists the model is loaded straight from disk and no
              network access happens, so captions work fully offline.

Prints a single JSON object on stdout — see the contract in
`electron/preload-types.ts`. Everything the libraries write to stdout (tqdm
bars, HF logs) is redirected to stderr so stdout stays valid JSON.
"""
import sys
import json
import os
import contextlib

# Model files we accept as "present" before treating a folder as usable.
_REQUIRED = ("model.bin", "config.json", "tokenizer.json")


def _emit(payload):
    sys.stdout.write(json.dumps(payload))


def _resolve(model, model_root):
    """Return (model_size_or_path, download_root)."""
    # 1. An explicit path to a converted model directory.
    if os.path.isdir(model):
        return model, None

    # 2. A bundled copy: <model_root>/<model>/model.bin
    if model_root:
        candidate = os.path.join(model_root, model)
        if all(os.path.isfile(os.path.join(candidate, f)) for f in _REQUIRED):
            return candidate, None

    # 3. Nothing local — faster-whisper has to fetch it. The bundled models
    #    folder lives under Program Files once installed, which is read-only
    #    for a normal user, so fall back to a per-user cache we own.
    return model, _download_dir(model_root)


def _download_dir(preferred):
    """First writable location for models fetched on demand."""
    candidates = [preferred]
    candidates.append(os.path.join(os.path.expanduser("~"), ".cache", "zero-flow", "whisper"))
    for path in candidates:
        if not path:
            continue
        try:
            os.makedirs(path, exist_ok=True)
            probe = os.path.join(path, ".write-test")
            with open(probe, "w"):
                pass
            os.remove(probe)
            return path
        except Exception:
            continue
    return None


def transcribe():
    if len(sys.argv) < 2:
        _emit({"ok": False, "error": "No media path provided"})
        return

    media_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "base"
    model_root = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None

    if not os.path.exists(media_path):
        _emit({"ok": False, "error": "File does not exist: %s" % media_path})
        return

    if model_root:
        # The bundled models folder already exists; if it somehow doesn't and
        # is read-only (Program Files), ignore — _download_dir handles writes.
        try:
            os.makedirs(model_root, exist_ok=True)
        except OSError:
            pass

    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - environment problem
        _emit({"ok": False, "error": "faster-whisper is not installed: %s" % exc})
        return

    model_path, download_root = _resolve(model_name, model_root)

    # Model loading writes a tqdm progress bar to stdout on some versions,
    # which would corrupt the single-JSON-line contract. Keep stdout clean for
    # the whole library call and only emit at the very end.
    try:
        with contextlib.redirect_stdout(sys.stderr):
            # int8 is 4x smaller and much faster than the default on CPU; on a GPU
            # it is still correct, just slightly less accurate than float16.
            model = WhisperModel(
                model_path,
                device="cpu",
                compute_type="int8",
                cpu_threads=0,
                download_root=download_root,
                local_files_only=download_root is None and os.path.isdir(str(model_path)),
            )

            # Silero VAD ships inside faster-whisper's package assets, so this
            # costs no extra download — it just strips silence and speeds things
            # up considerably on speech with pauses.
            segments_out = []
            segments, info = model.transcribe(
                media_path,
                beam_size=5,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                word_timestamps=False,
            )
            for s in segments:
                text = (s.text or "").strip()
                if not text:
                    continue
                start = float(s.start)
                end = float(s.end)
                segments_out.append(
                    {
                        "start": start,
                        "end": end,
                        "duration": round(end - start, 3),
                        "text": text,
                    }
                )

        _emit(
            {
                "ok": True,
                "language": getattr(info, "language", None),
                "duration": round(float(getattr(info, "duration", 0.0) or 0.0), 3),
                "segments": segments_out,
            }
        )
    except Exception as exc:
        _emit({"ok": False, "error": str(exc)})


if __name__ == "__main__":
    transcribe()
