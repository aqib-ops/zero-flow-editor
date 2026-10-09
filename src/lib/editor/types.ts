export type AssetKind = "image" | "audio" | "video" | "overlay";

export interface MediaAsset {
  id: string;
  name: string;
  kind: AssetKind;
  /** Absolute filesystem path — the source of truth for both preview and export. */
  path: string;
  /** URL usable by <img>/<video> in the renderer (file:// or blob:). */
  url: string;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  thumb?: string;
}

export type TrackKind = "video" | "audio" | "text" | "overlay";

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  muted?: boolean;
  hidden?: boolean;
  locked?: boolean;
}

export type AnimationKind =
  | "none"
  | "zoomIn"
  | "zoomOut"
  | "panLeft"
  | "panRight"
  | "panUp"
  | "panDown";

export type TransitionKind =
  | "none"
  | "fade"
  | "slideLeft"
  | "slideUp"
  | "wipe"
  | "push"
  | "flash"
  | "zoomPop";

/** Built-in procedural overlays. */
export type BuiltinOverlayKind = "grain" | "particles" | "dust" | "vignette" | "scanlines" | "light";

export type OverlaySource =
  | { type: "builtin"; kind: BuiltinOverlayKind }
  | { type: "video"; assetId: string }
  | { type: "image"; assetId: string };

export interface CaptionStyle {
  id: string;
  name: string;
  font: string;
  size: number;
  weight: number;
  color: string;
  stroke: string;
  strokeWidth: number;
  background: string | null;
  uppercase: boolean;
  shadow: boolean;
  letterSpacing: number;
  singleLine?: boolean;
}

/** Vertical placement of a text clip, as a fraction of canvas height (0=top, 1=bottom). */
export type TextAnchor = "top" | "middle" | "bottom";

export interface Clip {
  id: string;
  trackId: string;
  kind: TrackKind;
  name: string;
  assetId?: string;
  start: number;
  duration: number;
  offset: number;
  speed: number;
  volume: number;
  animation: AnimationKind;
  animationAmount: number;
  transition: TransitionKind;
  transitionDuration: number;
  opacity: number;
  blend: GlobalCompositeOperation;
  // text clips
  text?: string;
  styleId?: string;
  /** Override the style's size fraction; undefined means "use the style". */
  sizeScale?: number;
  anchor?: TextAnchor;
  singleLine?: boolean;
  letterSpacing?: number;
  wordSpacing?: number;
  lineHeight?: number;
  // overlay clips
  overlay?: OverlaySource;
}

export interface ProjectSettings {
  width: number;
  height: number;
  aspectRatio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9" | "4:5";
  fps: number;
  background: string;
}

export interface EditorState {
  assets: MediaAsset[];
  tracks: Track[];
  clips: Clip[];
  settings: ProjectSettings;
  selectedClipIds: string[];
  playhead: number;
  playing: boolean;
  zoom: number;
  snap: boolean;
}

export interface ScriptLine {
  index: number;
  label: string;
  start: number;
  end: number;
  duration: number;
  text: string;
}

/** Serialisable project file shape. */
export interface ProjectFile {
  version: 1;
  settings: ProjectSettings;
  tracks: Track[];
  clips: Clip[];
  assets: Array<
    Pick<
      MediaAsset,
      "id" | "name" | "kind" | "path" | "duration" | "width" | "height" | "hasAudio" | "thumb"
    >
  >;
}
