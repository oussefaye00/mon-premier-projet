import { prop } from "./animation";
import type { Effect, PropertyValue } from "./types";
import { uid } from "./util";

export interface EffectParamDef {
  key: string;
  label: string;
  kind: "number" | "color";
  default: PropertyValue;
  min?: number;
  max?: number;
  step?: number;
}

export interface EffectDef {
  type: string;
  label: string;
  category: "flou" | "lumière" | "couleur" | "stylisation" | "mouvement";
  description: string;
  params: EffectParamDef[];
}

/**
 * Registre extensible des effets. Pour ajouter un effet : enregistrer sa définition
 * ici (registerEffect) puis son implémentation de rendu dans @amai/renderer
 * (registerEffectRenderer). Le reste (UI, IA, MCP) le découvre automatiquement.
 */
const registry = new Map<string, EffectDef>();

export function registerEffect(def: EffectDef): void {
  registry.set(def.type, def);
}

export function getEffectDef(type: string): EffectDef | undefined {
  return registry.get(type);
}

export function listEffectDefs(): EffectDef[] {
  return [...registry.values()];
}

export function createEffect(type: string, params: Record<string, PropertyValue> = {}): Effect {
  const def = registry.get(type);
  if (!def) throw new Error(`Effet inconnu: "${type}". Effets disponibles: ${[...registry.keys()].join(", ")}`);
  const out: Effect = { id: uid("fx"), type, enabled: true, params: {} };
  for (const p of def.params) {
    const v = params[p.key] ?? p.default;
    out.params[p.key] = prop(v);
  }
  for (const k of Object.keys(params)) {
    if (!def.params.some((p) => p.key === k)) {
      throw new Error(`Paramètre "${k}" inconnu pour l'effet ${type}. Paramètres: ${def.params.map((p) => p.key).join(", ")}`);
    }
  }
  return out;
}

const n = (key: string, label: string, def: number, min: number, max: number, step = 1): EffectParamDef => ({
  key,
  label,
  kind: "number",
  default: def,
  min,
  max,
  step,
});
const c = (key: string, label: string, def: string): EffectParamDef => ({ key, label, kind: "color", default: def });

[
  {
    type: "gaussianBlur",
    label: "Flou gaussien",
    category: "flou",
    description: "Flou gaussien uniforme.",
    params: [n("radius", "Rayon", 8, 0, 200)],
  },
  {
    type: "glow",
    label: "Lueur (Glow)",
    category: "lumière",
    description: "Halo lumineux additif autour des zones visibles du calque.",
    params: [n("radius", "Rayon", 20, 0, 200), n("intensity", "Intensité", 1, 0, 5, 0.05), c("color", "Couleur", "#ffffff")],
  },
  {
    type: "dropShadow",
    label: "Ombre portée",
    category: "lumière",
    description: "Ombre portée douce.",
    params: [
      c("color", "Couleur", "#000000"),
      n("opacity", "Opacité", 0.6, 0, 1, 0.01),
      n("distance", "Distance", 12, 0, 500),
      n("angle", "Angle", 135, 0, 360),
      n("softness", "Douceur", 16, 0, 200),
    ],
  },
  {
    type: "brightnessContrast",
    label: "Luminosité / Contraste",
    category: "couleur",
    description: "Ajuste luminosité et contraste (1 = neutre).",
    params: [n("brightness", "Luminosité", 1, 0, 3, 0.01), n("contrast", "Contraste", 1, 0, 3, 0.01)],
  },
  {
    type: "hueSaturation",
    label: "Teinte / Saturation",
    category: "couleur",
    description: "Rotation de teinte (degrés) et saturation (1 = neutre).",
    params: [n("hue", "Teinte", 0, -180, 180), n("saturation", "Saturation", 1, 0, 3, 0.01)],
  },
  {
    type: "tint",
    label: "Teinte couleur",
    category: "couleur",
    description: "Recolore le calque vers une couleur.",
    params: [c("color", "Couleur", "#ff375f"), n("amount", "Quantité", 1, 0, 1, 0.01)],
  },
  {
    type: "grayscale",
    label: "Noir & blanc",
    category: "couleur",
    description: "Désature le calque.",
    params: [n("amount", "Quantité", 1, 0, 1, 0.01)],
  },
  {
    type: "invert",
    label: "Inverser",
    category: "couleur",
    description: "Inverse les couleurs.",
    params: [n("amount", "Quantité", 1, 0, 1, 0.01)],
  },
  {
    type: "pixelate",
    label: "Pixellisation",
    category: "stylisation",
    description: "Effet mosaïque.",
    params: [n("size", "Taille des pixels", 12, 1, 200)],
  },
  {
    type: "vignette",
    label: "Vignettage",
    category: "stylisation",
    description: "Assombrit les bords du calque.",
    params: [n("amount", "Intensité", 0.6, 0, 1, 0.01), n("size", "Taille", 0.6, 0.05, 1.5, 0.01)],
  },
  {
    type: "shake",
    label: "Tremblement",
    category: "mouvement",
    description: "Tremblement pseudo-aléatoire déterministe (caméra à l'épaule, impact).",
    params: [n("amplitude", "Amplitude (px)", 12, 0, 500), n("frequency", "Fréquence (Hz)", 6, 0, 60, 0.1), n("rotation", "Rotation (°)", 1.5, 0, 45, 0.1)],
  },
].forEach((d) => registerEffect(d as EffectDef));
