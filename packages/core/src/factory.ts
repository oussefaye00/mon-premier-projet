import { prop } from "./animation";
import type { Asset, Composition, Layer, LayerProps, LayerType, Project, Transform } from "./types";
import { uid } from "./util";

export const PROJECT_VERSION = 1;

export interface CompositionOptions {
  name?: string;
  width?: number;
  height?: number;
  fps?: number;
  duration?: number;
  background?: string;
}

export function createComposition(opts: CompositionOptions = {}): Composition {
  return {
    id: uid("comp"),
    name: opts.name ?? "Composition principale",
    width: opts.width ?? 1920,
    height: opts.height ?? 1080,
    fps: opts.fps ?? 30,
    duration: opts.duration ?? 10,
    background: opts.background ?? "#101014",
    layers: [],
    shutterAngle: 180,
    motionBlurSamples: 8,
  };
}

export function createProject(opts: CompositionOptions & { projectName?: string } = {}): Project {
  const comp = createComposition(opts);
  const now = new Date().toISOString();
  return {
    id: uid("proj"),
    name: opts.projectName ?? "Projet sans titre",
    version: PROJECT_VERSION,
    createdAt: now,
    updatedAt: now,
    activeCompositionId: comp.id,
    compositions: [comp],
    assets: [],
  };
}

export function createTransform(x: number, y: number, anchorX = 0, anchorY = 0): Transform {
  return {
    anchorX: prop(anchorX),
    anchorY: prop(anchorY),
    positionX: prop(x),
    positionY: prop(y),
    scaleX: prop(100),
    scaleY: prop(100),
    rotation: prop(0),
    opacity: prop(100),
  };
}

export interface LayerOptions {
  name?: string;
  inPoint?: number;
  outPoint?: number;
  x?: number;
  y?: number;
  props?: Partial<Record<keyof LayerProps, unknown>>;
}

const LAYER_NAMES: Record<LayerType, string> = {
  solid: "Solide",
  shape: "Forme",
  text: "Texte",
  image: "Image",
  video: "Vidéo",
  audio: "Audio",
  particles: "Particules",
  composition: "Composition",
  camera: "Caméra",
  null: "Nul",
};

/** Propriétés par défaut d'un calque selon son type. */
export function defaultProps(type: LayerType, comp: Composition, asset?: Asset): LayerProps {
  switch (type) {
    case "solid":
      return { width: prop(comp.width), height: prop(comp.height), fill: prop("#3a3a48") };
    case "shape":
      return {
        shapeKind: "rectangle",
        width: prop(400),
        height: prop(400),
        fill: prop("#7c5cff"),
        stroke: prop("#ffffff"),
        strokeWidth: prop(0),
        fillEnabled: true,
        strokeEnabled: false,
        cornerRadius: prop(0),
        sides: 5,
        innerRatio: prop(0.45),
        trimStart: prop(0),
        trimEnd: prop(100),
      };
    case "text":
      return {
        text: "Votre texte",
        fontFamily: "Inter, Segoe UI, Roboto, sans-serif",
        fontSize: prop(120),
        fontWeight: 700,
        italic: false,
        align: "center",
        letterSpacing: prop(0),
        lineHeight: 1.2,
        textColor: prop("#ffffff"),
        stroke: prop("#000000"),
        strokeWidth: prop(0),
        textAnimator: "none",
        textProgress: prop(100),
      };
    case "image":
      return { assetId: asset?.id, width: prop(asset?.width ?? 0), height: prop(asset?.height ?? 0) };
    case "video":
      return {
        assetId: asset?.id,
        mediaOffset: 0,
        playbackRate: 1,
        volume: prop(100),
        muted: false,
        width: prop(asset?.width ?? 0),
        height: prop(asset?.height ?? 0),
      };
    case "audio":
      return { assetId: asset?.id, mediaOffset: 0, playbackRate: 1, volume: prop(100), muted: false };
    case "particles":
      return {
        emitterShape: "point",
        emitterSize: prop(200),
        rate: prop(60),
        lifetime: 2,
        speed: prop(350),
        direction: prop(-90),
        spread: prop(60),
        gravity: prop(300),
        particleSize: prop(14),
        particleSizeEnd: prop(2),
        colorStart: prop("#ffd60a"),
        colorEnd: prop("#ff375f00"),
        particleShape: "circle",
        seed: Math.floor(Math.random() * 100000),
      };
    case "composition":
      return {};
    case "camera":
      return { zoom: prop(100) };
    case "null":
      return {};
  }
}

export function createLayer(type: LayerType, comp: Composition, opts: LayerOptions = {}, asset?: Asset): Layer {
  const x = opts.x ?? comp.width / 2;
  const y = opts.y ?? comp.height / 2;
  const inPoint = opts.inPoint ?? 0;
  let outPoint = opts.outPoint ?? comp.duration;
  if ((type === "video" || type === "audio") && asset?.duration && opts.outPoint === undefined) {
    outPoint = Math.min(comp.duration, inPoint + asset.duration);
  }
  const layer: Layer = {
    id: uid("layer"),
    name: opts.name ?? (asset ? asset.name : LAYER_NAMES[type]),
    type,
    inPoint,
    outPoint: Math.max(outPoint, inPoint + 1 / comp.fps),
    visible: true,
    locked: false,
    blendMode: "normal",
    parentId: null,
    transform: createTransform(x, y),
    props: defaultProps(type, comp, asset),
    effects: [],
    masks: [],
    transitionIn: null,
    transitionOut: null,
    motionBlur: false,
  };
  return layer;
}
