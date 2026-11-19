import type { Draft } from "immer";
import { evaluate } from "./animation";
import { resolveEasing } from "./easing";
import type { AnimatableProperty, Composition, Easing, Layer, PropertyValue } from "./types";
import { uid } from "./util";

/**
 * Presets d'animation : chacun ajoute des keyframes sur un calque (dans un brouillon immer).
 * Ils sont utilisés par le panneau Effets, l'assistant IA et l'outil MCP `create_animation`.
 */
export interface PresetContext {
  layer: Draft<Layer>;
  comp: Composition;
  start: number;
  duration: number;
  intensity: number;
}

export interface PresetDef {
  id: string;
  label: string;
  category: "entrée" | "sortie" | "accentuation" | "texte" | "caméra" | "logo";
  description: string;
  defaultDuration: number;
  apply: (ctx: PresetContext) => void;
}

/** Insère ou remplace une keyframe (même temps à 1 ms près). */
export function upsertKeyframe<T extends PropertyValue>(p: Draft<AnimatableProperty<T>>, time: number, value: T, easing: Easing | string = "easeInOut") {
  const e = resolveEasing(easing);
  if (!p.keyframes) p.keyframes = [];
  const kfs = p.keyframes as Draft<AnimatableProperty<T>>["keyframes"] & any[];
  const existing = kfs.find((k: any) => Math.abs(k.time - time) < 1e-3);
  if (existing) {
    existing.value = value as any;
    existing.easing = e as any;
    return existing.id as string;
  }
  const id = uid("kf");
  kfs.push({ id, time, value: value as any, easing: e as any });
  kfs.sort((a: any, b: any) => a.time - b.time);
  return id;
}

/** Valeur courante (au temps t) d'une propriété — base pour des animations relatives. */
function at<T extends PropertyValue>(p: AnimatableProperty<T>, t: number): T {
  return evaluate(p as AnimatableProperty<T>, t);
}

function anim(p: Draft<AnimatableProperty<number>>, keys: [number, number, Easing | string][]) {
  for (const [t, v, e] of keys) upsertKeyframe(p as any, t, v, e);
}

const T = (l: Draft<Layer>) => l.transform as unknown as Layer["transform"];

