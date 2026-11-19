let counter = 0;

/** Identifiant court, unique dans une session et très improbable à collisionner entre sessions. */
export function uid(prefix = "id"): string {
  counter = (counter + 1) % 1_000_000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

const NAMED: Record<string, string> = {
  white: "#ffffff",
  black: "#000000",
  red: "#ff3b30",
  green: "#34c759",
  blue: "#0a84ff",
  yellow: "#ffd60a",
  orange: "#ff9f0a",
  purple: "#bf5af2",
  pink: "#ff375f",
  cyan: "#64d2ff",
  gray: "#8e8e93",
  grey: "#8e8e93",
  transparent: "#00000000",
};

export function normalizeColor(input: string): string {
  const s = input.trim().toLowerCase();
  if (NAMED[s]) return NAMED[s];
  if (/^#[0-9a-f]{3}$/.test(s)) return "#" + s.slice(1).split("").map((c) => c + c).join("");
  if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) return s;
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(",").map((p) => parseFloat(p));
    const [r, g, b, a = 1] = parts;
    return rgbaToHex({ r, g, b, a });
  }
  throw new Error(`Couleur invalide: "${input}" (attendu: #rrggbb, #rrggbbaa, rgb(), rgba() ou un nom simple)`);
}

export function isColorString(v: unknown): v is string {
  if (typeof v !== "string") return false;
  try {
    normalizeColor(v);
    return true;
  } catch {
    return false;
  }
}

export function hexToRgba(hex: string): RGBA {
  const h = normalizeColor(hex).slice(1);
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

export function rgbaToHex({ r, g, b, a }: RGBA): string {
  const c = (v: number) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0");
  const base = `#${c(r)}${c(g)}${c(b)}`;
  return a >= 1 ? base : base + c(a * 255);
}

export function lerpColor(a: string, b: string, t: number): string {
  const ca = hexToRgba(a);
  const cb = hexToRgba(b);
  return rgbaToHex({
    r: lerp(ca.r, cb.r, t),
    g: lerp(ca.g, cb.g, t),
    b: lerp(ca.b, cb.b, t),
    a: lerp(ca.a, cb.a, t),
  });
}

export function toCssColor(hex: string, alphaMul = 1): string {
  const { r, g, b, a } = hexToRgba(hex);
  return `rgba(${r},${g},${b},${+(a * alphaMul).toFixed(4)})`;
}

/** PRNG déterministe (mulberry32) : indispensable pour des particules reproductibles au rendu. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bruit pseudo-aléatoire lisse 1D (value noise), pour les tremblements de caméra. */
export function smoothNoise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const h = (n: number) => {
    const s = Math.sin((n + seed * 101.3) * 127.1) * 43758.5453;
    return (s - Math.floor(s)) * 2 - 1;
  };
  const u = f * f * (3 - 2 * f);
  return lerp(h(i), h(i + 1), u);
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export function round(v: number, digits = 4): number {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}
