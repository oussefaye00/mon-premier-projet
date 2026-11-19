import type { EditorEngine, Layer } from "@amai/core";

/**
 * Planificateur IA local (hors-ligne, sans clé API).
 *
 * Il interprète des instructions en langage naturel (français ou anglais) et produit
 * un PLAN : une liste d'appels aux mêmes outils que ceux du serveur MCP. Le plan est
 * présenté à l'utilisateur avant d'être appliqué, et s'annule en une seule étape.
 *
 * Il couvre les demandes courantes de motion design ; pour des demandes libres et
 * complexes, l'assistant bascule sur Claude (clé API requise).
 */

export interface PlannedStep {
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

export interface Plan {
  summary: string;
  steps: PlannedStep[];
  notes: string[];
  understood: boolean;
}

/** Référence à un calque créé dans une étape précédente : "$step:<index>" résolu à l'exécution. */
export const stepRef = (index: number) => `$step:${index}`;

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’']/g, " ");

const COLORS: Record<string, string> = {
  rouge: "#ff3b30",
  red: "#ff3b30",
  bleu: "#0a84ff",
  blue: "#0a84ff",
  vert: "#34c759",
  green: "#34c759",
  jaune: "#ffd60a",
  yellow: "#ffd60a",
  orange: "#ff9f0a",
  violet: "#bf5af2",
  purple: "#bf5af2",
  rose: "#ff375f",
  pink: "#ff375f",
  blanc: "#ffffff",
  white: "#ffffff",
  noir: "#000000",
  black: "#000000",
  gris: "#8e8e93",
  gray: "#8e8e93",
  dore: "#d4af37",
  gold: "#d4af37",
  cyan: "#64d2ff",
};

function findColor(t: string, after?: RegExp): string | undefined {
  const hex = t.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/);
  if (hex) return hex[0];
  if (after) {
    const m = t.match(after);
    if (m) {
      for (const [k, v] of Object.entries(COLORS)) if (m[0].includes(k)) return v;
    }
    return undefined;
  }
  for (const [k, v] of Object.entries(COLORS)) if (new RegExp(`\\b${k}\\b`).test(t)) return v;
  return undefined;
}