export const PRESETS: PresetDef[] = [
  {
    id: "fadeIn",
    label: "Fondu entrant",
    category: "entrée",
    description: "Apparition en fondu de l'opacité.",
    defaultDuration: 0.6,
    apply: ({ layer, start, duration }) => {
      const target = at(T(layer).opacity, start + duration) || 100;
      anim(layer.transform.opacity, [
        [start, 0, "easeOut"],
        [start + duration, target, "easeOut"],
      ]);
    },
  },
  {
    id: "fadeOut",
    label: "Fondu sortant",
    category: "sortie",
    description: "Disparition en fondu.",
    defaultDuration: 0.6,
    apply: ({ layer, start, duration }) => {
      const from = at(T(layer).opacity, start) || 100;
      anim(layer.transform.opacity, [
        [start, from, "easeIn"],
        [start + duration, 0, "easeIn"],
      ]);
    },
  },
  ...(["Left", "Right", "Up", "Down"] as const).map<PresetDef>((dir) => ({
    id: `slideIn${dir}`,
    label: `Glissement entrant (${{ Left: "gauche", Right: "droite", Up: "haut", Down: "bas" }[dir]})`,
    category: "entrée",
    description: "Entrée fluide par glissement + fondu, courbe expo.",
    defaultDuration: 0.8,
    apply: ({ layer, start, duration, comp, intensity }) => {
      const end = start + duration;
      const isX = dir === "Left" || dir === "Right";
      const p = isX ? layer.transform.positionX : layer.transform.positionY;
      const target = at(p as any, end) as number;
      const dist = (isX ? comp.width : comp.height) * 0.15 * intensity;
      const sign = dir === "Left" || dir === "Up" ? -1 : 1;
      anim(p, [
        [start, target + sign * dist, "expoOut"],
        [end, target, "expoOut"],
      ]);
      const op = at(T(layer).opacity, end) || 100;
      anim(layer.transform.opacity, [
        [start, 0, "easeOut"],
        [start + duration * 0.6, op, "easeOut"],
      ]);
    },
  })),
  {
    id: "popIn",
    label: "Pop (échelle avec dépassement)",
    category: "entrée",
    description: "Apparition par mise à l'échelle avec léger dépassement.",
    defaultDuration: 0.6,
    apply: ({ layer, start, duration }) => {
      const end = start + duration;
      const sx = at(T(layer).scaleX, end);
      const sy = at(T(layer).scaleY, end);
      anim(layer.transform.scaleX, [
        [start, 0, "backOut"],
        [end, sx, "easeOut"],
      ]);
      anim(layer.transform.scaleY, [
        [start, 0, "backOut"],
        [end, sy, "easeOut"],
      ]);
      const op = at(T(layer).opacity, end) || 100;
      anim(layer.transform.opacity, [
        [start, 0, "easeOut"],
        [start + duration * 0.3, op, "linear"],
      ]);
    },
  },
  {
    id: "bounceIn",
    label: "Rebond entrant",
    category: "entrée",
    description: "Le calque tombe et rebondit jusqu'à sa position.",
    defaultDuration: 1.0,
    apply: ({ layer, start, duration, comp, intensity }) => {
      const end = start + duration;
      const y = at(T(layer).positionY, end);
      anim(layer.transform.positionY, [
        [start, y - comp.height * 0.35 * intensity, "bounce"],
        [end, y, "linear"],
      ]);
      const op = at(T(layer).opacity, end) || 100;
      anim(layer.transform.opacity, [
        [start, 0, "easeOut"],
        [start + duration * 0.15, op, "linear"],
      ]);
    },
  },
  {
    id: "zoomIn",
    label: "Zoom entrant",
    category: "entrée",
    description: "Arrive de très grand avec flou.",
    defaultDuration: 0.8,
    apply: ({ layer, start, duration }) => {
      const end = start + duration;
      const sx = at(T(layer).scaleX, end);
      const sy = at(T(layer).scaleY, end);
      anim(layer.transform.scaleX, [
        [start, sx * 2.2, "expoOut"],
        [end, sx, "expoOut"],
      ]);
      anim(layer.transform.scaleY, [
        [start, sy * 2.2, "expoOut"],
        [end, sy, "expoOut"],
      ]);
      const op = at(T(layer).opacity, end) || 100;
      anim(layer.transform.opacity, [
        [start, 0, "easeOut"],
        [start + duration * 0.5, op, "easeOut"],
      ]);
    },
  },
  {
    id: "spinIn",
    label: "Rotation entrante",
    category: "entrée",
    description: "Apparition en tournant avec mise à l'échelle.",
    defaultDuration: 0.9,
    apply: ({ layer, start, duration, intensity }) => {
      const end = start + duration;
      const r = at(T(layer).rotation, end);
      anim(layer.transform.rotation, [
        [start, r - 180 * intensity, "expoOut"],
        [end, r, "expoOut"],
      ]);
      const sx = at(T(layer).scaleX, end);
      const sy = at(T(layer).scaleY, end);
      anim(layer.transform.scaleX, [
        [start, 0, "expoOut"],
        [end, sx, "expoOut"],
      ]);
      anim(layer.transform.scaleY, [
        [start, 0, "expoOut"],
        [end, sy, "expoOut"],
      ]);
    },
  },
  {
    id: "slideOutDown",
    label: "Glissement sortant (bas)",
    category: "sortie",
    description: "Sortie vers le bas avec fondu.",
    defaultDuration: 0.6,
    apply: ({ layer, start, duration, comp }) => {
      const end = start + duration;
      const y = at(T(layer).positionY, start);
      anim(layer.transform.positionY, [
        [start, y, "expoInOut"],
        [end, y + comp.height * 0.15, "expoInOut"],
      ]);
      const op = at(T(layer).opacity, start) || 100;
      anim(layer.transform.opacity, [
        [start, op, "easeIn"],
        [end, 0, "easeIn"],
      ]);
    },
  },
  {
    id: "zoomOut",
    label: "Zoom sortant",
    category: "sortie",
    description: "Rétrécit et disparaît.",
    defaultDuration: 0.6,
    apply: ({ layer, start, duration }) => {
      const end = start + duration;
      const sx = at(T(layer).scaleX, start);
      const sy = at(T(layer).scaleY, start);
      anim(layer.transform.scaleX, [
        [start, sx, "easeIn"],
        [end, 0, "easeIn"],
      ]);
      anim(layer.transform.scaleY, [
        [start, sy, "easeIn"],
        [end, 0, "easeIn"],
      ]);
      const op = at(T(layer).opacity, start) || 100;
      anim(layer.transform.opacity, [
        [start, op, "easeIn"],
        [end, 0, "easeIn"],
      ]);
    },
  },
  {
    id: "pulse",
    label: "Pulsation",
    category: "accentuation",
    description: "Battement d'échelle répété sur la durée.",
    defaultDuration: 2,
    apply: ({ layer, start, duration, intensity }) => {
      const sx = at(T(layer).scaleX, start);
      const sy = at(T(layer).scaleY, start);
      const beats = Math.max(1, Math.round(duration / 0.5));
      const step = duration / beats;
      for (let i = 0; i <= beats; i++) {
        const t = start + i * step;
        const big = i % 2 === 1;
        const f = big ? 1 + 0.12 * intensity : 1;
        upsertKeyframe(layer.transform.scaleX as any, t, sx * f, "easeInOut");
        upsertKeyframe(layer.transform.scaleY as any, t, sy * f, "easeInOut");
      }
    },
  },
  {
    id: "float",
    label: "Flottement",
    category: "accentuation",
    description: "Oscillation verticale douce.",
    defaultDuration: 3,
    apply: ({ layer, start, duration, intensity }) => {
      const y = at(T(layer).positionY, start);
      const n = Math.max(2, Math.round(duration / 0.75));
      for (let i = 0; i <= n; i++) {
        const off = i % 2 === 0 ? 0 : (i % 4 === 1 ? -1 : 1) * 18 * intensity;
        upsertKeyframe(layer.transform.positionY as any, start + (i * duration) / n, y + off, "easeInOut");
      }
    },
  },
  {
    id: "wiggle",
    label: "Secousse",
    category: "accentuation",
    description: "Secousse rapide en rotation (attention).",
    defaultDuration: 0.6,
    apply: ({ layer, start, duration, intensity }) => {
      const r = at(T(layer).rotation, start);
      const seq = [0, -8, 7, -5, 3, -1, 0];
      seq.forEach((v, i) => upsertKeyframe(layer.transform.rotation as any, start + (i * duration) / (seq.length - 1), r + v * intensity, "easeInOut"));
    },
  },
  {
    id: "typewriter",
    label: "Machine à écrire",
    category: "texte",
    description: "Révèle le texte caractère par caractère.",
    defaultDuration: 1.5,
    apply: ({ layer, start, duration }) => {
      if (layer.type !== "text") throw new Error("Le preset typewriter ne s'applique qu'aux calques texte.");
      layer.props.textAnimator = "typewriter";
      if (!layer.props.textProgress) layer.props.textProgress = { value: 100 };
      anim(layer.props.textProgress as any, [
        [start, 0, "linear"],
        [start + duration, 100, "linear"],
      ]);
    },
  },
  ...(["fade", "slide-up", "scale", "wave"] as const).map<PresetDef>((mode) => ({
    id: `textReveal-${mode}`,
    label: `Révélation de texte (${mode})`,
    category: "texte",
    description: "Animation lettre par lettre.",
    defaultDuration: 1.2,
    apply: ({ layer, start, duration }) => {
      if (layer.type !== "text") throw new Error("Ce preset ne s'applique qu'aux calques texte.");
      layer.props.textAnimator = mode;
      if (!layer.props.textProgress) layer.props.textProgress = { value: 100 };
      anim(layer.props.textProgress as any, [
        [start, 0, "easeOut"],
        [start + duration, 100, "easeOut"],
      ]);
    },
  })),
  {
    id: "logoReveal",
    label: "Révélation de logo",
    category: "logo",
    description: "Animation pro de logo : pop avec dépassement, rotation, flou décroissant et lueur.",
    defaultDuration: 1.6,
    apply: ({ layer, start, duration }) => {
      const end = start + duration;
      const sx = at(T(layer).scaleX, end);
      const sy = at(T(layer).scaleY, end);
      const r = at(T(layer).rotation, end);
      anim(layer.transform.scaleX, [
        [start, sx * 0.3, "backOut"],
        [start + duration * 0.55, sx, "easeInOut"],
        [end, sx * 1.04, "easeInOut"],
      ]);
      anim(layer.transform.scaleY, [
        [start, sy * 0.3, "backOut"],
        [start + duration * 0.55, sy, "easeInOut"],
        [end, sy * 1.04, "easeInOut"],
      ]);
      anim(layer.transform.rotation, [
        [start, r - 25, "expoOut"],
        [start + duration * 0.55, r, "linear"],
      ]);
      const op = at(T(layer).opacity, end) || 100;
      anim(layer.transform.opacity, [
        [start, 0, "easeOut"],
        [start + duration * 0.25, op, "linear"],
      ]);
      let blur = layer.effects.find((e) => e.type === "gaussianBlur");
      if (!blur) {
        layer.effects.push({ id: uid("fx"), type: "gaussianBlur", enabled: true, params: { radius: { value: 0 } } });
        blur = layer.effects[layer.effects.length - 1];
      }
      anim(blur.params.radius as any, [
        [start, 30, "easeOut"],
        [start + duration * 0.45, 0, "linear"],
      ]);
      let glow = layer.effects.find((e) => e.type === "glow");
      if (!glow) {
        layer.effects.push({
          id: uid("fx"),
          type: "glow",
          enabled: true,
          params: { radius: { value: 30 }, intensity: { value: 0 }, color: { value: "#ffffff" } },
        });
        glow = layer.effects[layer.effects.length - 1];
      }
      anim(glow.params.intensity as any, [
        [start + duration * 0.4, 0, "easeOut"],
        [start + duration * 0.6, 1.5, "easeInOut"],
        [end, 0.4, "easeInOut"],
      ]);
    },
  },
  {
    id: "cameraPushIn",
    label: "Caméra : travelling avant",
    category: "caméra",
    description: "Zoom progressif de la caméra avec légère rotation (à appliquer à un calque caméra).",
    defaultDuration: 3,
    apply: ({ layer, start, duration, intensity }) => {
      if (layer.type !== "camera") throw new Error("Ce preset s'applique à un calque caméra.");
      const z = layer.props.zoom as Draft<AnimatableProperty<number>>;
      anim(z, [
        [start, 100, "smooth"],
        [start + duration, 100 + 25 * intensity, "smooth"],
      ]);
      anim(layer.transform.rotation, [
        [start, -1.5 * intensity, "smooth"],
        [start + duration, 1.5 * intensity, "smooth"],
      ]);
    },
  },
  {
    id: "cameraDynamic",
    label: "Caméra : dynamique",
    category: "caméra",
    description: "Zooms rythmés, panoramique et tremblement léger façon caméra à l'épaule.",
    defaultDuration: 4,
    apply: ({ layer, start, duration, comp, intensity }) => {
      if (layer.type !== "camera") throw new Error("Ce preset s'applique à un calque caméra.");
      const z = layer.props.zoom as Draft<AnimatableProperty<number>>;
      const cx = comp.width / 2;
      const cy = comp.height / 2;
      const seq: [number, number, number][] = [
        [0, 100, cx],
        [0.3, 118, cx + 60 * intensity],
        [0.55, 108, cx - 40 * intensity],
        [0.8, 125, cx + 30 * intensity],
        [1, 112, cx],
      ];
      for (const [f, zoom, x] of seq) {
        upsertKeyframe(z as any, start + f * duration, 100 + (zoom - 100) * intensity, "expoInOut");
        upsertKeyframe(layer.transform.positionX as any, start + f * duration, x, "expoInOut");
      }
      upsertKeyframe(layer.transform.positionY as any, start, cy, "smooth");
      if (!layer.effects.some((e) => e.type === "shake")) {
        layer.effects.push({
          id: uid("fx"),
          type: "shake",
          enabled: true,
          params: { amplitude: { value: 6 * intensity }, frequency: { value: 2.5 }, rotation: { value: 0.6 * intensity } },
        });
      }
    },
  },
];

export function getPreset(id: string): PresetDef {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`Preset inconnu: "${id}". Presets disponibles: ${PRESETS.map((x) => x.id).join(", ")}`);
  return p;
}
