import { applyEasing } from "./easing";
import type { AnimatableProperty, Keyframe, Layer, PropertyValue, Transform } from "./types";
import { lerp, lerpColor } from "./util";

export function prop<T extends PropertyValue>(value: T): AnimatableProperty<T> {
  return { value };
}

export function isAnimated(p: AnimatableProperty | undefined): boolean {
  return !!p && !!p.keyframes && p.keyframes.length > 0;
}

/** Interpole deux valeurs (nombres ou couleurs). */
export function interpolateValue<T extends PropertyValue>(a: T, b: T, t: number): T {
  if (typeof a === "number" && typeof b === "number") return lerp(a, b, t) as T;
  if (typeof a === "string" && typeof b === "string") return lerpColor(a, b, Math.min(1, Math.max(0, t))) as T;
  return (t < 1 ? a : b) as T;
}

/**
 * Évalue une propriété animable au temps donné.
 * Avant la première keyframe : valeur de la première. Après la dernière : valeur de la dernière.
 * Entre deux keyframes : l'easing de la keyframe de gauche s'applique au segment.
 */
export function evaluate<T extends PropertyValue>(p: AnimatableProperty<T> | undefined, time: number, fallback?: T): T {
  if (!p) return fallback as T;
  const kfs = p.keyframes;
  if (!kfs || kfs.length === 0) return p.value;
  if (kfs.length === 1 || time <= kfs[0].time) return kfs[0].value;
  const last = kfs[kfs.length - 1];
  if (time >= last.time) return last.value;
  // Recherche dichotomique du segment.
  let lo = 0;
  let hi = kfs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (kfs[mid].time <= time) lo = mid;
    else hi = mid;
  }
  const k0 = kfs[lo];
  const k1 = kfs[hi];
  const span = k1.time - k0.time;
  const raw = span <= 0 ? 1 : (time - k0.time) / span;
  const eased = applyEasing(k0.easing, raw);
  return interpolateValue(k0.value, k1.value, eased);
}

export function sortKeyframes<T extends PropertyValue>(kfs: Keyframe<T>[]): Keyframe<T>[] {
  return kfs.sort((a, b) => a.time - b.time);
}

export interface EvaluatedTransform {
  anchorX: number;
  anchorY: number;
  positionX: number;
  positionY: number;
  scaleX: number;
  scaleY: number;
  rotation: number;
  opacity: number;
}

export function evaluateTransform(t: Transform, time: number): EvaluatedTransform {
  return {
    anchorX: evaluate(t.anchorX, time),
    anchorY: evaluate(t.anchorY, time),
    positionX: evaluate(t.positionX, time),
    positionY: evaluate(t.positionY, time),
    scaleX: evaluate(t.scaleX, time),
    scaleY: evaluate(t.scaleY, time),
    rotation: evaluate(t.rotation, time),
    opacity: evaluate(t.opacity, time),
  };
}

export function isLayerActive(layer: Layer, time: number): boolean {
  return layer.visible && time >= layer.inPoint && time < layer.outPoint;
}

/** Résout un chemin de propriété ("transform.positionX", "props.fill", "effects.<id>.radius"). */
export function getPropertyAtPath(layer: Layer, path: string): AnimatableProperty | undefined {
  const parts = path.split(".");
  if (parts[0] === "transform" && parts.length === 2) return (layer.transform as any)[parts[1]];
  if (parts[0] === "props" && parts.length === 2) {
    const v = (layer.props as any)[parts[1]];
    return v && typeof v === "object" && "value" in v ? v : undefined;
  }
  if (parts[0] === "effects" && parts.length === 3) {
    const fx = layer.effects.find((e) => e.id === parts[1] || e.type === parts[1]);
    return fx?.params[parts[2]];
  }
  if (parts[0] === "masks" && parts.length === 3) {
    const m = layer.masks.find((e) => e.id === parts[1]);
    return m ? (m as any)[parts[2]] : undefined;
  }
  // Raccourcis : "positionX" → transform.positionX ; "fill" → props.fill
  if (parts.length === 1) {
    if (parts[0] in layer.transform) return (layer.transform as any)[parts[0]];
    const v = (layer.props as any)[parts[0]];
    return v && typeof v === "object" && "value" in v ? v : undefined;
  }
  return undefined;
}

/** Normalise un chemin court en chemin canonique. */
export function canonicalPath(layer: Layer, path: string): string {
  if (path.includes(".")) return path;
  if (path in layer.transform) return `transform.${path}`;
  return `props.${path}`;
}

/** Liste tous les chemins de propriétés animables d'un calque. */
export function listAnimatablePaths(layer: Layer): string[] {
  const out: string[] = [];
  for (const k of Object.keys(layer.transform)) out.push(`transform.${k}`);
  for (const [k, v] of Object.entries(layer.props)) {
    if (v && typeof v === "object" && "value" in (v as object)) out.push(`props.${k}`);
  }
  for (const fx of layer.effects) for (const k of Object.keys(fx.params)) out.push(`effects.${fx.id}.${k}`);
  for (const m of layer.masks) out.push(`masks.${m.id}.feather`, `masks.${m.id}.opacity`);
  return out;
}