function extractQuoted(raw: string): string | undefined {
  const m = raw.match(/[«"“]\s*([^»"”]+?)\s*[»"”]/) ?? raw.match(/'([^']{2,})'/);
  return m?.[1];
}

function extractDuration(t: string): number | undefined {
  const m = t.match(/(?:en|pendant|sur|over|in|for|de)\s+(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|secondes?|seconds?)/) ?? t.match(/\bduree\s+(?:de\s+)?(\d+(?:[.,]\d+)?)/);
  if (m) return parseFloat(m[1].replace(",", "."));
  const ms = t.match(/(\d+)\s*ms\b/);
  if (ms) return parseInt(ms[1]) / 1000;
  return undefined;
}

function extractStart(t: string): number | undefined {
  const m = t.match(/(?:a|at|des|from|starting at)\s+(\d+(?:[.,]\d+)?)\s*(?:s\b|sec|secondes?|seconds?)/);
  return m ? parseFloat(m[1].replace(",", ".")) : undefined;
}

function intensityOf(t: string): number {
  if (/\b(tres|very|super|enorme|fort|strong|intense|dramatique|dramatic|energique|punchy)\b/.test(t)) return 1.6;
  if (/\b(leger|legere|subtil|subtle|doux|douce|soft|discret|light)\b/.test(t)) return 0.6;
  return 1;
}

interface Ctx {
  engine: EditorEngine;
  layers: Layer[];
  selected: Layer[];
}

function pickTarget(t: string, c: Ctx, kind?: "text" | "logo" | "any"): Layer | undefined {
  const named = c.layers.find((l) => t.includes(norm(l.name)) && norm(l.name).length > 2);
  if (named) return named;
  if (kind === "logo") {
    return (
      c.layers.find((l) => /logo/i.test(l.name)) ??
      c.selected[0] ??
      [...c.layers].reverse().find((l) => l.type === "image" && /svg|logo|png/i.test(l.name)) ??
      undefined
    );
  }
  if (kind === "text") {
    return c.selected.find((l) => l.type === "text") ?? [...c.layers].reverse().find((l) => l.type === "text");
  }
  return c.selected[0] ?? [...c.layers].reverse().find((l) => l.type !== "camera" && l.type !== "audio");
}

/** Analyse une instruction et construit un plan d'actions. */
export function planFromText(input: string, engine: EditorEngine): Plan {
  const raw = input.trim();
  const t = norm(raw);
  const comp = engine.comp();
  const layers = comp.layers;
  const ctx: Ctx = { engine, layers, selected: layers.filter((l) => engine.session.selectedLayerIds.includes(l.id)) };
  const steps: PlannedStep[] = [];
  const notes: string[] = [];
  const duration = extractDuration(t);
  const start = extractStart(t);
  const intensity = intensityOf(t);
  const quoted = extractQuoted(raw);
  /** Calque cible : id existant ou référence à un calque créé dans le plan. */
  let target: string | undefined;
  let targetName = "";
  let targetIsText = false;

  const addStep = (tool: string, args: Record<string, unknown>, description: string) => {
    steps.push({ tool, args, description });
    return steps.length - 1;
  };

  // ---- annuler / rétablir
  if (/^(annule|undo|defais|retour arriere)/.test(t)) {
    addStep("undo_action", { steps: 1 }, "Annuler la dernière action");
    return { summary: "Annulation de la dernière action.", steps, notes, understood: true };
  }
  if (/^(retablis|redo|refais)/.test(t)) {
    addStep("redo_action", { steps: 1 }, "Rétablir l'action annulée");
    return { summary: "Rétablissement.", steps, notes, understood: true };
  }

  // ---- fond de composition
  if (/\b(fond|arriere-plan|arriere plan|background)\b/.test(t) && !/particule|particle/.test(t)) {
    const color = findColor(t, /(fond|arriere.plan|background)[^.,;]*/);
    if (color) addStep("update_composition", { background: color }, `Couleur de fond → ${color}`);
  }

  // ---- création de texte
  const wantsText = /\b(texte|titre|title|text|ecris|write|sous-titre|subtitle)\b/.test(t);
  const creating = /\b(cree|creer|ajoute|ajouter|add|create|ecris|ecrire|write|insere|mets|met|make|genere)\b/.test(t);
  if (wantsText && (creating || quoted) && quoted) {
    const color = findColor(t);
    const i = addStep(
      "create_text",
      { text: quoted, ...(color ? { color } : {}), fontSize: /\b(titre|title|grand|big|gros)\b/.test(t) ? 150 : 110 },
      `Créer le texte « ${quoted} »`,
    );
    target = stepRef(i);
    targetName = quoted;
    targetIsText = true;
  }

  // ---- logo
  const wantsLogo = /\blogo\b/.test(t);
  if (wantsLogo && !target) {
    const logo = pickTarget(t, ctx, "logo");
    if (logo) {
      target = logo.id;
      targetName = logo.name;
    } else {
      const label = quoted ?? "LOGO";
      const color = findColor(t) ?? "#7c5cff";
      const s = addStep(
        "create_layer",
        { type: "shape", name: "Logo — emblème", props: { shapeKind: "star", width: 260, height: 260, fill: color, sides: 6, innerRatio: 0.5 }, y: comp.height / 2 - 70 },
        "Créer un emblème de logo (étoile) — remplaçable par votre fichier",
      );
      const tx = addStep("create_text", { text: label, fontSize: 96, y: comp.height / 2 + 140 }, `Créer le nom « ${label} »`);
      addStep("create_animation", { layerId: stepRef(s), preset: "logoReveal", start: start ?? 0, duration: duration ?? 1.6, intensity }, "Révélation du logo : pop, rotation, flou décroissant et lueur");
      addStep("create_animation", { layerId: stepRef(tx), preset: "textReveal-slide-up", start: (start ?? 0) + 0.6, duration: 1 }, "Apparition du nom lettre par lettre");
      notes.push("Aucun calque logo trouvé : un emblème provisoire a été créé. Importez votre logo (SVG/PNG) puis relancez la demande pour l'animer.");
      return finish();
    }
  }

  // ---- particules
  const wantsParticles = /\b(particules?|particles?|confettis?|etincelles?|sparks?|neige|snow|poussiere|dust|feu d artifice|fireworks?|bulles?|bubbles?)\b/.test(t);
  if (wantsParticles) {
    let props: Record<string, unknown> = {};
    let name = "Particules";
    let y = comp.height / 2;
    if (/confetti/.test(t)) {
      name = "Confettis";
      props = { particleShape: "square", rate: 80, speed: 700, direction: -90, spread: 70, gravity: 900, lifetime: 2.5, particleSize: 18, particleSizeEnd: 14, colorStart: "#ff375f", colorEnd: "#ffd60aff" };
      y = comp.height * 0.85;
    } else if (/neige|snow/.test(t)) {
      name = "Neige";
      props = { emitterShape: "line", emitterSize: comp.width * 1.2, particleShape: "circle", rate: 60, speed: 60, direction: 90, spread: 30, gravity: 20, lifetime: 8, particleSize: 8, particleSizeEnd: 6, colorStart: "#ffffff", colorEnd: "#ffffff88" };
      y = -20;
    } else if (/etincelle|spark|feu d artifice|firework/.test(t)) {
      name = "Étincelles";
      props = { emitterShape: "point", particleShape: "spark", rate: 120, speed: 600, direction: -90, spread: 360, gravity: 400, lifetime: 1.2, particleSize: 6, particleSizeEnd: 1, colorStart: "#ffd60a", colorEnd: "#ff3b3000" };
    } else if (/bulle|bubble/.test(t)) {
      name = "Bulles";
      props = { emitterShape: "line", emitterSize: comp.width, particleShape: "circle", rate: 20, speed: 150, direction: -90, spread: 20, gravity: -30, lifetime: 6, particleSize: 18, particleSizeEnd: 30, colorStart: "#64d2ff88", colorEnd: "#64d2ff00" };
      y = comp.height + 20;
    } else if (/poussiere|dust/.test(t)) {
      name = "Poussière";
      props = { emitterShape: "circle", emitterSize: comp.width, particleShape: "circle", rate: 30, speed: 20, direction: -90, spread: 360, gravity: 0, lifetime: 5, particleSize: 4, particleSizeEnd: 2, colorStart: "#ffffffaa", colorEnd: "#ffffff00" };
    } else {
      const color = findColor(t);
      if (color) props = { colorStart: color, colorEnd: color.length === 7 ? color + "00" : color };
    }
    if (intensity !== 1 && typeof props.rate === "number") props.rate = Math.round((props.rate as number) * intensity);
    const i = addStep(
      "create_layer",
      { type: "particles", name, y, props, ...(start !== undefined ? { inPoint: start } : {}), ...(duration !== undefined ? { outPoint: (start ?? 0) + duration } : {}) },
      `Créer un système de particules « ${name} »`,
    );
    if (!target) {
      target = stepRef(i);
      targetName = name;
    }
  }

  // ---- caméra
  if (/\b(camera|cam)\b/.test(t)) {
    const cam = layers.find((l) => l.type === "camera");
    let camRef = cam?.id;
    if (!cam) camRef = stepRef(addStep("create_layer", { type: "camera", name: "Caméra" }, "Ajouter un calque caméra (pilote toute la scène)"));
    const slow = /\b(lent|lente|slow|travelling|push|doux|douce|zoom avant)\b/.test(t);
    addStep(
      "create_animation",
      { layerId: camRef, preset: slow ? "cameraPushIn" : "cameraDynamic", start: start ?? 0, duration: duration ?? Math.min(comp.duration, slow ? comp.duration : 4), intensity },
      slow ? "Travelling avant progressif de la caméra" : "Mouvement de caméra dynamique (zooms rythmés, panoramique, tremblement léger)",
    );
  }

  // ---- transitions entre clips
  if (/\btransitions?\b/.test(t)) {
    const type = /glisse|slide|balay/.test(t)
      ? /droite|right/.test(t)
        ? "slide-right"
        : /haut|up/.test(t)
          ? "slide-up"
          : /bas|down/.test(t)
            ? "slide-down"
            : "slide-left"
      : /zoom/.test(t)
        ? "zoom"
        : /flou|blur/.test(t)
          ? "blur"
          : /volet|wipe/.test(t)
            ? "wipe"
            : "fade";
    const clips = layers.filter((l) => ["video", "image", "composition"].includes(l.type));
    if (clips.length >= 2) {
      addStep(
        "add_transitions_between_clips",
        { type, duration: duration ?? 0.5, overlap: /enchaine|crossfade|chevauch|overlap|croise/.test(t) || type === "fade" },
        `Transitions « ${type} » entre ${clips.length} clips`,
      );
    } else {
      notes.push("Il faut au moins deux clips (vidéos/images) sur la timeline pour ajouter des transitions entre eux.");
    }
  }

  // ---- optimisation
  if (/\b(optimise|optimiser|optimize|nettoie|nettoyer|clean|simplifie)\b/.test(t)) {
    addStep("optimize_animations", {}, "Optimiser les animations (keyframes redondantes, effets neutres, calques hors durée)");
  }

  // ---- animations sur une cible
  type Anim = { preset: string; label: string };
  const anims: Anim[] = [];
  if (/\b(rebond|rebondi|rebondit|bounce|bouncy|rebondissant)\b/.test(t)) anims.push({ preset: "bounceIn", label: "Entrée avec rebond" });
  else if (/\b(machine a ecrire|typewriter|tape|frappe)\b/.test(t)) anims.push({ preset: "typewriter", label: "Effet machine à écrire" });
  else if (/\b(lettre par lettre|letter by letter|caractere par caractere)\b/.test(t)) anims.push({ preset: "textReveal-slide-up", label: "Révélation lettre par lettre" });
  else if (/\b(vague|wave|ondul)\b/.test(t)) anims.push({ preset: "textReveal-wave", label: "Texte en vague" });
  else if (/\b(pop|popup|surgi)\b/.test(t)) anims.push({ preset: "popIn", label: "Apparition « pop »" });
  else if (/\b(zoom)\b/.test(t) && !/camera/.test(t) && !/transition/.test(t)) anims.push({ preset: "zoomIn", label: "Entrée en zoom" });
  else if (/\b(tourne|rotation|spin|pivote)\b/.test(t)) anims.push({ preset: "spinIn", label: "Entrée en rotation" });
  else if (/\b(glisse|slide|arrive)\b/.test(t) && !/transition/.test(t)) {
    const p = /droite|right/.test(t) ? "slideInRight" : /gauche|left/.test(t) ? "slideInLeft" : /haut|top|up/.test(t) ? "slideInUp" : "slideInDown";
    anims.push({ preset: /arrive.*(de la|du|from)/.test(t) ? p : p, label: "Entrée en glissement" });
  } else if (/\b(apparition|apparaitre|apparait|apparaisse|fade in|fondu entrant|entree|reveal|revele|reveler|fluide|smooth|fade)\b/.test(t) && !/transition/.test(t)) {
    anims.push(targetIsText || /texte|text|titre/.test(t) ? { preset: "slideInDown", label: "Apparition fluide (glissement + fondu, courbe expo)" } : { preset: "fadeIn", label: "Apparition en fondu" });
  }
  if (/\b(pulse|pulsation|battement|heartbeat|respire)\b/.test(t)) anims.push({ preset: "pulse", label: "Pulsation" });
  if (/\b(flotte|flottement|float|levite)\b/.test(t)) anims.push({ preset: "float", label: "Flottement" });
  if (/\b(secoue|secousse|shake|wiggle|tremble)\b/.test(t) && !/camera/.test(t)) anims.push({ preset: "wiggle", label: "Secousse" });
  if (/\b(disparition|disparaitre|disparait|fade out|fondu sortant|sortie|exit)\b/.test(t)) anims.push({ preset: /zoom/.test(t) ? "zoomOut" : "fadeOut", label: "Disparition en fin de calque" });

  // ---- effets
  type Fx = { effect: string; params?: Record<string, unknown>; label: string };
  const fxs: Fx[] = [];
  if (/\b(glow|lueur|lumineux|brille|neon|halo)\b/.test(t)) fxs.push({ effect: "glow", params: { radius: 25 * intensity, intensity: 1.2 * intensity, ...(findColor(t) ? { color: findColor(t) } : {}) }, label: "Lueur (glow)" });
  if (/\b(ombre|shadow)\b/.test(t)) fxs.push({ effect: "dropShadow", params: { softness: 20 * intensity, distance: 14 * intensity }, label: "Ombre portée" });
  if (/\b(flou|blur)\b/.test(t) && !/transition/.test(t) && !/motion blur|flou de mouvement|flou cinetique/.test(t)) fxs.push({ effect: "gaussianBlur", params: { radius: 10 * intensity }, label: "Flou gaussien" });
  if (/\b(noir et blanc|black and white|grayscale|desature)\b/.test(t)) fxs.push({ effect: "grayscale", label: "Noir & blanc" });
  if (/\b(vignet)/.test(t)) fxs.push({ effect: "vignette", label: "Vignettage" });
  if (/\b(pixel)/.test(t)) fxs.push({ effect: "pixelate", label: "Pixellisation" });
  const wantsMotionBlur = /motion blur|flou de mouvement|flou cinetique|flou directionnel/.test(t);

  if (anims.length || fxs.length || wantsMotionBlur) {
    if (!target) {
      const l = pickTarget(t, ctx, /\b(texte|text|titre|title)\b/.test(t) ? "text" : "any");
      if (l) {
        target = l.id;
        targetName = l.name;
      }
    }
    if (!target) {
      if (/\b(texte|text|titre|title)\b/.test(t)) {
        const i = addStep("create_text", { text: quoted ?? "Votre texte" }, `Créer un texte « ${quoted ?? "Votre texte"} »`);
        target = stepRef(i);
        targetName = quoted ?? "Votre texte";
        notes.push("Aucun texte existant : un calque texte a été créé.");
      } else {
        notes.push("Aucun calque cible : sélectionnez un calque ou précisez son nom.");
      }
    }
    if (target) {
      let cursor = start;
      for (const a of anims) {
        const isOut = a.preset === "fadeOut" || a.preset === "zoomOut";
        addStep(
          "create_animation",
          { layerId: target, preset: a.preset, ...(isOut ? {} : cursor !== undefined ? { start: cursor } : {}), ...(duration !== undefined && !isOut ? { duration } : {}), intensity },
          `${a.label} sur « ${targetName} »`,
        );
      }
      for (const f of fxs) addStep("apply_effect", { layerId: target, effect: f.effect, ...(f.params ? { params: f.params } : {}) }, `${f.label} sur « ${targetName} »`);
      if (wantsMotionBlur) addStep("update_layer", { layerId: target, motionBlur: true }, `Activer le motion blur sur « ${targetName} »`);
      void cursor;
    }
  }

  // ---- logo existant à animer
  if (wantsLogo && target && !anims.length && !steps.some((s) => s.tool === "create_animation" && s.args.layerId === target)) {
    addStep("create_animation", { layerId: target, preset: "logoReveal", start: start ?? 0, duration: duration ?? 1.6, intensity }, `Révélation professionnelle du logo « ${targetName} »`);
  }

  // ---- texte créé sans animation explicite
  if (targetIsText && target && !steps.some((s) => s.tool === "create_animation")) {
    // Rien à ajouter : simple création.
  }

  return finish();

  function finish(): Plan {
    const understood = steps.length > 0;
    return {
      summary: understood
        ? `${steps.length} action${steps.length > 1 ? "s" : ""} prévue${steps.length > 1 ? "s" : ""}.`
        : "Je n'ai pas compris cette demande avec l'assistant local. Essayez par ex. « Anime ce texte avec un rebond », « Ajoute des particules », ou configurez Claude pour des demandes libres.",
      steps,
      notes,
      understood,
    };
  }
}
