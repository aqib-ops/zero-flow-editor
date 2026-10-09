/**
 * Caption model preference — read by the Captions panel, which is the only
 * place it is surfaced. There is deliberately no picker for it: only `base` is
 * bundled with the app (141 MB), so that is what runs. The larger sizes would
 * need a one-time download from Hugging Face, which an offline editor should
 * not quietly depend on.
 */

export const CAPTIONS_MODEL_KEY = "zf.captionsModel";

export interface CaptionsModel {
  id: string;
  label: string;
  /** Rough quality tier — higher is better and slower. */
  quality: string;
  /** Size on disk once installed. */
  size: string;
  bundled: boolean;
}

export const CAPTIONS_MODELS: CaptionsModel[] = [
  { id: "tiny", label: "Tiny", quality: "Fastest, least accurate", size: "75 MB", bundled: false },
  { id: "base", label: "Base", quality: "Good balance", size: "141 MB", bundled: true },
  { id: "small", label: "Small", quality: "Better accuracy", size: "464 MB", bundled: false },
  { id: "medium", label: "Medium", quality: "Best accuracy", size: "1.5 GB", bundled: false },
];

export const DEFAULT_CAPTIONS_MODEL = "base";

export function getCaptionsModel(): string {
  if (typeof localStorage === "undefined") return DEFAULT_CAPTIONS_MODEL;
  const raw = localStorage.getItem(CAPTIONS_MODEL_KEY);
  return CAPTIONS_MODELS.some((m) => m.id === raw) ? (raw as string) : DEFAULT_CAPTIONS_MODEL;
}

export const bundledModel = (): CaptionsModel | undefined =>
  CAPTIONS_MODELS.find((m) => m.bundled);
