import type { Draft } from "immer";
import { canonicalPath, evaluate, getPropertyAtPath, isAnimated, listAnimatablePaths } from "./animation";
import { resolveEasing } from "./easing";
import { createEffect, getEffectDef } from "./effects";
import { createComposition, createLayer, createProject, type CompositionOptions } from "./factory";
import { getPreset, upsertKeyframe } from "./presets";
import { ProjectStore } from "./store";
import type {
  AnimatableProperty,
  Asset,
  BlendMode,
  ChangeSource,
  Composition,
  Easing,
  Layer,
  LayerType,
  Mask,
  Project,
  PropertyValue,
  ShapeKind,
  Transition,
} from "./types";
import { TRANSFORM_KEYS } from "./types";
import { deepClone, isColorString, normalizeColor, round, uid } from "./util";

export class EngineError extends Error {
  constructor(message: string, public code = "invalid_request") {
    super(message);
  }
}

/** État de session (non historisé) : sélection, tête de lecture. */
export interface SessionState {
  selectedLayerIds: string[];
  currentTime: number;
  selectedKeyframe?: { layerId: string; path: string; keyframeId: string } | null;
}

export interface LayerSummary {
  id: string;
  name: string;
  type: LayerType;
  index: number;
  inPoint: number;
  outPoint: number;
  visible: boolean;
  locked: boolean;
  parentId?: string | null;
  text?: string;
  assetId?: string;
  compositionId?: string;
  effects: { id: string; type: string; enabled: boolean }[];
  animatedProperties: string[];
  keyframeCount: number;
  transitionIn?: Transition | null;
  transitionOut?: Transition | null;
}

export interface LayerUpdate {
  name?: string;
  inPoint?: number;
  outPoint?: number;
  visible?: boolean;
  locked?: boolean;
  solo?: boolean;
  blendMode?: BlendMode;
  parentId?: string | null;
  motionBlur?: boolean;
  /** Valeurs de transformation (positionX, scaleX, rotation, opacity…). */
  transform?: Partial<Record<string, number>>;
  /** Propriétés spécifiques (text, fill, fontSize…). */
  props?: Record<string, unknown>;
  transitionIn?: Transition | null;
  transitionOut?: Transition | null;
}

export interface CreateLayerOptions {
  name?: string;
  inPoint?: number;
  outPoint?: number;
  x?: number;
  y?: number;
  assetId?: string;
  compositionId?: string;
  /** Index d'insertion (0 = tout en dessous). Par défaut : au-dessus de tout. */
  index?: number;
  props?: Record<string, unknown>;
  transform?: Partial<Record<string, number>>;
}

const BLEND_MODES: BlendMode[] = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add", "difference"];

function assertFinite(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new EngineError(`${what} doit être un nombre fini (reçu: ${JSON.stringify(v)})`);
  return v;
}

function allProps(layer: Draft<Layer>): Draft<AnimatableProperty>[] {
  const out: Draft<AnimatableProperty>[] = [];
  for (const k of TRANSFORM_KEYS) out.push(layer.transform[k] as any);
  for (const v of Object.values(layer.props)) if (v && typeof v === "object" && "value" in (v as object)) out.push(v as any);
  for (const fx of layer.effects) for (const p of Object.values(fx.params)) out.push(p as any);
  for (const m of layer.masks) out.push(m.feather as any, m.opacity as any);
  return out;
}

/**
 * EditorEngine : API interne unique de l'application.
 *
 * L'interface utilisateur, l'assistant IA intégré et le serveur MCP passent TOUS par
 * cette classe. Chaque méthode modifiante crée une entrée d'historique annulable,
 * étiquetée avec sa source (user / ai / mcp).
 */
export class EditorEngine {
  readonly store: ProjectStore;
  session: SessionState = { selectedLayerIds: [], currentTime: 0, selectedKeyframe: null };
  private sessionListeners = new Set<() => void>();

  constructor(project?: Project) {
    this.store = new ProjectStore(project ?? createProject());
  }

  get project(): Project {
    return this.store.project;
  }

  // ---------------------------------------------------------------- session

  onSession(fn: () => void) {
    this.sessionListeners.add(fn);
    return () => this.sessionListeners.delete(fn);
  }

  setSession(patch: Partial<SessionState>) {
    this.session = { ...this.session, ...patch };
    for (const l of this.sessionListeners) l();
  }

  select(ids: string[]) {
    this.setSession({ selectedLayerIds: ids });
  }

  // ---------------------------------------------------------------- lecture

  comp(id?: string): Composition {
    const cid = id ?? this.project.activeCompositionId;
    const c = this.project.compositions.find((x) => x.id === cid);
    if (!c) throw new EngineError(`Composition introuvable: ${cid}`, "not_found");
    return c;
  }

  findLayer(layerId: string, compId?: string): { comp: Composition; layer: Layer; index: number } {
    const comps = compId ? [this.comp(compId)] : [this.comp(), ...this.project.compositions.filter((c) => c.id !== this.project.activeCompositionId)];
    for (const comp of comps) {
      const index = comp.layers.findIndex((l) => l.id === layerId);
      if (index >= 0) return { comp, layer: comp.layers[index], index };
    }
    // Tolérance : recherche par nom (pratique pour l'IA).
    for (const comp of comps) {
      const index = comp.layers.findIndex((l) => l.name.toLowerCase() === layerId.toLowerCase());
      if (index >= 0) return { comp, layer: comp.layers[index], index };
    }
    throw new EngineError(`Calque introuvable: ${layerId}`, "not_found");
  }

