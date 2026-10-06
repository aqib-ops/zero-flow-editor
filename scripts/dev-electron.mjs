/**
 * Dev launcher: waits for the Vite server, then starts Electron pointed at it.
 * Rebuilds the main/preload bundle each run so main-process edits take effect.
 */
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, rmSync, mkdirSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const devServerUrl = process.env.VITE_DEV_SERVER_URL ?? "http://localhost:5173";
const port = new URL(devServerUrl).port;
const electronBin = join(root, "node_modules", "electron", "dist", "electron.exe");

if (!existsSync(electronBin)) {
  console.error("[dev-electron] electron binary not found. Run `npm install` first.");
  process.exit(1);
}

const distElectron = join(root, "dist-electron");
if (existsSync(distElectron)) rmSync(distElectron, { recursive: true, force: true });
mkdirSync(distElectron, { recursive: true });

// Build main + preload once up front.
const build = spawn(
  process.execPath,
  [join(root, "scripts", "build-electron.mjs")],
  { stdio: "inherit", cwd: root },
);
build.on("exit", (code) => {
  if (code !== 0) {
    console.error("[dev-electron] electron build failed");
    process.exit(code ?? 1);
  }
  waitForVite();
});

function waitForVite() {
  const started = Date.now();
  const poll = async () => {
    try {
      const res = await fetch(devServerUrl, { signal: AbortSignal.timeout(1500) });
      if (res.ok || res.status > 0) return launch();
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > 60_000) {
      console.error(`[dev-electron] vite never came up at ${devServerUrl}`);
      process.exit(1);
    }
    setTimeout(poll, 400);
  };
  void poll();
}

function launch() {
  console.log(`[dev-electron] launching electron on port ${port}`);
  const electron = spawn(
    electronBin,
    ["--no-sandbox", join(root, "dist-electron", "main.js")],
    { stdio: "inherit", cwd: root, env: { ...process.env, VITE_DEV_SERVER_URL: devServerUrl } },
  );
  electron.on("exit", (code) => process.exit(code ?? 0));
  const stop = () => {
    try {
      electron.kill();
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
