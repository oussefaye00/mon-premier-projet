import { z } from "zod/v4";
import { EASING_PRESETS } from "./easing";
import { listEffectDefs } from "./effects";
import { EditorEngine, EngineError } from "./engine";
import { PRESETS } from "./presets";
import type { Asset, ChangeSource, PropertyValue } from "./types";

/**
 * Catalogue d'outils unique de AFTER MOTION AI.
 *
 * Ces définitions sont la source de vérité pour :
 *  - le serveur MCP (outils exposés à Claude Desktop & co),
 *  - l'assistant IA intégré (outils fournis au modèle Claude),
 *  - le pont éditeur (exécution des requêtes MCP sur le projet ouvert).
 */

export interface PreviewResult {
  mimeType: "image/png" | "image/jpeg";
  /** Données encodées en base64 (sans préfixe data:). */
  data: string;
  width: number;
  height: number;
  time: number;
}

export interface ExportOptions {
  format: "mp4" | "webm";
  width?: number;
  height?: number;
  fps?: number;
  start?: number;
  end?: number;
  quality?: "low" | "medium" | "high";
  fileName?: string;
  includeAudio?: boolean;
}

export interface ExportResult {
  fileName: string;
  mimeType: string;
  size: number;
  duration: number;
  frames: number;
  codec: string;
  /** Contenu base64 (transféré au serveur MCP qui l'écrit sur disque). */
  data?: string;
  /** Chemin final si le fichier a été écrit par l'hôte. */
  path?: string;
}

export interface ImportRequest {
  name?: string;
  /** URL http(s) ou data: */
  url?: string;
  /** Contenu base64 brut. */
  data?: string;
  mimeType?: string;
  /** Chemin local (lu par le serveur MCP, qui transmet ensuite les données). */
  path?: string;
  addToTimeline?: boolean;
}

/** Fonctions propres à l'environnement d'exécution (navigateur, headless…). */
export interface EditorHost {
  renderPreview?(opts: { time: number; width?: number; format?: "png" | "jpeg" }): Promise<PreviewResult>;
  exportVideo?(opts: ExportOptions, onProgress?: (p: number) => void): Promise<ExportResult>;
  importMedia?(req: ImportRequest): Promise<Asset>;
}

export interface ToolContext {
  engine: EditorEngine;
  host?: EditorHost;
  source: ChangeSource;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Action sensible : nécessite l'accord explicite de l'utilisateur dans l'éditeur. */
  sensitive?: boolean;
  /** Ne modifie pas le projet. */
  readOnly?: boolean;
  run: (ctx: ToolContext, args: z.infer<S>) => unknown | Promise<unknown>;
}

function tool<S extends z.ZodType>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

// ------------------------------------------------------------------ schémas partagés

const layerId = z.string().min(1).describe("Identifiant du calque (ou son nom exact).");
const time = z.number().min(0).describe("Temps en secondes depuis le début de la composition.");
const valueSchema = z.union([z.number(), z.string()]).describe("Nombre, ou couleur hexadécimale (#rrggbb / #rrggbbaa).");
const easingNames = Object.keys(EASING_PRESETS) as [string, ...string[]];
const easingSchema = z
  .union([
    z.enum(easingNames),
    z.object({
      type: z.literal("bezier"),
      x1: z.number().min(0).max(1),
      y1: z.number(),
      x2: z.number().min(0).max(1),
      y2: z.number(),
    }),
  ])
  .describe(`Courbe d'interpolation : nom (${easingNames.join(", ")}) ou Bézier {type:"bezier",x1,y1,x2,y2}.`);
const transitionTypes = ["fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom", "blur", "wipe"] as const;
const transitionSchema = z.object({ type: z.enum(transitionTypes), duration: z.number().positive().max(10) });
const layerTypes = ["solid", "shape", "text", "image", "video", "audio", "particles", "composition", "camera", "null"] as const;
const presetIds = PRESETS.map((p) => p.id) as [string, ...string[]];

const PROPERTY_HELP =
  "Chemins de propriétés : transform.positionX|positionY|scaleX|scaleY|rotation|opacity|anchorX|anchorY (échelle et opacité en %, rotation en degrés, position en pixels, origine en haut à gauche), " +
  "props.<nom> (fill, stroke, strokeWidth, width, height, cornerRadius, fontSize, textColor, letterSpacing, textProgress, zoom, rate, speed, gravity…), " +
  "effects.<idEffet|type>.<param>. Les raccourcis 'positionX', 'fill'… sont acceptés.";

