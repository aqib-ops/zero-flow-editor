<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

# Zero Flow — AI Agent Setup & Development Guide

Zero Flow is an offline desktop video editor built with **Electron 37**, **React 19**, **Tailwind CSS v4**, and **Vite 7**. Video rendering and exports are powered directly by local **FFmpeg** and speech transcription is powered by local **OpenAI Whisper**.

---

## 1. System Requirements & Prerequisites

Any AI agent or developer running this repository needs three components:

1. **Node.js (v18+) & npm**:
   ```bash
   npm install
   ```

2. **FFmpeg (Required for Export & Video Probing)**:
   - FFmpeg and FFprobe must be available on the system `PATH`.
   - On Windows: `winget install Gyan.FFmpeg` or download from [gyan.dev/ffmpeg](https://www.gyan.dev/ffmpeg/builds/).
   - Verification: `ffmpeg -version` and `ffprobe -version`.

3. **Python 3.10+ & Whisper (Required for AI Auto-Captions)**:
   - The AI auto-captioning feature executes `python scripts/transcribe.py <media_path> tiny`.
   - Install dependencies:
     ```bash
     pip install openai-whisper
     ```
   - Whisper runs entirely locally using the `tiny` model (cached in `~/.cache/whisper`).

---

## 2. Common Commands

| Command | Purpose |
| --- | --- |
| `npm install` | Install all Node.js dependencies |
| `npm run dev` | Concurrently start Vite dev server & launch Electron (`node scripts/dev-electron.mjs`) |
| `npm run build:check` | Run TypeScript checks on both Electron and React code (`tsc -p tsconfig.electron.json --noEmit && tsc --noEmit`) |
| `npm run build` | Build production bundles (`vite build && node scripts/build-electron.mjs`) |
| `npm start` | Run the built production Electron app |

---

## 3. Architecture & Core Mechanisms

- **Custom Streaming Protocol (`zf-media://`)**:
  - Registered in `electron/main.ts` as a privileged scheme.
  - Used by `src/lib/editor/media.ts` via `toFileUrl(path)`.
  - Bypasses Chromium's `file://` local resource security blocks and provides HTTP 206 Partial Content range requests for seamless `<video>` and `<audio>` seeking.

- **Compositor & Canvas Renderer (`src/lib/editor/render.ts`)**:
  - The preview player renders timeline frames onto an HTML5 `<canvas>` via `renderFrame()`.
  - Video export in `src/lib/editor/export.ts` uses the exact same compositor: it seeks assets deterministically per frame and streams raw RGBA buffers to FFmpeg through IPC (`render:frame`), guaranteeing 100% visual parity between preview and final video.

- **CapCut-Style Export Dialog (`src/components/editor/ExportDialog.tsx`)**:
  - Modal with resolution presets (720p to 4K), frame rates (24, 30, 60 fps), formats (MP4, MOV, MKV), bitrate slider, estimated file size, and progress modal with "Open in Folder".

- **Foldable Captions Panel (`src/components/editor/TextPanel.tsx`)**:
  - Whisper Tiny auto-transcription with 1-click timeline placement.
  - Foldable Caption Settings & Foldable Animation Style selector (`None/Static`, `Smooth Fade`, `Slide Up`, `Slide Left`, `Punch In`, `Elastic Pop`).

---

## 4. Critical Rules for AI Agents

1. **Aspect Ratio Parity**: Always preserve project aspect ratio in `state.settings.aspectRatio` and compute dimensions via `resolveExportSize()`. Preview and export must share the exact same aspect ratio.
2. **Git Integrity**: Never rebase, squash, or force-push commits already synced with Lovable remote.
3. **Deterministic Typechecking**: Always verify changes before completion using `npm run build:check`.