  summarizeLayer(layer: Layer, index: number): LayerSummary {
    const animated = listAnimatablePaths(layer).filter((p) => isAnimated(getPropertyAtPath(layer, p)));
    const keyframeCount = animated.reduce((n, p) => n + (getPropertyAtPath(layer, p)?.keyframes?.length ?? 0), 0);
    return {
      id: layer.id,
      name: layer.name,
      type: layer.type,
      index,
      inPoint: round(layer.inPoint),
      outPoint: round(layer.outPoint),
      visible: layer.visible,
      locked: layer.locked,
      parentId: layer.parentId ?? null,
      text: layer.props.text,
      assetId: layer.props.assetId,
      compositionId: layer.props.compositionId,
      effects: layer.effects.map((e) => ({ id: e.id, type: e.type, enabled: e.enabled })),
      animatedProperties: animated,
      keyframeCount,
      transitionIn: layer.transitionIn ?? null,
      transitionOut: layer.transitionOut ?? null,
    };
  }

  getProjectInfo() {
    const p = this.project;
    const c = this.comp();
    return {
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      activeCompositionId: p.activeCompositionId,
      compositions: p.compositions.map((x) => ({
        id: x.id,
        name: x.name,
        width: x.width,
        height: x.height,
        fps: x.fps,
        duration: x.duration,
        background: x.background,
        layerCount: x.layers.length,
      })),
      activeComposition: { id: c.id, name: c.name, width: c.width, height: c.height, fps: c.fps, duration: c.duration },
      assets: p.assets.map((a) => ({ id: a.id, name: a.name, kind: a.kind, duration: a.duration, width: a.width, height: a.height })),
      selection: this.session.selectedLayerIds,
      currentTime: round(this.session.currentTime),
      canUndo: this.store.canUndo(),
      canRedo: this.store.canRedo(),
    };
  }

  getTimeline(compId?: string) {
    const c = this.comp(compId);
    return {
      compositionId: c.id,
      name: c.name,
      duration: c.duration,
      fps: c.fps,
      width: c.width,
      height: c.height,
      currentTime: round(this.session.currentTime),
      /** Ordre : du calque du dessus vers le calque du dessous (comme l'affichage). */
      layers: c.layers.map((l, i) => this.summarizeLayer(l, i)).reverse(),
    };
  }

  getLayerDetails(layerId: string) {
    const { layer, index } = this.findLayer(layerId);
    return { ...this.summarizeLayer(layer, index), layer: deepClone(layer) };
  }

  getValue(layerId: string, path: string, time = this.session.currentTime): PropertyValue | undefined {
    const { layer } = this.findLayer(layerId);
    return evaluate(getPropertyAtPath(layer, path) as AnimatableProperty, time);
  }

  // ---------------------------------------------------------------- utilitaires internes

  private mutateLayer<R>(layerId: string, label: string, source: ChangeSource, fn: (layer: Draft<Layer>, comp: Draft<Composition>) => R): R {
    const { comp, layer } = this.findLayer(layerId);
    if (layer.locked && source !== "user") throw new EngineError(`Le calque "${layer.name}" est verrouillé.`, "locked");
    return this.store.transact(
      label,
      (d) => {
        const dc = d.compositions.find((c) => c.id === comp.id)!;
        const dl = dc.layers.find((l) => l.id === layer.id)!;
        const r = fn(dl, dc);
        d.updatedAt = new Date().toISOString();
        return r;
      },
      source,
    );
  }

  private coerceValue(current: unknown, v: unknown, key: string): PropertyValue {
    if (typeof current === "string" || (current === undefined && typeof v === "string")) {
      if (typeof v !== "string" || !isColorString(v)) throw new EngineError(`La propriété ${key} attend une couleur (#rrggbb).`);
      return normalizeColor(v);
    }
    return assertFinite(v, key);
  }

  private resolveProp(layer: Draft<Layer>, path: string): Draft<AnimatableProperty> {
    const p = getPropertyAtPath(layer as Layer, canonicalPath(layer as Layer, path));
    if (!p) {
      throw new EngineError(
        `Propriété "${path}" introuvable ou non animable sur le calque "${layer.name}". Propriétés disponibles: ${listAnimatablePaths(layer as Layer).join(", ")}`,
      );
    }
    return p as Draft<AnimatableProperty>;
  }

  // ---------------------------------------------------------------- projet & compositions

  newProject(opts: CompositionOptions & { projectName?: string } = {}, source: ChangeSource = "user"): Project {
    const p = createProject(opts);
    this.store.load(p);
    this.setSession({ selectedLayerIds: [], currentTime: 0, selectedKeyframe: null });
    void source;
    return p;
  }

  loadProject(p: Project) {
    this.store.load(p);
    this.setSession({ selectedLayerIds: [], currentTime: 0, selectedKeyframe: null });
  }

  renameProject(name: string, source: ChangeSource = "user") {
    this.store.transact("Renommer le projet", (d) => void (d.name = name), source);
  }

  updateComposition(
    patch: Partial<Pick<Composition, "name" | "width" | "height" | "fps" | "duration" | "background" | "shutterAngle" | "motionBlurSamples">>,
    compId?: string,
    source: ChangeSource = "user",
  ) {
    const c = this.comp(compId);
    if (patch.width !== undefined && (patch.width < 16 || patch.width > 7680)) throw new EngineError("Largeur hors limites (16–7680).");
    if (patch.height !== undefined && (patch.height < 16 || patch.height > 7680)) throw new EngineError("Hauteur hors limites (16–7680).");
    if (patch.fps !== undefined && (patch.fps < 1 || patch.fps > 120)) throw new EngineError("FPS hors limites (1–120).");
    if (patch.duration !== undefined && (patch.duration <= 0 || patch.duration > 3600)) throw new EngineError("Durée hors limites (0–3600 s).");
    if (patch.background !== undefined) patch.background = normalizeColor(patch.background);
    this.store.transact(
      "Paramètres de composition",
      (d) => {
        const dc = d.compositions.find((x) => x.id === c.id)!;
        Object.assign(dc, patch);
      },
      source,
    );
    return this.comp(c.id);
  }