// ------------------------------------------------------------------ outils

export const TOOLS = [
  tool({
    name: "get_project_info",
    title: "Informations du projet",
    description: "Renvoie le résumé du projet ouvert : compositions, médias, sélection, temps courant, état undo/redo.",
    input: z.object({}),
    readOnly: true,
    run: ({ engine }) => engine.getProjectInfo(),
  }),
  tool({
    name: "create_project",
    title: "Créer un projet",
    description: "Crée un NOUVEAU projet vide qui remplace le projet ouvert (le projet actuel reste dans la sauvegarde automatique). Action sensible.",
    input: z.object({
      name: z.string().default("Nouveau projet"),
      width: z.number().int().min(16).max(7680).default(1920),
      height: z.number().int().min(16).max(7680).default(1080),
      fps: z.number().min(1).max(120).default(30),
      duration: z.number().positive().max(3600).default(10),
      background: z.string().default("#101014"),
    }),
    sensitive: true,
    run: ({ engine }, a) => {
      const p = engine.newProject({ projectName: a.name, width: a.width, height: a.height, fps: a.fps, duration: a.duration, background: a.background });
      return { projectId: p.id, compositionId: p.activeCompositionId };
    },
  }),
  tool({
    name: "update_composition",
    title: "Modifier la composition",
    description: "Change résolution, FPS, durée, couleur de fond ou nom de la composition active (ou de compositionId).",
    input: z.object({
      compositionId: z.string().optional(),
      name: z.string().optional(),
      width: z.number().int().min(16).max(7680).optional(),
      height: z.number().int().min(16).max(7680).optional(),
      fps: z.number().min(1).max(120).optional(),
      duration: z.number().positive().max(3600).optional(),
      background: z.string().optional(),
    }),
    run: ({ engine, source }, { compositionId, ...patch }) => {
      const c = engine.updateComposition(patch, compositionId, source);
      return { id: c.id, width: c.width, height: c.height, fps: c.fps, duration: c.duration, background: c.background };
    },
  }),
  tool({
    name: "create_composition",
    title: "Créer une composition",
    description: "Crée une nouvelle composition (scène). Elle peut ensuite être imbriquée via create_layer type=composition.",
    input: z.object({
      name: z.string().default("Composition"),
      width: z.number().int().min(16).max(7680).optional(),
      height: z.number().int().min(16).max(7680).optional(),
      fps: z.number().min(1).max(120).optional(),
      duration: z.number().positive().max(3600).optional(),
      background: z.string().optional(),
      activate: z.boolean().default(false).describe("Ouvrir la composition après création."),
    }),
    run: ({ engine, source }, a) => {
      const c = engine.createComposition(a, source);
      return { id: c.id, name: c.name };
    },
  }),
  tool({
    name: "set_active_composition",
    title: "Ouvrir une composition",
    description: "Rend active la composition indiquée (les autres outils s'appliquent à la composition active).",
    input: z.object({ compositionId: z.string() }),
    run: ({ engine, source }, a) => {
      engine.setActiveComposition(a.compositionId, source);
      return { activeCompositionId: a.compositionId };
    },
  }),
  tool({
    name: "get_timeline",
    title: "Timeline",
    description: "Liste les calques de la composition (du dessus vers le dessous) avec plages temporelles, effets, propriétés animées et transitions.",
    input: z.object({ compositionId: z.string().optional() }),
    readOnly: true,
    run: ({ engine }, a) => engine.getTimeline(a.compositionId),
  }),
  tool({
    name: "get_layer",
    title: "Détails d'un calque",
    description: "Renvoie toutes les données d'un calque : transformations, propriétés, keyframes, effets, masques.",
    input: z.object({ layerId }),
    readOnly: true,
    run: ({ engine }, a) => engine.getLayerDetails(a.layerId),
  }),
  tool({
    name: "create_layer",
    title: "Créer un calque",
    description:
      "Crée un calque. Types : solid, shape (props.shapeKind rectangle|ellipse|polygon|star|path), text (props.text), image/video/audio (assetId requis, voir import_media), particles, composition (compositionId), camera (zoom/position de toute la scène), null. " +
      "Position par défaut : centre. Les props et transform optionnels permettent de tout régler en un appel.",
    input: z.object({
      type: z.enum(layerTypes),
      name: z.string().optional(),
      inPoint: time.optional(),
      outPoint: time.optional(),
      x: z.number().optional().describe("Position X en pixels (défaut : centre)."),
      y: z.number().optional().describe("Position Y en pixels (défaut : centre)."),
      assetId: z.string().optional(),
      compositionId: z.string().optional(),
      index: z.number().int().min(0).optional().describe("Position dans la pile (0 = tout en dessous). Défaut : au-dessus."),
      props: z.record(z.string(), z.unknown()).optional().describe("Propriétés spécifiques, ex. {fill:'#ff0000', width:300} ou {text:'Bonjour', fontSize:96}."),
      transform: z.record(z.string(), z.number()).optional().describe("Ex. {rotation: 15, opacity: 80, scaleX: 50, scaleY: 50}."),
    }),
    run: ({ engine, source }, a) => {
      const l = engine.createLayer(a.type, a, source);
      return engine.summarizeLayer(l, engine.findLayer(l.id).index);
    },
  }),
  tool({
    name: "create_text",
    title: "Créer un texte",
    description: "Crée un calque texte (raccourci de create_layer). Peut appliquer directement un preset d'animation.",
    input: z.object({
      text: z.string().min(1),
      x: z.number().optional(),
      y: z.number().optional(),
      fontSize: z.number().positive().optional(),
      color: z.string().optional(),
      fontFamily: z.string().optional(),
      fontWeight: z.number().int().min(100).max(900).optional(),
      inPoint: time.optional(),
      outPoint: time.optional(),
      animation: z.enum(presetIds).optional().describe("Preset d'animation à appliquer (voir list_presets)."),
    }),
    run: ({ engine, source }, a) => {
      const l = engine.createText(a.text, a, source);
      if (a.animation) engine.applyPreset(l.id, a.animation, undefined, undefined, 1, source);
      const f = engine.findLayer(l.id);
      return engine.summarizeLayer(f.layer, f.index);
    },
  }),
  tool({
    name: "update_layer",
    title: "Modifier un calque",
    description:
      "Modifie un calque : nom, inPoint/outPoint, visibilité, verrouillage, mode de fusion, parent, motion blur, transitions, et valeurs de transform/props. " +
      "Si une propriété est animée, la valeur est écrite comme keyframe au temps `time` (défaut : temps courant).",
    input: z.object({
      layerId,
      name: z.string().optional(),
      inPoint: time.optional(),
      outPoint: time.optional(),
      visible: z.boolean().optional(),
      locked: z.boolean().optional(),
      blendMode: z.enum(["normal", "multiply", "screen", "overlay", "darken", "lighten", "add", "difference"]).optional(),
      parentId: z.string().nullable().optional(),
      motionBlur: z.boolean().optional(),
      transform: z.record(z.string(), z.number()).optional(),
      props: z.record(z.string(), z.unknown()).optional(),
      transitionIn: transitionSchema.nullable().optional(),
      transitionOut: transitionSchema.nullable().optional(),
      time: time.optional(),
    }),
    run: ({ engine, source }, { layerId: id, time: t, ...upd }) => {
      engine.updateLayer(id, upd, source, t ?? engine.session.currentTime);
      const f = engine.findLayer(id);
      return engine.summarizeLayer(f.layer, f.index);
    },
  }),
  tool({
    name: "delete_layer",
    title: "Supprimer des calques",
    description: "Supprime un ou plusieurs calques. Action sensible (confirmation demandée à l'utilisateur).",
    input: z.object({ layerIds: z.array(z.string()).min(1) }),
    sensitive: true,
    run: ({ engine, source }, a) => ({ deleted: engine.deleteLayers(a.layerIds, source) }),
  }),
  tool({
    name: "duplicate_layer",
    title: "Dupliquer un calque",
    description: "Duplique un calque (avec animations et effets) juste au-dessus de l'original.",
    input: z.object({ layerId }),
    run: ({ engine, source }, a) => {
      const l = engine.duplicateLayer(a.layerId, source);
      return { id: l.id, name: l.name };
    },
  }),
  tool({
    name: "reorder_layer",
    title: "Réordonner un calque",
    description: "Change la position d'un calque dans la pile (0 = tout en dessous).",
    input: z.object({ layerId, index: z.number().int().min(0) }),
    run: ({ engine, source }, a) => {
      engine.reorderLayer(a.layerId, a.index, source);
      return { ok: true };
    },
  }),
  tool({
    name: "set_property",
    title: "Définir une propriété",
    description: `Définit la valeur d'une propriété (keyframe au temps donné si elle est animée). ${PROPERTY_HELP}`,
    input: z.object({ layerId, property: z.string(), value: valueSchema, time: time.optional() }),
    run: ({ engine, source }, a) => {
      engine.setProperty(a.layerId, a.property, a.value as PropertyValue, a.time ?? engine.session.currentTime, source);
      return { property: a.property, value: engine.getValue(a.layerId, a.property, a.time ?? engine.session.currentTime) };
    },
  }),
  tool({
    name: "add_keyframe",
    title: "Ajouter une keyframe",
    description: `Ajoute (ou remplace) une keyframe. Si value est omis, la valeur actuelle à ce temps est utilisée. L'easing s'applique au segment qui démarre sur cette keyframe. ${PROPERTY_HELP}`,
    input: z.object({ layerId, property: z.string(), time, value: valueSchema.optional(), easing: easingSchema.optional() }),
    run: ({ engine, source }, a) => ({ keyframeId: engine.addKeyframe(a.layerId, a.property, a.time, a.value as PropertyValue | undefined, a.easing ?? "easeInOut", source) }),
  }),
  tool({
    name: "add_keyframes",
    title: "Ajouter plusieurs keyframes",
    description: `Ajoute plusieurs keyframes d'un coup (animation multi-keyframes). ${PROPERTY_HELP}`,
    input: z.object({
      layerId,
      keyframes: z.array(z.object({ property: z.string(), time, value: valueSchema, easing: easingSchema.optional() })).min(1).max(500),
    }),
    run: ({ engine, source }, a) => ({
      keyframeIds: a.keyframes.map((k) => engine.addKeyframe(a.layerId, k.property, k.time, k.value as PropertyValue, k.easing ?? "easeInOut", source)),
    }),
  }),
  tool({
    name: "remove_keyframe",
    title: "Supprimer une keyframe",
    description: "Supprime une keyframe (par id ou par temps).",
    input: z.object({ layerId, property: z.string(), keyframeId: z.string().optional(), time: time.optional() }),
    run: ({ engine, source }, a) => {
      const key = a.keyframeId ?? a.time;
      if (key === undefined) throw new EngineError("Indiquer keyframeId ou time.");
      engine.removeKeyframe(a.layerId, a.property, key, source);
      return { ok: true };
    },
  }),
  tool({
    name: "set_keyframe_easing",
    title: "Courbe d'animation",
    description: "Change la courbe d'interpolation d'une keyframe (ou de toutes avec keyframeId='all').",
    input: z.object({ layerId, property: z.string(), keyframeId: z.string().default("all"), easing: easingSchema }),
    run: ({ engine, source }, a) => {
      engine.setKeyframeEasing(a.layerId, a.property, a.keyframeId, a.easing as any, source);
      return { ok: true };
    },
  }),
  tool({
    name: "list_presets",
    title: "Presets d'animation",
    description: "Liste les presets d'animation disponibles pour create_animation.",
    input: z.object({}),
    readOnly: true,
    run: () => PRESETS.map((p) => ({ id: p.id, label: p.label, category: p.category, description: p.description, defaultDuration: p.defaultDuration })),
  }),
  tool({
    name: "create_animation",
    title: "Créer une animation",
    description:
      "Applique un preset d'animation professionnel à un calque (crée les keyframes). Presets : " +
      PRESETS.map((p) => `${p.id} (${p.label})`).join(", ") +
      ". Les presets de sortie se placent par défaut à la fin du calque.",
    input: z.object({
      layerId,
      preset: z.enum(presetIds),
      start: time.optional(),
      duration: z.number().positive().max(60).optional(),
      intensity: z.number().min(0.1).max(3).default(1),
    }),
    run: ({ engine, source }, a) => engine.applyPreset(a.layerId, a.preset, a.start, a.duration, a.intensity, source),
  }),
  tool({
    name: "list_effects",
    title: "Effets disponibles",
    description: "Liste les effets visuels disponibles et leurs paramètres.",
    input: z.object({}),
    readOnly: true,
    run: () => listEffectDefs().map((d) => ({ type: d.type, label: d.label, category: d.category, description: d.description, params: d.params })),
  }),
  tool({
    name: "apply_effect",
    title: "Appliquer un effet",
    description: "Ajoute un effet à un calque : " + listEffectDefs().map((d) => `${d.type} (${d.params.map((p) => p.key).join(", ")})`).join("; ") + ".",
    input: z.object({ layerId, effect: z.string(), params: z.record(z.string(), valueSchema).optional() }),
    run: ({ engine, source }, a) => {
      const fx = engine.addEffect(a.layerId, a.effect, (a.params ?? {}) as Record<string, PropertyValue>, source);
      return { effectId: fx.id, type: fx.type };
    },
  }),
  tool({
    name: "update_effect",
    title: "Modifier un effet",
    description: "Modifie les paramètres d'un effet ou l'active/désactive. Pour animer un paramètre, utiliser add_keyframe avec property 'effects.<effectId>.<param>'.",
    input: z.object({ layerId, effectId: z.string(), enabled: z.boolean().optional(), params: z.record(z.string(), valueSchema).optional(), time: time.optional() }),
    run: ({ engine, source }, a) => {
      engine.updateEffect(a.layerId, a.effectId, { enabled: a.enabled, params: a.params as Record<string, PropertyValue> }, source, a.time ?? engine.session.currentTime);
      return { ok: true };
    },
  }),
  tool({
    name: "remove_effect",
    title: "Retirer un effet",
    description: "Retire un effet d'un calque.",
    input: z.object({ layerId, effectId: z.string() }),
    run: ({ engine, source }, a) => {
      engine.removeEffect(a.layerId, a.effectId, source);
      return { ok: true };
    },
  }),
  tool({
    name: "add_mask",
    title: "Ajouter un masque",
    description: "Ajoute un masque (rectangle, ellipse ou polygone, coordonnées relatives au centre du calque) avec contour progressif.",
    input: z.object({
      layerId,
      shape: z.enum(["rectangle", "ellipse", "polygon"]).default("rectangle"),
      x: z.number().optional(),
      y: z.number().optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      points: z.array(z.object({ x: z.number(), y: z.number() })).optional(),
      mode: z.enum(["add", "subtract", "intersect"]).default("add"),
      inverted: z.boolean().default(false),
      feather: z.number().min(0).max(500).default(0),
    }),
    run: ({ engine, source }, { layerId: id, ...m }) => ({ maskId: engine.addMask(id, m, source).id }),
  }),
  tool({
    name: "set_transition",
    title: "Transition d'un clip",
    description: "Définit la transition d'entrée et/ou de sortie d'un calque (fade, slide-*, zoom, blur, wipe). null pour retirer.",
    input: z.object({ layerId, transitionIn: transitionSchema.nullable().optional(), transitionOut: transitionSchema.nullable().optional() }),
    run: ({ engine, source }, a) => {
      engine.updateLayer(a.layerId, { transitionIn: a.transitionIn, transitionOut: a.transitionOut }, source);
      return { ok: true };
    },
  }),
  tool({
    name: "add_transitions_between_clips",
    title: "Transitions entre clips",
    description: "Ajoute des transitions entre les clips successifs (vidéos/images/compositions, ou layerIds). overlap=true crée de vrais fondus enchaînés en faisant se chevaucher les clips.",
    input: z.object({
      layerIds: z.array(z.string()).optional(),
      type: z.enum(transitionTypes).default("fade"),
      duration: z.number().positive().max(5).default(0.5),
      overlap: z.boolean().default(false),
    }),
    run: ({ engine, source }, a) => engine.addTransitionsBetweenClips(a, source),
  }),
  tool({
    name: "split_layer",
    title: "Découper un clip",
    description: "Découpe un calque en deux au temps donné (défaut : temps courant). Renvoie le nouveau calque (partie droite).",
    input: z.object({ layerId, time: time.optional() }),
    run: ({ engine, source }, a) => {
      const r = engine.splitLayer(a.layerId, a.time ?? engine.session.currentTime, source);
      return { newLayerId: r.id, name: r.name };
    },
  }),
  tool({
    name: "merge_layers",
    title: "Fusionner des clips",
    description: "Fusionne deux clips contigus provenant de la même source (inverse de split_layer).",
    input: z.object({ firstLayerId: z.string(), secondLayerId: z.string() }),
    run: ({ engine, source }, a) => {
      const l = engine.mergeLayers(a.firstLayerId, a.secondLayerId, source);
      return { layerId: l.id, inPoint: l.inPoint, outPoint: l.outPoint };
    },
  }),
  tool({
    name: "move_layer_in_time",
    title: "Déplacer dans le temps",
    description: "Décale un calque (et ses keyframes) dans le temps. Fournir delta (s) ou newInPoint.",
    input: z.object({ layerId, delta: z.number().optional(), newInPoint: time.optional() }),
    run: ({ engine, source }, a) => {
      const l = engine.findLayer(a.layerId).layer;
      const d = a.delta ?? (a.newInPoint !== undefined ? a.newInPoint - l.inPoint : 0);
      engine.shiftLayer(a.layerId, d, source);
      const n = engine.findLayer(a.layerId).layer;
      return { inPoint: n.inPoint, outPoint: n.outPoint };
    },
  }),
  tool({
    name: "precompose",
    title: "Pré-composer",
    description: "Regroupe des calques dans une nouvelle composition imbriquée.",
    input: z.object({ layerIds: z.array(z.string()).min(1), name: z.string().default("Pré-composition") }),
    run: ({ engine, source }, a) => {
      const r = engine.precompose(a.layerIds, a.name, source);
      return { compositionId: r.composition.id, layerId: r.layer.id };
    },
  }),
  tool({
    name: "optimize_animations",
    title: "Optimiser les animations",
    description: "Nettoie le projet : keyframes redondantes, doublons, effets neutres, calques dépassant la composition. Ne change pas le rendu.",
    input: z.object({ compositionId: z.string().optional() }),
    run: ({ engine, source }, a) => engine.optimizeAnimations(a.compositionId, source),
  }),
  tool({
    name: "select_layers",
    title: "Sélectionner des calques",
    description: "Sélectionne des calques dans l'éditeur (pour montrer à l'utilisateur sur quoi on travaille).",
    input: z.object({ layerIds: z.array(z.string()) }),
    run: ({ engine }, a) => {
      const ids = a.layerIds.map((id) => engine.findLayer(id).layer.id);
      engine.select(ids);
      return { selected: ids };
    },
  }),
  tool({
    name: "set_current_time",
    title: "Déplacer la tête de lecture",
    description: "Place la tête de lecture au temps donné.",
    input: z.object({ time }),
    run: ({ engine }, a) => {
      engine.setSession({ currentTime: Math.min(a.time, engine.comp().duration) });
      return { currentTime: engine.session.currentTime };
    },
  }),
  tool({
    name: "import_media",
    title: "Importer un média",
    description:
      "Importe une vidéo, image, un son ou un SVG dans le projet depuis une URL (http/https/data) ou un chemin de fichier local (côté serveur MCP). " +
      "addToTimeline=true crée directement le calque. Action sensible.",
    input: z.object({
      url: z.string().optional(),
      path: z.string().optional(),
      name: z.string().optional(),
      addToTimeline: z.boolean().default(true),
    }),
    sensitive: true,
    run: async ({ engine, host, source }, a) => {
      if (!host?.importMedia) throw new EngineError("L'import de médias n'est pas disponible dans cet environnement.", "unsupported");
      if (!a.url && !a.path) throw new EngineError("Indiquer url ou path.");
      const asset = await host.importMedia(a);
      let layer;
      if (a.addToTimeline) {
        const type = asset.kind === "svg" ? "image" : asset.kind;
        layer = engine.createLayer(type, { assetId: asset.id, inPoint: engine.session.currentTime }, source);
      }
      return { asset, layerId: layer?.id };
    },
  }),
  tool({
    name: "get_preview",
    title: "Aperçu d'une image",
    description: "Rend l'image de la composition au temps donné et la renvoie (PNG/JPEG). Utile pour vérifier visuellement le résultat.",
    input: z.object({
      time: time.optional(),
      width: z.number().int().min(64).max(1920).default(640).describe("Largeur de l'aperçu en pixels."),
      format: z.enum(["png", "jpeg"]).default("jpeg"),
    }),
    readOnly: true,
    run: async ({ engine, host }, a) => {
      if (!host?.renderPreview) throw new EngineError("L'aperçu nécessite l'éditeur ouvert (rendu Canvas).", "unsupported");
      return host.renderPreview({ time: a.time ?? engine.session.currentTime, width: a.width, format: a.format });
    },
  }),
  tool({
    name: "export_video",
    title: "Exporter la vidéo",
    description:
      "Exporte la composition active en vidéo : mp4 (H.264, selon le support du navigateur) ou webm (VP9/VP8). " +
      "Le fichier est écrit par le serveur MCP dans son dossier d'export. Action sensible.",
    input: z.object({
      format: z.enum(["mp4", "webm"]).default("mp4"),
      width: z.number().int().min(16).max(7680).optional(),
      height: z.number().int().min(16).max(7680).optional(),
      fps: z.number().min(1).max(120).optional(),
      start: time.optional(),
      end: time.optional(),
      quality: z.enum(["low", "medium", "high"]).default("high"),
      fileName: z.string().optional(),
      includeAudio: z.boolean().default(true),
    }),
    sensitive: true,
    run: async ({ host }, a) => {
      if (!host?.exportVideo) throw new EngineError("L'export vidéo nécessite l'éditeur ouvert.", "unsupported");
      return host.exportVideo(a);
    },
  }),
  tool({
    name: "get_history",
    title: "Historique",
    description: "Liste les dernières actions annulables / rétablissables, avec leur source (user, ai, mcp).",
    input: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    readOnly: true,
    run: ({ engine }, a) => {
      const h = engine.store.history();
      const map = (e: { id: number; label: string; source: string; timestamp: number }) => ({ id: e.id, label: e.label, source: e.source, at: new Date(e.timestamp).toISOString() });
      return { undo: h.undo.slice(-a.limit).reverse().map(map), redo: h.redo.slice(-a.limit).reverse().map(map) };
    },
  }),
  tool({
    name: "undo_action",
    title: "Annuler",
    description: "Annule la dernière action (ou `steps` actions).",
    input: z.object({ steps: z.number().int().min(1).max(50).default(1) }),
    run: ({ engine }, a) => {
      const undone: string[] = [];
      for (let i = 0; i < a.steps; i++) {
        const e = engine.undo();
        if (!e) break;
        undone.push(e.label);
      }
      return { undone };
    },
  }),
  tool({
    name: "redo_action",
    title: "Rétablir",
    description: "Rétablit la dernière action annulée (ou `steps` actions).",
    input: z.object({ steps: z.number().int().min(1).max(50).default(1) }),
    run: ({ engine }, a) => {
      const redone: string[] = [];
      for (let i = 0; i < a.steps; i++) {
        const e = engine.redo();
        if (!e) break;
        redone.push(e.label);
      }
      return { redone };
    },
  }),
];

