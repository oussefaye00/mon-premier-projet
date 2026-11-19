import type { Easing } from "./types";

/**
 * Évalue une courbe de Bézier cubique CSS (P0=(0,0), P3=(1,1)) : renvoie y pour x.
 * Résolution par Newton-Raphson puis dichotomie en secours (comme les navigateurs).
 * y1/y2 peuvent sortir de [0,1] (dépassement / overshoot).
 */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;

  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-7) return sampleY(t);
    const d = sampleDX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 40; i++) {
    const v = sampleX(t);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

function bounceOut(t: number): number {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

function elasticOut(t: number): number {
  if (t === 0 || t === 1) return t;
  const c4 = (2 * Math.PI) / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
}

function backOut(t: number, s = 1.70158): number {
  const c3 = s + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
}

/** Applique une courbe d'easing à une progression t ∈ [0,1]. */
export function applyEasing(easing: Easing | undefined, t: number): number {
  const p = Math.min(1, Math.max(0, t));
  if (!easing) return p;
  switch (easing.type) {
    case "linear":
      return p;
    case "hold":
      return p >= 1 ? 1 : 0;
    case "bezier":
      return cubicBezier(easing.x1, easing.y1, easing.x2, easing.y2, p);
    case "bounce":
      return bounceOut(p);
    case "elastic":
      return elasticOut(p);
    case "back":
      return backOut(p, easing.overshoot ?? 1.70158);
  }
}

/** Courbes prédéfinies (noms utilisés par l'UI, l'IA et le MCP). */
export const EASING_PRESETS: Record<string, Easing> = {
  linear: { type: "linear" },
  hold: { type: "hold" },
  ease: { type: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  easeIn: { type: "bezier", x1: 0.42, y1: 0, x2: 1, y2: 1 },
  easeOut: { type: "bezier", x1: 0, y1: 0, x2: 0.58, y2: 1 },
  easeInOut: { type: "bezier", x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  smooth: { type: "bezier", x1: 0.4, y1: 0, x2: 0.2, y2: 1 },
  expoOut: { type: "bezier", x1: 0.16, y1: 1, x2: 0.3, y2: 1 },
  expoInOut: { type: "bezier", x1: 0.87, y1: 0, x2: 0.13, y2: 1 },
  backOut: { type: "back", overshoot: 1.70158 },
  anticipate: { type: "bezier", x1: 0.68, y1: -0.55, x2: 0.27, y2: 1.55 },
  bounce: { type: "bounce" },
  elastic: { type: "elastic" },
};

export type EasingName = keyof typeof EASING_PRESETS;

export function resolveEasing(e: Easing | string | undefined): Easing {
  if (!e) return EASING_PRESETS.easeInOut;
  if (typeof e === "string") {
    const preset = EASING_PRESETS[e];
    if (!preset) throw new Error(`Easing inconnu: "${e}". Valeurs possibles: ${Object.keys(EASING_PRESETS).join(", ")}`);
    return { ...preset };
  }
  return e;
}