  createComposition(opts: CompositionOptions & { activate?: boolean } = {}, source: ChangeSource = "user"): Composition {
    const base = this.comp();
    const comp = createComposition({ width: base.width, height: base.height, fps: base.fps, duration: base.duration, ...opts });
    this.store.transact(
      `Nouvelle composition « ${comp.name} »`,
      (d) => {
        d.compositions.push(comp as any);
        if (opts.activate) d.activeCompositionId = comp.id;
      },
      source,
    );
    return comp;
  }

  setActiveComposition(compId: string, source: ChangeSource = "user") {
    this.comp(compId);
    this.store.transact("Changer de composition", (d) => void (d.activeCompositionId = compId), source);
    this.setSession({ selectedLayerIds: [] });
  }

  // ---------------------------------------------------------------- médias

  addAsset(asset: Omit<Asset, "id"> & { id?: string }, source: ChangeSource = "user"): Asset {
    const a: Asset = { ...asset, id: asset.id ?? uid("asset") };
    this.store.transact(`Importer « ${a.name} »`, (d) => void d.assets.push(a as any), source);
    return a;
  }

  removeAsset(assetId: string, source: ChangeSource = "user") {
    const used = this.project.compositions.some((c) => c.layers.some((l) => l.props.assetId === assetId));
    if (used) throw new EngineError("Ce média est utilisé par au moins un calque.");
    this.store.transact("Supprimer un média", (d) => void (d.assets = d.assets.filter((a) => a.id !== assetId)), source);
  }

  // ---------------------------------------------------------------- calques

  createLayer(type: LayerType, opts: CreateLayerOptions = {}, source: ChangeSource = "user"): Layer {
    const comp = this.comp();
    let asset: Asset | undefined;
    if (type === "image" || type === "video" || type === "audio") {
      if (!opts.assetId) throw new EngineError(`Un calque ${type} nécessite un assetId (importez d'abord le média).`);
      asset = this.project.assets.find((a) => a.id === opts.assetId);
      if (!asset) throw new EngineError(`Média introuvable: ${opts.assetId}`, "not_found");
    }
    if (type === "composition") {
      if (!opts.compositionId) throw new EngineError("Un calque composition nécessite compositionId.");
      if (opts.compositionId === comp.id) throw new EngineError("Une composition ne peut pas se contenir elle-même.");
      this.comp(opts.compositionId);
    }
    const layer = createLayer(type, comp, { name: opts.name, inPoint: opts.inPoint, outPoint: opts.outPoint, x: opts.x, y: opts.y }, asset);
    if (type === "composition") layer.props.compositionId = opts.compositionId;
    if (type === "camera") layer.name = opts.name ?? "Caméra";
    // Médias : mise à l'échelle pour tenir dans la composition.
    if (asset && (type === "image" || type === "video") && asset.width && asset.height) {
      const fit = Math.min(1, comp.width / asset.width, comp.height / asset.height);
      layer.transform.scaleX.value = round(fit * 100, 3);
      layer.transform.scaleY.value = round(fit * 100, 3);
    }
    const applyPatch = (l: Layer) => {
      if (opts.props) this.applyPropsPatch(l as Draft<Layer>, opts.props);
      if (opts.transform) this.applyTransformPatch(l as Draft<Layer>, opts.transform, 0);
    };
    applyPatch(layer);
    this.store.transact(
      `Ajouter le calque « ${layer.name} »`,
      (d) => {
        const dc = d.compositions.find((c) => c.id === comp.id)!;
        const idx = opts.index === undefined ? dc.layers.length : Math.max(0, Math.min(dc.layers.length, opts.index));
        dc.layers.splice(idx, 0, layer as any);
        d.updatedAt = new Date().toISOString();
      },
      source,
    );
    return this.findLayer(layer.id).layer;
  }

  createText(text: string, opts: CreateLayerOptions & { fontSize?: number; color?: string; fontFamily?: string; fontWeight?: number } = {}, source: ChangeSource = "user") {
    const props: Record<string, unknown> = { text, ...(opts.props ?? {}) };
    if (opts.fontSize !== undefined) props.fontSize = opts.fontSize;
    if (opts.color !== undefined) props.textColor = opts.color;
    if (opts.fontFamily !== undefined) props.fontFamily = opts.fontFamily;
    if (opts.fontWeight !== undefined) props.fontWeight = opts.fontWeight;
    return this.createLayer("text", { ...opts, name: opts.name ?? text.slice(0, 32), props }, source);
  }

  createShape(kind: ShapeKind, opts: CreateLayerOptions & { width?: number; height?: number; fill?: string } = {}, source: ChangeSource = "user") {
    const props: Record<string, unknown> = { shapeKind: kind, ...(opts.props ?? {}) };
    if (opts.width !== undefined) props.width = opts.width;
    if (opts.height !== undefined) props.height = opts.height;
    if (opts.fill !== undefined) props.fill = opts.fill;
    const names: Record<ShapeKind, string> = { rectangle: "Rectangle", ellipse: "Ellipse", polygon: "Polygone", star: "Étoile", path: "Tracé" };
    return this.createLayer("shape", { ...opts, name: opts.name ?? names[kind], props }, source);
  }

  deleteLayers(ids: string[], source: ChangeSource = "user") {
    const found = ids.map((id) => this.findLayer(id));
    const names = found.map((f) => f.layer.name);
    this.store.transact(
      ids.length === 1 ? `Supprimer « ${names[0]} »` : `Supprimer ${ids.length} calques`,
      (d) => {
        for (const f of found) {
          const dc = d.compositions.find((c) => c.id === f.comp.id)!;
          dc.layers = dc.layers.filter((l) => l.id !== f.layer.id);
          for (const l of dc.layers) if (l.parentId === f.layer.id) l.parentId = null;
        }
      },
      source,
    );
    this.setSession({ selectedLayerIds: this.session.selectedLayerIds.filter((id) => !found.some((f) => f.layer.id === id)) });
    return names;
  }

