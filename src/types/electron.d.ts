/**
 * Type declaration for the Electron preload bridge (window.zf).
 * Kept in one place so renderer code can talk to the main process safely.
 */
import type { ZfApi } from "../electron/preload-types";

declare global {
  interface Window {
    zf: ZfApi;
  }
}

export {};