export type ToolName = (typeof TOOLS)[number]["name"];

export function getTool(name: string): ToolDef {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new EngineError(`Outil inconnu: ${name}`, "not_found");
  return t as unknown as ToolDef;
}

/** Schéma JSON (draft 2020-12) des paramètres d'un outil, pour MCP et l'API Claude. */
export function toolJsonSchema(t: ToolDef): Record<string, unknown> {
  const s = z.toJSONSchema(t.input, { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}

export interface ToolCallOutcome {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** Valide puis exécute un outil. Ne lève jamais : les erreurs sont renvoyées structurées. */
export async function executeTool(ctx: ToolContext, name: string, rawArgs: unknown): Promise<ToolCallOutcome> {
  let t: ToolDef;
  try {
    t = getTool(name);
  } catch (e) {
    return { ok: false, error: { code: "unknown_tool", message: (e as Error).message } };
  }
  const parsed = t.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const message = parsed.error.issues.map((i) => `${i.path.join(".") || "(racine)"}: ${i.message}`).join("; ");
    return { ok: false, error: { code: "invalid_arguments", message } };
  }
  try {
    const result = await t.run(ctx, parsed.data);
    return { ok: true, result };
  } catch (e) {
    const err = e as Error & { code?: string };
    return { ok: false, error: { code: err instanceof EngineError ? err.code : "execution_error", message: err.message } };
  }
}