  duplicateLayer(layerId: string, source: ChangeSource = "user"): Layer {
    const { comp, layer, index } = this.findLayer(layerId);
    const copy = deepClone(layer);
    copy.id = uid("layer");
    copy.name = `${layer.name} copie`;
    for (const fx of copy.effects) fx.id = uid("fx");
    for (const m of copy.masks) m.id = uid("mask");
    for (const p of allProps(copy as Draft<Layer>)) for (const k of p.keyframes ?? []) k.id = uid("kf");
    this.store.transact(
      `Dupliquer « ${layer.name} »`,
      (d) => void d.compositions.find((c) => c.id === comp.id)!.layers.splice(index + 1, 0, copy as any),
      source,
    );
    return copy;
  }

  reorderLayer(layerId: string, newIndex: number, source: ChangeSource = "user") {
    const { comp, index, layer } = this.findLayer(layerId);
    this.store.transact(
      `Réordonner « ${layer.name} »`,
      (d) => {
        const dc = d.compositions.find((c) => c.id === comp.id)!;
        const [l] = dc.layers.splice(index, 1);
        dc.layers.splice(Math.max(0, Math.min(dc.layers.length, newIndex)), 0, l);
      },
      source,
    );
  }

  private applyTransformPatch(layer: Draft<Layer>, patch: Partial<Record<string, number>>, time: number) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      if (!TRANSFORM_KEYS.includes(k as any)) throw new EngineError(`Propriété de transformation inconnue: ${k}. Valides: ${TRANSFORM_KEYS.join(", ")}`);
      const p = layer.transform[k as keyof Layer["transform"]];
      const val = assertFinite(v, k);
      if (isAnimated(p as any)) upsertKeyframe(p as any, time, val, "easeInOut");
      else p.value = val;
    }
  }

  private applyPropsPatch(layer: Draft<Layer>, patch: Record<string, unknown>, time = 0) {
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) continue;
      const cur = (layer.props as any)[k];
      if (cur && typeof cur === "object" && "value" in cur) {
        const val = this.coerceValue(cur.value, v, k);
        if (isAnimated(cur)) upsertKeyframe(cur, time, val, "easeInOut");
        else cur.value = val;
        continue;
      }
      switch (k) {
        case "text":
        case "fontFamily":
        case "pathData":
          if (typeof v !== "string") throw new EngineError(`${k} doit être une chaîne.`);
          (layer.props as any)[k] = v;
          break;
        case "align":
          if (!["left", "center", "right"].includes(v as string)) throw new EngineError("align: left | center | right");
          layer.props.align = v as any;
          break;
        case "shapeKind":
          if (!["rectangle", "ellipse", "polygon", "star", "path"].includes(v as string)) throw new EngineError("shapeKind: rectangle | ellipse | polygon | star | path");
          layer.props.shapeKind = v as ShapeKind;
          break;
        case "textAnimator":
          if (!["none", "typewriter", "fade", "slide-up", "scale", "wave"].includes(v as string)) throw new EngineError("textAnimator: none | typewriter | fade | slide-up | scale | wave");
          layer.props.textAnimator = v as any;
          break;
        case "emitterShape":
          if (!["point", "line", "circle"].includes(v as string)) throw new EngineError("emitterShape: point | line | circle");
          layer.props.emitterShape = v as any;
          break;
        case "particleShape":
          if (!["circle", "square", "star", "spark"].includes(v as string)) throw new EngineError("particleShape: circle | square | star | spark");
          layer.props.particleShape = v as any;
          break;
        case "fontWeight":
        case "sides":
        case "lineHeight":
        case "lifetime":
        case "seed":
        case "mediaOffset":
        case "playbackRate":
          (layer.props as any)[k] = assertFinite(v, k);
          break;
        case "fillEnabled":
        case "strokeEnabled":
        case "italic":
        case "muted":
          (layer.props as any)[k] = !!v;
          break;
        default: {
          // Propriété animable absente : on la crée si c'est un nombre ou une couleur.
          if (typeof v === "number" || (typeof v === "string" && isColorString(v))) {
            (layer.props as any)[k] = { value: typeof v === "string" ? normalizeColor(v) : v };
          } else {
            throw new EngineError(`Propriété "${k}" non prise en charge pour un calque ${layer.type}.`);
          }
        }
      }
    }
  }

  updateLayer(layerId: string, upd: LayerUpdate, source: ChangeSource = "user", time = this.session.currentTime) {
    const { layer: current } = this.findLayer(layerId);
    return this.mutateLayer(layerId, `Modifier « ${current.name} »`, source, (layer, comp) => {
      if (upd.name !== undefined) layer.name = String(upd.name);
      if (upd.inPoint !== undefined) layer.inPoint = Math.max(0, assertFinite(upd.inPoint, "inPoint"));
      if (upd.outPoint !== undefined) layer.outPoint = assertFinite(upd.outPoint, "outPoint");
      if (layer.outPoint <= layer.inPoint) throw new EngineError("outPoint doit être supérieur à inPoint.");
      if (upd.visible !== undefined) layer.visible = !!upd.visible;
      if (upd.locked !== undefined) layer.locked = !!upd.locked;
      if (upd.solo !== undefined) layer.solo = !!upd.solo;
      if (upd.motionBlur !== undefined) layer.motionBlur = !!upd.motionBlur;
      if (upd.blendMode !== undefined) {
        if (!BLEND_MODES.includes(upd.blendMode)) throw new EngineError(`blendMode invalide. Valeurs: ${BLEND_MODES.join(", ")}`);
        layer.blendMode = upd.blendMode;
      }
      if (upd.parentId !== undefined) {
        if (upd.parentId === layer.id) throw new EngineError("Un calque ne peut pas être son propre parent.");
        if (upd.parentId && !comp.layers.some((l) => l.id === upd.parentId)) throw new EngineError("Parent introuvable dans la même composition.");
        // Détection de cycle
        let p = upd.parentId;
        while (p) {
          if (p === layer.id) throw new EngineError("Ce parentage créerait un cycle.");
          p = comp.layers.find((l) => l.id === p)?.parentId ?? null;
        }
        layer.parentId = upd.parentId;
      }
      if (upd.transform) this.applyTransformPatch(layer, upd.transform, time);
      if (upd.props) this.applyPropsPatch(layer, upd.props, time);
      if (upd.transitionIn !== undefined) layer.transitionIn = upd.transitionIn ? this.checkTransition(upd.transitionIn) : null;
      if (upd.transitionOut !== undefined) layer.transitionOut = upd.transitionOut ? this.checkTransition(upd.transitionOut) : null;
    });
  }

  private checkTransition(t: Transition): Transition {
    const types = ["fade", "slide-left", "slide-right", "slide-up", "slide-down", "zoom", "blur", "wipe"];
    if (!types.includes(t.type)) throw new EngineError(`Transition inconnue: ${t.type}. Types: ${types.join(", ")}`);
    return { type: t.type, duration: Math.max(0.05, assertFinite(t.duration, "duration")) };
  }

  /**
   * Définit la valeur d'une propriété. Si elle est animée, crée/modifie la keyframe au
   * temps donné ; sinon modifie la valeur statique.
   */
  setProperty(layerId: string, path: string, value: PropertyValue, time = this.session.currentTime, source: ChangeSource = "user") {
    return this.mutateLayer(layerId, `Modifier ${path}`, source, (layer) => {
      const p = this.resolveProp(layer, path);
      const v = this.coerceValue(p.value, value, path);
      if (isAnimated(p as any)) upsertKeyframe(p as any, time, v, "easeInOut");
      else p.value = v;
    });
  }

  // ---------------------------------------------------------------- keyframes

  addKeyframe(layerId: string, path: string, time: number, value: PropertyValue | undefined, easing: Easing | string = "easeInOut", source: ChangeSource = "user") {
    assertFinite(time, "time");
    return this.mutateLayer(layerId, `Keyframe ${path} @ ${round(time, 2)}s`, source, (layer) => {
      const p = this.resolveProp(layer, path);
      const v = value === undefined ? evaluate(p as AnimatableProperty, time) : this.coerceValue(p.value, value, path);
      // Première keyframe : la valeur statique devient la valeur de référence.
      if (!isAnimated(p as any)) p.value = v;
      return upsertKeyframe(p as any, time, v, easing);
    });
  }

  removeKeyframe(layerId: string, path: string, keyframeIdOrTime: string | number, source: ChangeSource = "user") {
    return this.mutateLayer(layerId, `Supprimer keyframe ${path}`, source, (layer) => {
      const p = this.resolveProp(layer, path);
      const kfs = p.keyframes ?? [];
      const idx = kfs.findIndex((k) => (typeof keyframeIdOrTime === "string" ? k.id === keyframeIdOrTime : Math.abs(k.time - keyframeIdOrTime) < 1e-3));
      if (idx < 0) throw new EngineError("Keyframe introuvable.", "not_found");
      const [removed] = kfs.splice(idx, 1);
      if (kfs.length === 0) {
        p.value = removed.value;
        delete p.keyframes;
      }
    });
  }

  moveKeyframe(layerId: string, path: string, keyframeId: string, newTime: number, newValue?: PropertyValue, source: ChangeSource = "user") {
    return this.mutateLayer(layerId, `Déplacer keyframe ${path}`, source, (layer) => {
      const p = this.resolveProp(layer, path);
      const k = p.keyframes?.find((x) => x.id === keyframeId);
      if (!k) throw new EngineError("Keyframe introuvable.", "not_found");
      k.time = Math.max(0, assertFinite(newTime, "time"));
      if (newValue !== undefined) k.value = this.coerceValue(k.value, newValue, path);
      p.keyframes!.sort((a, b) => a.time - b.time);
    });
  }

  setKeyframeEasing(layerId: string, path: string, keyframeId: string | "all", easing: Easing | string, source: ChangeSource = "user") {
    const e = resolveEasing(easing);
    return this.mutateLayer(layerId, `Courbe ${path}`, source, (layer) => {
      const p = this.resolveProp(layer, path);
      const targets = keyframeId === "all" ? p.keyframes ?? [] : (p.keyframes ?? []).filter((k) => k.id === keyframeId);
      if (!targets.length) throw new EngineError("Keyframe introuvable.", "not_found");
      for (const k of targets) k.easing = deepClone(e) as any;
    });
  }

  clearKeyframes(layerId: string, path: string, source: ChangeSource = "user") {
    return this.mutateLayer(layerId, `Effacer l'animation ${path}`, source, (layer) => {
      const p = this.resolveProp(layer, path);
      if (p.keyframes?.length) p.value = evaluate(p as AnimatableProperty, this.session.currentTime);
      delete p.keyframes;
    });
  }

  /** Active/désactive l'animation d'une propriété (chronomètre) au temps courant. */
  toggleAnimation(layerId: string, path: string, time = this.session.currentTime, source: ChangeSource = "user") {
    const { layer } = this.findLayer(layerId);
    const p = getPropertyAtPath(layer, canonicalPath(layer, path));
    if (isAnimated(p)) return this.clearKeyframes(layerId, path, source);
    return this.addKeyframe(layerId, path, time, undefined, "easeInOut", source);
  }

  applyPreset(layerId: string, presetId: string, start?: number, duration?: number, intensity = 1, source: ChangeSource = "user") {
    const preset = getPreset(presetId);
    const { layer: cur } = this.findLayer(layerId);
    let s = start ?? Math.max(cur.inPoint, 0);
    const d = duration ?? preset.defaultDuration;
    if (start === undefined && preset.category === "sortie") s = Math.max(cur.inPoint, cur.outPoint - d);
    assertFinite(s, "start");
    assertFinite(d, "duration");
    if (d <= 0) throw new EngineError("La durée doit être positive.");
    return this.mutateLayer(layerId, `Animation « ${preset.label} » sur « ${cur.name} »`, source, (layer, comp) => {
      preset.apply({ layer, comp: comp as Composition, start: s, duration: d, intensity });
      return { preset: preset.id, start: s, duration: d };
    });
  }

  // ---------------------------------------------------------------- effets

  addEffect(layerId: string, type: string, params: Record<string, PropertyValue> = {}, source: ChangeSource = "user") {
    let fx;
    try {
      fx = createEffect(type, params);
    } catch (e) {
      throw new EngineError((e as Error).message);
    }
    for (const [k, p] of Object.entries(fx.params)) {
      const def = getEffectDef(type)!.params.find((x) => x.key === k)!;
      p.value = def.kind === "color" ? normalizeColor(String(p.value)) : assertFinite(p.value, k);
    }
    const { layer } = this.findLayer(layerId);
    this.mutateLayer(layerId, `Effet « ${getEffectDef(type)!.label} » sur « ${layer.name} »`, source, (l) => void l.effects.push(fx as any));
    return fx;
  }

  updateEffect(layerId: string, effectId: string, patch: { enabled?: boolean; params?: Record<string, PropertyValue> }, source: ChangeSource = "user", time = this.session.currentTime) {
    return this.mutateLayer(layerId, "Modifier un effet", source, (layer) => {
      const fx = layer.effects.find((e) => e.id === effectId || e.type === effectId);
      if (!fx) throw new EngineError("Effet introuvable.", "not_found");
      if (patch.enabled !== undefined) fx.enabled = !!patch.enabled;
      for (const [k, v] of Object.entries(patch.params ?? {})) {
        const p = fx.params[k];
        if (!p) throw new EngineError(`Paramètre inconnu: ${k}`);
        const val = this.coerceValue(p.value, v, k);
        if (isAnimated(p as any)) upsertKeyframe(p as any, time, val, "easeInOut");
        else p.value = val;
      }
    });
  }

  removeEffect(layerId: string, effectId: string, source: ChangeSource = "user") {
    return this.mutateLayer(layerId, "Supprimer un effet", source, (layer) => {
      const before = layer.effects.length;
      layer.effects = layer.effects.filter((e) => e.id !== effectId && e.type !== effectId);
      if (layer.effects.length === before) throw new EngineError("Effet introuvable.", "not_found");
    });
  }

  moveEffect(layerId: string, effectId: string, newIndex: number, source: ChangeSource = "user") {
    return this.mutateLayer(layerId, "Réordonner les effets", source, (layer) => {
      const i = layer.effects.findIndex((e) => e.id === effectId);
      if (i < 0) throw new EngineError("Effet introuvable.", "not_found");
      const [fx] = layer.effects.splice(i, 1);
      layer.effects.splice(Math.max(0, Math.min(layer.effects.length, newIndex)), 0, fx);
    });
  }

  // ---------------------------------------------------------------- masques

  addMask(layerId: string, m: Partial<Omit<Mask, "id" | "feather" | "opacity">> & { feather?: number; opacity?: number } = {}, source: ChangeSource = "user"): Mask {
    const { layer } = this.findLayer(layerId);
    const w = (layer.props.width?.value as number) || 400;
    const h = (layer.props.height?.value as number) || 400;
    const mask: Mask = {
      id: uid("mask"),
      name: m.name ?? `Masque ${layer.masks.length + 1}`,
      shape: m.shape ?? "rectangle",
      x: m.x ?? -w / 4,
      y: m.y ?? -h / 4,
      width: m.width ?? w / 2,
      height: m.height ?? h / 2,
      points: m.points,
      mode: m.mode ?? "add",
      inverted: m.inverted ?? false,
      feather: { value: m.feather ?? 0 },
      opacity: { value: m.opacity ?? 100 },
    };
    if (mask.shape === "polygon" && (!mask.points || mask.points.length < 3)) throw new EngineError("Un masque polygone nécessite au moins 3 points.");
    this.mutateLayer(layerId, `Ajouter un masque sur « ${layer.name} »`, source, (l) => void l.masks.push(mask as any));
    return mask;
  }

  updateMask(layerId: string, maskId: string, patch: Partial<Omit<Mask, "id" | "feather" | "opacity">> & { feather?: number; opacity?: number }, source: ChangeSource = "user") {
    return this.mutateLayer(layerId, "Modifier un masque", source, (layer) => {
      const m = layer.masks.find((x) => x.id === maskId);
      if (!m) throw new EngineError("Masque introuvable.", "not_found");
      const { feather, opacity, ...rest } = patch;
      Object.assign(m, rest);
      if (feather !== undefined) m.feather.value = assertFinite(feather, "feather");
      if (opacity !== undefined) m.opacity.value = assertFinite(opacity, "opacity");
    });
  }

  removeMask(layerId: string, maskId: string, source: ChangeSource = "user") {
    return this.mutateLayer(layerId, "Supprimer un masque", source, (layer) => {
      layer.masks = layer.masks.filter((m) => m.id !== maskId);
    });
  }

  // ---------------------------------------------------------------- timeline

  /** Déplace un calque dans le temps, keyframes comprises. */
  shiftLayer(layerId: string, delta: number, source: ChangeSource = "user") {
    assertFinite(delta, "delta");
    const { layer: cur } = this.findLayer(layerId);
    const d = Math.max(-cur.inPoint, delta);
    return this.mutateLayer(layerId, `Déplacer « ${cur.name} » dans le temps`, source, (layer) => {
      layer.inPoint += d;
      layer.outPoint += d;
      for (const p of allProps(layer)) for (const k of p.keyframes ?? []) k.time += d;
    });
  }

  /** Découpe un calque en deux au temps donné. Renvoie l'id du nouveau calque (partie droite). */
  splitLayer(layerId: string, time: number, source: ChangeSource = "user"): Layer {
    const { comp, layer, index } = this.findLayer(layerId);
    if (time <= layer.inPoint + 1e-4 || time >= layer.outPoint - 1e-4) {
      throw new EngineError(`Le temps de découpe (${round(time, 3)}s) doit être strictement entre ${round(layer.inPoint, 3)}s et ${round(layer.outPoint, 3)}s.`);
    }
    const right = deepClone(layer);
    right.id = uid("layer");
    right.name = layer.name.replace(/( \(\d+\))?$/, "") + " (2)";
    right.inPoint = time;
    right.transitionIn = null;
    if (right.props.mediaOffset !== undefined) right.props.mediaOffset = (layer.props.mediaOffset ?? 0) + (time - layer.inPoint) * (layer.props.playbackRate ?? 1);
    for (const fx of right.effects) fx.id = uid("fx");
    for (const m of right.masks) m.id = uid("mask");
    for (const p of allProps(right as Draft<Layer>)) for (const k of p.keyframes ?? []) k.id = uid("kf");
    this.store.transact(
      `Découper « ${layer.name} » à ${round(time, 2)}s`,
      (d) => {
        const dc = d.compositions.find((c) => c.id === comp.id)!;
        const left = dc.layers.find((l) => l.id === layer.id)!;
        left.outPoint = time;
        left.transitionOut = null;
        dc.layers.splice(index + 1, 0, right as any);
      },
      source,
    );
    return right;
  }

  /**
   * Fusionne deux clips contigus issus d'une même source (typiquement après une découpe)
   * en un seul calque. Les deux calques doivent être de même type et se toucher.
   */
  mergeLayers(firstId: string, secondId: string, source: ChangeSource = "user"): Layer {
    let a = this.findLayer(firstId);
    let b = this.findLayer(secondId);
    if (a.comp.id !== b.comp.id) throw new EngineError("Les calques doivent être dans la même composition.");
    if (b.layer.inPoint < a.layer.inPoint) [a, b] = [b, a];
    if (a.layer.type !== b.layer.type) throw new EngineError("Seuls des calques du même type peuvent être fusionnés.");
    if (Math.abs(a.layer.outPoint - b.layer.inPoint) > 1 / a.comp.fps + 1e-6) throw new EngineError("Les clips doivent être contigus (fin du premier = début du second).");
    if (a.layer.props.assetId !== b.layer.props.assetId) throw new EngineError("Les clips doivent provenir du même média.");
    if (a.layer.props.assetId) {
      const expected = (a.layer.props.mediaOffset ?? 0) + (b.layer.inPoint - a.layer.inPoint) * (a.layer.props.playbackRate ?? 1);
      if (Math.abs(expected - (b.layer.props.mediaOffset ?? 0)) > 0.05) throw new EngineError("Les clips ne sont pas continus dans le média source : la fusion produirait un saut.");
    }
    this.store.transact(
      `Fusionner « ${a.layer.name} » et « ${b.layer.name} »`,
      (d) => {
        const dc = d.compositions.find((c) => c.id === a.comp.id)!;
        const left = dc.layers.find((l) => l.id === a.layer.id)!;
        left.outPoint = b.layer.outPoint;
        left.transitionOut = b.layer.transitionOut ?? null;
        left.name = left.name.replace(/ \(\d+\)$/, "");
        dc.layers = dc.layers.filter((l) => l.id !== b.layer.id);
      },
      source,
    );
    return this.findLayer(a.layer.id).layer;
  }

  /** Regroupe des calques dans une nouvelle composition imbriquée (pré-composition). */
  precompose(layerIds: string[], name = "Pré-composition", source: ChangeSource = "user") {
    if (!layerIds.length) throw new EngineError("Aucun calque à pré-composer.");
    const comp = this.comp();
    const found = layerIds.map((id) => this.findLayer(id, comp.id));
    const sorted = found.sort((x, y) => x.index - y.index);
    const sub = createComposition({ name, width: comp.width, height: comp.height, fps: comp.fps, duration: comp.duration, background: "#00000000" });
    sub.layers = sorted.map((f) => deepClone(f.layer));
    const ids = new Set(sorted.map((f) => f.layer.id));
    for (const l of sub.layers) if (l.parentId && !ids.has(l.parentId)) l.parentId = null;
    const holder = createLayer("composition", comp, { name, inPoint: Math.min(...sorted.map((f) => f.layer.inPoint)), outPoint: Math.max(...sorted.map((f) => f.layer.outPoint)) });
    holder.props.compositionId = sub.id;
    const insertAt = sorted[0].index;
    this.store.transact(
      `Pré-composer ${layerIds.length} calque(s)`,
      (d) => {
        d.compositions.push(sub as any);
        const dc = d.compositions.find((c) => c.id === comp.id)!;
        dc.layers = dc.layers.filter((l) => !ids.has(l.id));
        for (const l of dc.layers) if (l.parentId && ids.has(l.parentId)) l.parentId = null;
        dc.layers.splice(Math.min(insertAt, dc.layers.length), 0, holder as any);
      },
      source,
    );
    return { composition: sub, layer: holder };
  }

  /**
   * Ajoute des transitions entre des clips successifs : transition de sortie sur chaque clip
   * et d'entrée sur le suivant. Si `overlap` est vrai, les clips suivants sont avancés pour
   * se chevaucher (fondu enchaîné réel).
   */
  addTransitionsBetweenClips(opts: { layerIds?: string[]; type?: Transition["type"]; duration?: number; overlap?: boolean } = {}, source: ChangeSource = "user") {
    const comp = this.comp();
    const type = opts.type ?? "fade";
    const duration = opts.duration ?? 0.5;
    this.checkTransition({ type, duration });
    let clips = opts.layerIds?.length ? opts.layerIds.map((id) => this.findLayer(id, comp.id).layer) : comp.layers.filter((l) => ["video", "image", "composition"].includes(l.type));
    clips = [...clips].sort((a, b) => a.inPoint - b.inPoint);
    if (clips.length < 2) throw new EngineError("Il faut au moins deux clips (vidéo, image ou composition) pour ajouter des transitions.");
    const pairs: string[] = [];
    this.store.transact(
      `Transitions « ${type} » entre ${clips.length} clips`,
      (d) => {
        const dc = d.compositions.find((c) => c.id === comp.id)!;
        let shift = 0;
        for (let i = 0; i < clips.length; i++) {
          const l = dc.layers.find((x) => x.id === clips[i].id)!;
          if (opts.overlap && i > 0 && shift !== 0) {
            l.inPoint += shift;
            l.outPoint += shift;
            for (const p of allProps(l)) for (const k of p.keyframes ?? []) k.time += shift;
          }
          if (i > 0) l.transitionIn = { type, duration };
          if (i < clips.length - 1) {
            l.transitionOut = opts.overlap ? null : { type: type === "fade" ? "fade" : type, duration };
            if (opts.overlap) shift -= duration;
            pairs.push(`${clips[i].name} → ${clips[i + 1].name}`);
          }
        }
        if (opts.overlap) {
          // Les clips du dessus doivent être les suivants pour un vrai fondu enchaîné.
          const order = clips.map((c) => dc.layers.findIndex((x) => x.id === c.id));
          const sortedIdx = [...order].sort((a, b) => a - b);
          const moved = clips.map((c) => dc.layers.find((x) => x.id === c.id)!);
          sortedIdx.forEach((slot, i) => (dc.layers[slot] = moved[i]));
        }
      },
      source,
    );
    return { type, duration, pairs };
  }

  /**
   * Optimise les animations : supprime les keyframes redondantes (valeurs identiques
   * consécutives), les doublons temporels, arrondit les valeurs et enlève les effets
   * neutres. Ne modifie pas le rendu visible (sauf arrondis < 0,0001).
   */
  optimizeAnimations(compId?: string, source: ChangeSource = "user") {
    const comp = this.comp(compId);
    const report = { keyframesRemoved: 0, propertiesSimplified: 0, neutralEffectsRemoved: 0, layersOutsideRangeTrimmed: 0 };
    this.store.transact(
      "Optimiser les animations",
      (d) => {
        const dc = d.compositions.find((c) => c.id === comp.id)!;
        for (const layer of dc.layers) {
          if (layer.outPoint > dc.duration) {
            layer.outPoint = dc.duration;
            if (layer.inPoint >= layer.outPoint) layer.inPoint = Math.max(0, layer.outPoint - 1 / dc.fps);
            report.layersOutsideRangeTrimmed++;
          }
          for (const p of allProps(layer)) {
            const kfs = p.keyframes;
            if (!kfs || !kfs.length) continue;
            const before = kfs.length;
            kfs.sort((a, b) => a.time - b.time);
            // Doublons temporels
            for (let i = kfs.length - 1; i > 0; i--) if (Math.abs(kfs[i].time - kfs[i - 1].time) < 1e-4) kfs.splice(i - 1, 1);
            for (const k of kfs) if (typeof k.value === "number") k.value = round(k.value, 4);
            // Keyframes intermédiaires identiques à leurs voisines
            for (let i = kfs.length - 2; i > 0; i--) {
              if (kfs[i].value === kfs[i - 1].value && kfs[i].value === kfs[i + 1].value) kfs.splice(i, 1);
            }
            // Toutes identiques → valeur statique
            if (kfs.every((k) => k.value === kfs[0].value)) {
              p.value = kfs[0].value;
              delete p.keyframes;
              report.propertiesSimplified++;
              report.keyframesRemoved += before;
              continue;
            }
            report.keyframesRemoved += before - kfs.length;
          }
          const neutral = (fx: Draft<Layer["effects"][number]>) => {
            const anim = Object.values(fx.params).some((p) => p.keyframes?.length);
            if (anim) return false;
            const v = (k: string) => fx.params[k]?.value;
            switch (fx.type) {
              case "gaussianBlur":
                return v("radius") === 0;
              case "glow":
                return v("intensity") === 0;
              case "brightnessContrast":
                return v("brightness") === 1 && v("contrast") === 1;
              case "hueSaturation":
                return v("hue") === 0 && v("saturation") === 1;
              case "shake":
                return v("amplitude") === 0 && v("rotation") === 0;
              default:
                return false;
            }
          };
          const n = layer.effects.length;
          layer.effects = layer.effects.filter((fx) => !neutral(fx));
          report.neutralEffectsRemoved += n - layer.effects.length;
        }
      },
      source,
    );
    return report;
  }

  // ---------------------------------------------------------------- historique

  undo() {
    return this.store.undo();
  }
  redo() {
    return this.store.redo();
  }
}
