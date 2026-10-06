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
  external: ["electron"],
  // Electron's ESM loader needs explicit .js specifiers — tsc keeps them from
  // the source, so nothing to rewrite here.
  logLevel: "info",
});

console.log("electron built -> dist-electron");
