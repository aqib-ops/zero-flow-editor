import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Renderer build for the Electron app.
// - Absolute asset URLs so file:// loading never breaks.
// - output to dist/renderer, Electron entry compiled separately from electron/.
export default defineConfig({
  root: r("./src"),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": r("./src") },
  },
  build: {
    outDir: r("dist/renderer"),
    emptyOutDir: false,
    target: "chrome138",
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: r("src/index.html"),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
