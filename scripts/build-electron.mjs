import { build } from "esbuild";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist-electron");

await build({
  entryPoints: [join(root, "electron", "main.ts"), join(root, "electron", "preload.ts")],
  outdir: out,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  minify: false,
  // electron-updater reads app-update.yml at runtime and must not be inlined —
  // it resolves native paths relative to process.resourcesPath.
  external: ["electron", "electron-updater"],
  // scripts/transcribe.py is embedded as a string so self-setup.ts can write it
  // next to the downloaded runtime (Python cannot read files out of app.asar).
  loader: { ".py": "text" },
  // Electron's ESM loader needs explicit .js specifiers — tsc keeps them from
  // the source, so nothing to rewrite here.
  logLevel: "info",
});

console.log("electron built -> dist-electron");
