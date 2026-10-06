import sys
import json
import os
import contextlib

def transcribe():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "No media path provided"}))
        return

    media_path = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "tiny"

    if not os.path.exists(media_path):
        print(json.dumps({"ok": False, "error": f"File does not exist: {media_path}"}))
        return

    try:
        import whisper
        # Suppress any library prints (e.g. "Detected language: English") to stdout
        with contextlib.redirect_stdout(sys.stderr):
            model = whisper.load_model(model_name)
            result = model.transcribe(
                media_path,
                fp16=False,
                verbose=False,
                word_timestamps=False
            )
        
        segments = []
        for s in result.get("segments", []):
            text = s.get("text", "").strip()
            if not text:
                continue
            segments.append({
                "start": float(s["start"]),
                "end": float(s["end"]),
                "duration": float(s["end"] - s["start"]),
                "text": text
            })

        print(json.dumps({"ok": True, "segments": segments}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))

if __name__ == "__main__":
    transcribe()

