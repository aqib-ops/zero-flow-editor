# Zero Flow — offline desktop video editor

A local video editor that runs on your PC, not in a browser. Import clips, arrange
them on a timeline, add captions and overlays, then export real H.264 video with
FFmpeg.

Nothing is uploaded anywhere. There is no server, no account and no network call.

## Running it

```bash
npm install
npm run dev
```

`npm run dev` starts the Vite renderer and launches Electron against it in one
step. Edits to the UI hot-reload; edits to `electron/` restart the window.

To run without dev tooling:

```bash
npm run build
npm start
```

## Requirements

### 1. FFmpeg (Required for Export & Video Probing)
Export needs FFmpeg on this machine. The app looks for it on your `PATH` first,
then in the usual install folders (including the Gyan.dev winget location).

```bash
ffmpeg -version
```
If the top bar says **FFmpeg missing**, install it (e.g. `winget install Gyan.FFmpeg`) and restart Zero Flow.

### 2. Python & Whisper (Required for AI Auto-Captions)
The 1-click auto-captioning feature uses a local OpenAI Whisper model.

```bash
pip install openai-whisper
```
It runs offline on your machine using the `tiny` model.

## What it does

- **Import** video, images and audio from anywhere on your disk (click the panel,
  or drag in from a folder window).
- **Timeline** with multi-track video, audio, overlay and text lanes. Drag to
  move, drag the edges to trim, drag between lanes of the same kind, ctrl+wheel
  to zoom, magnet snapping, per-track mute/hide/lock.
- **Overlays** — bring your own overlay videos (MP4/MOV/WebM with alpha) or use
  the built-in grain, dust, vignette, scanlines, particles and light leak. Every
  overlay is a real timeline clip: move it, trim it, retime it, fade it, and
  change its blend mode (14 to pick from: screen, multiply, overlay, soft-light,
  luminosity…).
- **Captions** — type text and split it into timed cards, or paste a timing list
  and let the app generate captions and place your assets to match. Seven caption
  presets, each with adjustable size, colour, stroke, position and letter spacing.
- **Motion** — Ken Burns zoom/pan per clip, plus snappy transitions (hard cut,
  slide, push, wipe, flash, zoom pop).
- **Export** — 720p to 4K at 24/30/60 fps, adjustable bitrate, MP4/MOV/MKV,
  faststart-enabled, mixed audio from every audio and video clip.

## Keyboard

| Key | Action |
| --- | --- |
| `Space` | Play / pause |
| `S` | Cut the clip under the playhead |
| `Delete` | Delete selected clips |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `←` `→` | Step one frame (hold `Shift` for one second) |
| `Home` / `End` | Jump to start / end |
| `Ctrl` + wheel | Zoom the timeline |

## How it works

```
src/lib/editor/      compositor, store, export, script parsing, styles
src/components/      React UI (panels, timeline, preview)
electron/            main process: ffmpeg bridge, dialogs, window chrome
```

The preview composites every frame onto a `<canvas>`. Export reuses that exact
function and streams the RGBA frames to the main process, where FFmpeg encodes
them into H.264 video and mixes the audio tracks onto one bed. That is why the
exported file matches what you saw — there is one compositor, not two.

During export, source video and audio elements are seeked to the exact position
each frame needs before it is drawn, so the result never depends on how fast
your machine happens to be playing back.

## Project layout

```
src/
  App.tsx              provider shell
  main.tsx             renderer entry
  styles.css           design tokens (Tailwind v4)
  types/window.d.ts    window.zf bridge types
  lib/editor/          types, media, store, render, styles, export, script
  components/editor/   Editor, Preview, Timeline, panels
electron/
  main.ts              window + IPC
  preload.ts           contextBridge surface
  preload-types.ts     shared types
scripts/
  build-electron.mjs   esbuild bundle for main/preload
  dev-electron.mjs     waits for Vite, then launches Electron
```

## Saving projects

**Save** writes a `.zfp` file (JSON) holding your settings, tracks, clips and the
absolute paths of your media. **Open** restores it — the media must still be on
disk at the same paths. Because the project references files by path rather than
copying them, projects stay small.

## Notes for editing this

- The project aspect ratio drives both the preview and the export size, so
  framing never shifts between them. Pick the ratio before you place captions.
- Overlay blend modes and caption fonts are resolved in the renderer, so they
  look identical in the preview and the export.
- Electron history is not rewritten by this app; if you connect this folder to a
  git remote, push normally.
