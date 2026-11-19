/**
 * AFTER MOTION AI — modèle de données du projet.
 *
 * Toutes les structures sont du JSON pur (sérialisables, clonables) afin que :
 *  - l'historique (undo/redo) puisse reposer sur des patches immer,
 *  - le projet puisse être sauvegardé tel quel (IndexedDB / fichier),
 *  - le serveur MCP et l'IA puissent lire l'état sans adaptation.
 *
 * Conventions :
 *  - les temps sont en secondes, relatifs au début de la composition ;
 *  - les couleurs sont des chaînes hexadécimales "#rrggbb" ou "#rrggbbaa" ;
 *  - dans `Composition.layers`, l'index 0 est le calque du DESSOUS (rendu en premier).
 */

export type Color = string;
export type PropertyValue = number | Color;

/** Courbe d'interpolation appliquée au segment qui commence sur une keyframe. */
export type Easing =
  | { type: "linear" }
  | { type: "hold" }
  | { type: "bezier"; x1: number; y1: number; x2: number; y2: number }
  | { type: "bounce" }
  | { type: "elastic" }
  | { type: "back"; overshoot?: number };

export interface Keyframe<T extends PropertyValue = PropertyValue> {
  id: string;
  time: number;
  value: T;
  easing: Easing;
}

export interface AnimatableProperty<T extends PropertyValue = PropertyValue> {
  value: T;
  keyframes?: Keyframe<T>[];
}

export interface Transform {
  anchorX: AnimatableProperty<number>;
  anchorY: AnimatableProperty<number>;
  positionX: AnimatableProperty<number>;
  positionY: AnimatableProperty<number>;
  scaleX: AnimatableProperty<number>;
  scaleY: AnimatableProperty<number>;
  rotation: AnimatableProperty<number>;
  opacity: AnimatableProperty<number>;
}

export type TransformKey = keyof Transform;
export const TRANSFORM_KEYS: TransformKey[] = [
  "anchorX",
  "anchorY",
  "positionX",
  "positionY",
  "scaleX",
  "scaleY",
  "rotation",
  "opacity",
];

export type LayerType =
  | "solid"
  | "shape"
  | "text"
  | "image"
  | "video"
  | "audio"
  | "particles"
  | "composition"
  | "camera"
  | "null";

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "add"
  | "difference";

export interface Effect {
  id: string;
  type: string;
  enabled: boolean;
  params: Record<string, AnimatableProperty>;
}

export interface MaskPoint {
  x: number;
  y: number;
}

export interface Mask {
  id: string;
  name: string;
  /** Forme de masque : rectangle / ellipse en coordonnées du calque, ou polygone libre. */
  shape: "rectangle" | "ellipse" | "polygon";
  x: number;
  y: number;
  width: number;
  height: number;
  points?: MaskPoint[];
  mode: "add" | "subtract" | "intersect";
  inverted: boolean;
  feather: AnimatableProperty<number>;
  opacity: AnimatableProperty<number>;
}

export type TransitionType =
  | "fade"
  | "slide-left"
  | "slide-right"
  | "slide-up"
  | "slide-down"
  | "zoom"
  | "blur"
  | "wipe";

export interface Transition {
  type: TransitionType;
  duration: number;
}

export type ShapeKind = "rectangle" | "ellipse" | "polygon" | "star" | "path";

export type TextAnimatorType = "none" | "typewriter" | "fade" | "slide-up" | "scale" | "wave";

/**
 * Propriétés spécifiques au type de calque. Les propriétés animables sont des
 * AnimatableProperty ; les autres sont des valeurs simples.
 */
export interface LayerProps {
  // solid / shape
  width?: AnimatableProperty<number>;
  height?: AnimatableProperty<number>;
  fill?: AnimatableProperty<Color>;
  stroke?: AnimatableProperty<Color>;
  strokeWidth?: AnimatableProperty<number>;
  fillEnabled?: boolean;
  strokeEnabled?: boolean;
  shapeKind?: ShapeKind;
  cornerRadius?: AnimatableProperty<number>;
  sides?: number;
  innerRatio?: AnimatableProperty<number>;
  pathData?: string;
  trimStart?: AnimatableProperty<number>;
  trimEnd?: AnimatableProperty<number>;
  // text
  text?: string;
  fontFamily?: string;
  fontSize?: AnimatableProperty<number>;
  fontWeight?: number;
  italic?: boolean;
  align?: "left" | "center" | "right";
  letterSpacing?: AnimatableProperty<number>;
  lineHeight?: number;
  textColor?: AnimatableProperty<Color>;
  textAnimator?: TextAnimatorType;
  textProgress?: AnimatableProperty<number>;
  // media
  assetId?: string;
  /** Décalage dans le média source (secondes) correspondant à inPoint. */
  mediaOffset?: number;
  playbackRate?: number;
  volume?: AnimatableProperty<number>;
  muted?: boolean;
  // composition imbriquée
  compositionId?: string;
  // caméra
  zoom?: AnimatableProperty<number>;
  // particules
  emitterShape?: "point" | "line" | "circle";
  emitterSize?: AnimatableProperty<number>;
  rate?: AnimatableProperty<number>;
  lifetime?: number;
  speed?: AnimatableProperty<number>;
  direction?: AnimatableProperty<number>;
  spread?: AnimatableProperty<number>;
  gravity?: AnimatableProperty<number>;
  particleSize?: AnimatableProperty<number>;
  particleSizeEnd?: AnimatableProperty<number>;
  colorStart?: AnimatableProperty<Color>;
  colorEnd?: AnimatableProperty<Color>;
  particleShape?: "circle" | "square" | "star" | "spark";
  seed?: number;
}

export interface Layer {
  id: string;
  name: string;
  type: LayerType;
  /** Début de la plage visible sur la timeline (s). */
  inPoint: number;
  /** Fin de la plage visible (s). */
  outPoint: number;
  visible: boolean;
  locked: boolean;
  solo?: boolean;
  blendMode: BlendMode;
  parentId?: string | null;
  label?: string;
  transform: Transform;
  props: LayerProps;
  effects: Effect[];
  masks: Mask[];
  transitionIn?: Transition | null;
  transitionOut?: Transition | null;
  motionBlur?: boolean;
}

export interface Composition {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  background: Color;
  layers: Layer[];
  /** Paramètres de motion blur (angle d'obturateur en degrés, nombre d'échantillons). */
  shutterAngle?: number;
  motionBlurSamples?: number;
}

export type AssetKind = "video" | "image" | "audio" | "svg";

export interface Asset {
  id: string;
  name: string;
  kind: AssetKind;
  mimeType: string;
  /** Taille du fichier en octets. */
  size: number;
  width?: number;
  height?: number;
  duration?: number;
  /**
   * Source : "idb:<id>" pour un blob stocké localement par l'éditeur, une URL
   * (http(s)/data/blob) ou un chemin de fichier en mode headless.
   */
  src: string;
}

export interface Project {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  activeCompositionId: string;
  compositions: Composition[];
  assets: Asset[];
}

export type ChangeSource = "user" | "ai" | "mcp" | "system";
