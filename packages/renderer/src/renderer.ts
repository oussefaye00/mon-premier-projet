import {
  evaluate,
  evaluateTransform,
  getEffectDef,
  lerpColor,
  mulberry32,
  smoothNoise,
  toCssColor,
  type Composition,
  type Layer,
  type Mask,
  type Project,
} from "@amai/core";
import { clearCanvas, hasPixelRenderer, runEffect, supportsCanvasFilter, type AnyCanvas, type Canvas2D } from "./effects";
import { apply, IDENTITY, invert, meanScale, mul, rotate, scale, translate, type Mat } from "./matrix";

/** Fournit les images des médias. Doit être synchrone : la préparation (seek vidéo…) est faite en amont. */
export interface MediaSource {
  getImage(assetId: string): CanvasImageSource | null;
  getVideoFrame(assetId: string, mediaTime: number, layerId: string): CanvasImageSource | null;
}

export interface RenderOptions {
  /** Pixels de sortie par pixel de composition (1 = pleine résolution). */
  scale: number;
  motionBlur?: boolean;
  /** Dessiner le fond de la composition. */
  background?: boolean;
}

export interface MediaRequest {
  layerId: string;
  assetId: string;
  kind: "video" | "audio" | "image";
  mediaTime: number;
  rate: number;
}

type CanvasFactory = (w: number, h: number) => AnyCanvas;

export const defaultCanvasFactory: CanvasFactory = (w, h) => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
};

const BLEND: Record<string, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  add: "lighter",
  difference: "difference",
};

/** Temps dans le média source pour un calque vidéo/audio au temps de composition `time`. */
export function mediaTimeFor(layer: Layer, time: number): number {
  return (layer.props.mediaOffset ?? 0) + (time - layer.inPoint) * (layer.props.playbackRate ?? 1);
}

/** Liste récursive des médias nécessaires pour rendre une image (préchargement / seek). */
export function collectMediaRequests(project: Project, compId: string, time: number, depth = 0, out: MediaRequest[] = []): MediaRequest[] {
  const comp = project.compositions.find((c) => c.id === compId);
  if (!comp || depth > 8) return out;
  for (const l of comp.layers) {
    if (!l.visible || time < l.inPoint || time >= l.outPoint) continue;
    if ((l.type === "video" || l.type === "audio") && l.props.assetId) {
      out.push({ layerId: l.id, assetId: l.props.assetId, kind: l.type, mediaTime: mediaTimeFor(l, time), rate: l.props.playbackRate ?? 1 });
    } else if (l.type === "image" && l.props.assetId) {
      out.push({ layerId: l.id, assetId: l.props.assetId, kind: "image", mediaTime: 0, rate: 1 });
    } else if (l.type === "composition" && l.props.compositionId) {
      collectMediaRequests(project, l.props.compositionId, time - l.inPoint, depth + 1, out);
    }
  }
  return out;
}

interface LayerFrame {
  matrix: Mat;
  opacity: number;
  extraBlur: number;
  wipe: number | null;
}

/**
 * Moteur de rendu 2D. Indépendant de l'UI : utilisé pour la prévisualisation, les
 * vignettes, l'aperçu MCP et l'export vidéo image par image.
 */
export class Renderer {
  private pool: AnyCanvas[] = [];
  private inUse = new Set<AnyCanvas>();
  private pathLengthCache = new Map<string, number>();
  /** Mesure optionnelle de longueur de tracé SVG (fournie par le navigateur). */
  measurePath?: (d: string) => number;

  constructor(private createCanvas: CanvasFactory = defaultCanvasFactory) {}

  private acquire(w: number, h: number): AnyCanvas {
    let c = this.pool.find((x) => !this.inUse.has(x) && x.width === w && x.height === h);
    if (!c) {
      c = this.pool.find((x) => !this.inUse.has(x));
      if (c) {
        c.width = w;
        c.height = h;
      } else {
        c = this.createCanvas(w, h);
        this.pool.push(c);
      }
    }
    this.inUse.add(c);
    const ctx = c.getContext("2d") as Canvas2D;
    clearCanvas(ctx, c);
    return c;
  }

  private release(c: AnyCanvas) {
    this.inUse.delete(c);
  }

  /** Libère la mémoire des canvas intermédiaires (appareils modestes, changement de résolution). */
  trimPool(keep = 4) {
    const free = this.pool.filter((c) => !this.inUse.has(c));
    for (const c of free.slice(keep)) {
      c.width = 1;
      c.height = 1;
      this.pool.splice(this.pool.indexOf(c), 1);
    }
  }

  /**
   * Rend la composition au temps `time` dans `ctx` (dont le canvas doit mesurer
   * comp.width*scale × comp.height*scale).
   */
  render(ctx: Canvas2D, project: Project, compId: string, time: number, media: MediaSource, opts: RenderOptions, depth = 0) {
    const comp = project.compositions.find((c) => c.id === compId);
    if (!comp) return;
    const s = opts.scale;
    const W = Math.max(1, Math.round(comp.width * s));
    const H = Math.max(1, Math.round(comp.height * s));
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    if (opts.background !== false) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = toCssColor(comp.background);
      ctx.fillRect(0, 0, W, H);
    }
    const cam = this.cameraMatrix(comp, time);
    const view = mul(scale(s, s), cam);
    const anySolo = comp.layers.some((l) => l.solo && l.visible);
    for (const layer of comp.layers) {
      if (!layer.visible || layer.type === "camera" || layer.type === "null" || layer.type === "audio") continue;
      if (anySolo && !layer.solo) continue;
      if (time < layer.inPoint || time >= layer.outPoint) continue;
      this.renderLayer(ctx, project, comp, layer, time, media, opts, view, W, H, depth);
    }
    ctx.restore();
  }

  private cameraMatrix(comp: Composition, time: number): Mat {
    // Caméra active la plus haute dans la pile.
    for (let i = comp.layers.length - 1; i >= 0; i--) {
      const l = comp.layers[i];
      if (l.type !== "camera" || !l.visible || time < l.inPoint || time >= l.outPoint) continue;
      const t = evaluateTransform(l.transform, time);
      const shake = this.shakeOffset(l, time);
      const zoom = evaluate(l.props.zoom, time, 100) / 100;
      const cx = comp.width / 2;
      const cy = comp.height / 2;
      // Vue = translation au centre · zoom · rotation inverse · translation inverse du point visé
      return mul(
        mul(mul(translate(cx, cy), scale(zoom, zoom)), rotate(-(t.rotation + shake.rot))),
        translate(-(t.positionX + shake.x), -(t.positionY + shake.y)),
      );
    }
    return [...IDENTITY];
  }

  private shakeOffset(layer: Layer, time: number) {
    let x = 0;
    let y = 0;
    let rot = 0;
    for (const fx of layer.effects) {
      if (fx.type !== "shake" || !fx.enabled) continue;
      const amp = evaluate(fx.params.amplitude, time) as number;
      const freq = evaluate(fx.params.frequency, time) as number;
      const r = evaluate(fx.params.rotation, time) as number;
      const seed = [...fx.id].reduce((a, c) => a + c.charCodeAt(0), 0);
      x += smoothNoise(seed, time * freq) * amp;
      y += smoothNoise(seed + 17, time * freq) * amp;
      rot += smoothNoise(seed + 41, time * freq) * r;
    }
    return { x, y, rot };
  }

  /** Matrice locale→composition d'un calque (parents compris, sans caméra). */
  layerMatrix(comp: Composition, layer: Layer, time: number, depth = 0): Mat {
    const t = evaluateTransform(layer.transform, time);
    const sh = this.shakeOffset(layer, time);
    let m = mul(
      mul(mul(translate(t.positionX + sh.x, t.positionY + sh.y), rotate(t.rotation + sh.rot)), scale(t.scaleX / 100, t.scaleY / 100)),
      translate(-t.anchorX, -t.anchorY),
    );
    if (layer.parentId && depth < 32) {
      const parent = comp.layers.find((l) => l.id === layer.parentId);
      if (parent) m = mul(this.layerMatrix(comp, parent, time, depth + 1), m);
    }
    return m;
  }

  /** Matrice complète (caméra comprise) dans l'espace composition. */
  layerViewMatrix(comp: Composition, layer: Layer, time: number): Mat {
    return mul(this.cameraMatrix(comp, time), this.layerMatrix(comp, layer, time));
  }

  /** Transitions d'entrée/sortie → modificateurs (opacité, décalage, échelle, flou, volet). */
  private transitionFrame(comp: Composition, layer: Layer, time: number): { opacity: number; dx: number; dy: number; sc: number; blur: number; wipe: number | null } {
    const out = { opacity: 1, dx: 0, dy: 0, sc: 1, blur: 0, wipe: null as number | null };
    const applyT = (type: string, p: number, entering: boolean) => {
      // p : 0 = invisible, 1 = complètement présent
      const e = entering ? 1 - Math.pow(1 - p, 3) : p * p * p;
      const inv = 1 - e;
      switch (type) {
        case "fade":
          out.opacity *= e;
          break;
        case "slide-left":
          out.dx += (entering ? 1 : -1) * comp.width * inv;
          break;
        case "slide-right":
          out.dx += (entering ? -1 : 1) * comp.width * inv;
          break;
        case "slide-up":
          out.dy += (entering ? 1 : -1) * comp.height * inv;
          break;
        case "slide-down":
          out.dy += (entering ? -1 : 1) * comp.height * inv;
          break;
        case "zoom":
          out.sc *= entering ? 0.6 + 0.4 * e : 1 + 0.4 * inv;
          out.opacity *= e;
          break;
        case "blur":
          out.blur += 40 * inv;
          out.opacity *= Math.min(1, e * 1.5);
          break;
        case "wipe":
          out.wipe = Math.min(out.wipe ?? 1, e);
          break;
      }
    };
    if (layer.transitionIn && layer.transitionIn.duration > 0) {
      const p = (time - layer.inPoint) / layer.transitionIn.duration;
      if (p < 1) applyT(layer.transitionIn.type, Math.max(0, p), true);
    }
    if (layer.transitionOut && layer.transitionOut.duration > 0) {
      const p = (layer.outPoint - time) / layer.transitionOut.duration;
      if (p < 1) applyT(layer.transitionOut.type, Math.max(0, p), false);
    }
    return out;
  }

  private frameFor(comp: Composition, layer: Layer, time: number, view: Mat): LayerFrame {
    const tr = this.transitionFrame(comp, layer, time);
    let m = this.layerMatrix(comp, layer, time);
    if (tr.dx || tr.dy || tr.sc !== 1) {
      const cx = comp.width / 2;
      const cy = comp.height / 2;
      m = mul(mul(mul(translate(cx + tr.dx, cy + tr.dy), scale(tr.sc, tr.sc)), translate(-cx, -cy)), m);
    }
    const opacity = Math.max(0, Math.min(1, (evaluate(layer.transform.opacity, time) / 100) * tr.opacity));
    return { matrix: mul(view, m), opacity, extraBlur: tr.blur, wipe: tr.wipe };
  }

  private renderLayer(ctx: Canvas2D, project: Project, comp: Composition, layer: Layer, time: number, media: MediaSource, opts: RenderOptions, view: Mat, W: number, H: number, depth: number) {
    const frame = this.frameFor(comp, layer, time, view);
    if (frame.opacity <= 0.0005) return;
    const pixelFx = layer.effects.filter((f) => f.enabled && hasPixelRenderer(f.type) && getEffectDef(f.type)?.category !== "mouvement");
    const motionBlur = !!(opts.motionBlur && layer.motionBlur);
    const needsOffscreen = pixelFx.length > 0 || layer.masks.length > 0 || motionBlur || frame.extraBlur > 0 || frame.wipe !== null;
    const blend = BLEND[layer.blendMode] ?? "source-over";

    if (!needsOffscreen) {
      ctx.save();
      ctx.globalAlpha = frame.opacity;
      ctx.globalCompositeOperation = blend;
      this.drawContent(ctx, project, comp, layer, time, media, opts, frame.matrix, W, H, depth);
      ctx.restore();
      return;
    }

    const layerCanvas = this.acquire(W, H);
    const lctx = layerCanvas.getContext("2d") as Canvas2D;
    if (motionBlur) {
      const samples = Math.max(2, Math.min(32, comp.motionBlurSamples ?? 8));
      const shutter = (comp.shutterAngle ?? 180) / 360 / comp.fps;
      const sample = this.acquire(W, H);
      const sctx = sample.getContext("2d") as Canvas2D;
      lctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < samples; i++) {
        const st = time + (i / (samples - 1) - 0.5) * shutter;
        clearCanvas(sctx, sample);
        const f = this.frameFor(comp, layer, st, view);
        this.drawContent(sctx, project, comp, layer, st, media, opts, f.matrix, W, H, depth);
        // Accumulation additive pondérée = moyenne exacte en espace prémultiplié.
        lctx.globalAlpha = 1 / samples;
        lctx.drawImage(sample as CanvasImageSource, 0, 0);
      }
      lctx.globalAlpha = 1;
      lctx.globalCompositeOperation = "source-over";
      this.release(sample);
    } else {
      this.drawContent(lctx, project, comp, layer, time, media, opts, frame.matrix, W, H, depth);
    }

    if (pixelFx.length || frame.extraBlur > 0) {
      const tmp = this.acquire(W, H);
      const tmpCtx = tmp.getContext("2d") as Canvas2D;
      for (const fx of pixelFx) {
        clearCanvas(tmpCtx, tmp);
        runEffect(fx, { ctx: lctx, canvas: layerCanvas, tmp, tmpCtx, pxScale: opts.scale, time });
      }
      if (frame.extraBlur > 0 && supportsCanvasFilter) {
        clearCanvas(tmpCtx, tmp);
        tmpCtx.filter = `blur(${(frame.extraBlur * opts.scale).toFixed(2)}px)`;
        tmpCtx.drawImage(layerCanvas as CanvasImageSource, 0, 0);
        tmpCtx.filter = "none";
        clearCanvas(lctx, layerCanvas);
        lctx.drawImage(tmp as CanvasImageSource, 0, 0);
      }
      this.release(tmp);
    }

    if (layer.masks.length) this.applyMasks(lctx, layerCanvas, layer.masks, frame.matrix, time, opts.scale, W, H);

    if (frame.wipe !== null) {
      lctx.setTransform(1, 0, 0, 1, 0, 0);
      lctx.globalCompositeOperation = "destination-in";
      lctx.fillStyle = "#000";
      lctx.fillRect(0, 0, W * frame.wipe, H);
      lctx.globalCompositeOperation = "source-over";
    }

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = frame.opacity;
    ctx.globalCompositeOperation = blend;
    ctx.drawImage(layerCanvas as CanvasImageSource, 0, 0);
    ctx.restore();
    this.release(layerCanvas);
  }

  private maskPath(m: Mask): Path2D {
    const p = new Path2D();
    if (m.shape === "ellipse") {
      p.ellipse(m.x + m.width / 2, m.y + m.height / 2, Math.abs(m.width / 2), Math.abs(m.height / 2), 0, 0, Math.PI * 2);
    } else if (m.shape === "polygon" && m.points && m.points.length >= 3) {
      p.moveTo(m.points[0].x, m.points[0].y);
      for (const pt of m.points.slice(1)) p.lineTo(pt.x, pt.y);
      p.closePath();
    } else {
      p.rect(m.x, m.y, m.width, m.height);
    }
    return p;
  }

  private applyMasks(lctx: Canvas2D, layerCanvas: AnyCanvas, masks: Mask[], matrix: Mat, time: number, s: number, W: number, H: number) {
    const mc = this.acquire(W, H);
    const mctx = mc.getContext("2d") as Canvas2D;
    const one = this.acquire(W, H);
    const octx = one.getContext("2d") as Canvas2D;
    if (masks[0].mode === "subtract") {
      mctx.fillStyle = "#fff";
      mctx.fillRect(0, 0, W, H);
    }
    for (const m of masks) {
      clearCanvas(octx, one);
      const feather = (evaluate(m.feather, time) as number) * s;
      const alpha = Math.max(0, Math.min(1, (evaluate(m.opacity, time) as number) / 100));
      if (supportsCanvasFilter && feather > 0.05) octx.filter = `blur(${(feather / 2).toFixed(2)}px)`;
      octx.setTransform(...matrix);
      octx.fillStyle = "#fff";
      if (m.inverted) {
        const inv = invert(matrix);
        const corners = [apply(inv, -W, -H), apply(inv, 2 * W, -H), apply(inv, 2 * W, 2 * H), apply(inv, -W, 2 * H)];
        const p = new Path2D();
        p.moveTo(...corners[0]);
        for (const c of corners.slice(1)) p.lineTo(...c);
        p.closePath();
        p.addPath(this.maskPath(m));
        octx.fill(p, "evenodd");
      } else {
        octx.fill(this.maskPath(m));
      }
      octx.filter = "none";
      octx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.globalAlpha = alpha;
      mctx.globalCompositeOperation = m.mode === "subtract" ? "destination-out" : m.mode === "intersect" ? "destination-in" : "source-over";
      mctx.drawImage(one as CanvasImageSource, 0, 0);
    }
    mctx.globalAlpha = 1;
    mctx.globalCompositeOperation = "source-over";
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.globalCompositeOperation = "destination-in";
    lctx.drawImage(mc as CanvasImageSource, 0, 0);
    lctx.globalCompositeOperation = "source-over";
    this.release(one);
    this.release(mc);
  }

  private drawContent(ctx: Canvas2D, project: Project, comp: Composition, layer: Layer, time: number, media: MediaSource, opts: RenderOptions, m: Mat, W: number, H: number, depth: number) {
    ctx.save();
    ctx.setTransform(...m);
    const p = layer.props;
    switch (layer.type) {
      case "solid": {
        const w = evaluate(p.width, time, comp.width);
        const h = evaluate(p.height, time, comp.height);
        ctx.fillStyle = toCssColor(evaluate(p.fill, time, "#808080"));
        ctx.fillRect(-w / 2, -h / 2, w, h);
        break;
      }
      case "shape":
        this.drawShape(ctx, layer, time, meanScale(m));
        break;
      case "text":
        this.drawText(ctx, layer, time);
        break;
      case "image": {
        const img = p.assetId ? media.getImage(p.assetId) : null;
        if (img) this.drawMedia(ctx, img, layer, time);
        break;
      }
      case "video": {
        const frame = p.assetId ? media.getVideoFrame(p.assetId, mediaTimeFor(layer, time), layer.id) : null;
        if (frame) this.drawMedia(ctx, frame, layer, time);
        break;
      }
      case "particles":
        ctx.restore();
        ctx.save();
        this.drawParticles(ctx, comp, layer, time, m);
        break;
      case "composition": {
        const sub = project.compositions.find((c) => c.id === p.compositionId);
        if (sub && depth < 8) {
          const sw = Math.max(1, Math.round(sub.width * opts.scale));
          const sh = Math.max(1, Math.round(sub.height * opts.scale));
          const c = this.acquire(sw, sh);
          const cctx = c.getContext("2d") as Canvas2D;
          this.render(cctx, project, sub.id, time - layer.inPoint, media, opts, depth + 1);
          ctx.drawImage(c as CanvasImageSource, -sub.width / 2, -sub.height / 2, sub.width, sub.height);
          this.release(c);
        }
        break;
      }
    }
    ctx.restore();
  }

  private drawMedia(ctx: Canvas2D, src: CanvasImageSource, layer: Layer, time: number) {
    const anySrc = src as any;
    const nw = anySrc.videoWidth || anySrc.naturalWidth || anySrc.displayWidth || anySrc.width || 0;
    const nh = anySrc.videoHeight || anySrc.naturalHeight || anySrc.displayHeight || anySrc.height || 0;
    const w = (evaluate(layer.props.width, time, 0) as number) || nw;
    const h = (evaluate(layer.props.height, time, 0) as number) || nh;
    if (!w || !h) return;
    try {
      ctx.drawImage(src, -w / 2, -h / 2, w, h);
    } catch {
      /* image pas encore décodée */
    }
  }

  private shapePath(layer: Layer, time: number): { path: Path2D; length: number } {
    const p = layer.props;
    const w = evaluate(p.width, time, 100) as number;
    const h = evaluate(p.height, time, 100) as number;
    const path = new Path2D();
    let length = 0;
    switch (p.shapeKind ?? "rectangle") {
      case "rectangle": {
        const r = Math.max(0, Math.min(evaluate(p.cornerRadius, time, 0) as number, Math.abs(w) / 2, Math.abs(h) / 2));
        if (r > 0 && (path as any).roundRect) (path as any).roundRect(-w / 2, -h / 2, w, h, r);
        else path.rect(-w / 2, -h / 2, w, h);
        length = 2 * (Math.abs(w) + Math.abs(h)) - r * (8 - 2 * Math.PI);
        break;
      }
      case "ellipse": {
        const a = Math.abs(w / 2);
        const b = Math.abs(h / 2);
        // Départ en haut, sens horaire (comme les tracés d'After Effects) pour les animations de trim.
        path.ellipse(0, 0, a, b, 0, -Math.PI / 2, Math.PI * 1.5);
        length = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
        break;
      }
      case "polygon":
      case "star": {
        const n = Math.max(3, Math.round(p.sides ?? 5));
        const star = p.shapeKind === "star";
        const inner = evaluate(p.innerRatio, time, 0.45) as number;
        const pts: [number, number][] = [];
        const count = star ? n * 2 : n;
        for (let i = 0; i < count; i++) {
          const a = -Math.PI / 2 + (i * Math.PI * 2) / count;
          const rr = star && i % 2 === 1 ? inner : 1;
          pts.push([(Math.cos(a) * w * rr) / 2, (Math.sin(a) * h * rr) / 2]);
        }
        path.moveTo(...pts[0]);
        for (const pt of pts.slice(1)) path.lineTo(...pt);
        path.closePath();
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[(i + 1) % pts.length];
          length += Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        break;
      }
      case "path": {
        const d = p.pathData ?? "";
        try {
          path.addPath(new Path2D(d));
        } catch {
          /* tracé invalide */
        }
        let len = this.pathLengthCache.get(d);
        if (len === undefined) {
          len = this.measurePath ? this.measurePath(d) : 0;
          this.pathLengthCache.set(d, len);
        }
        length = len;
        break;
      }
    }
    return { path, length };
  }

  private drawShape(ctx: Canvas2D, layer: Layer, time: number, _scale: number) {
    const p = layer.props;
    const { path, length } = this.shapePath(layer, time);
    if (p.fillEnabled !== false) {
      ctx.fillStyle = toCssColor(evaluate(p.fill, time, "#ffffff"));
      ctx.fill(path);
    }
    const sw = evaluate(p.strokeWidth, time, 0) as number;
    if (p.strokeEnabled && sw > 0) {
      ctx.strokeStyle = toCssColor(evaluate(p.stroke, time, "#ffffff"));
      ctx.lineWidth = sw;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      const ts = Math.max(0, Math.min(100, evaluate(p.trimStart, time, 0) as number)) / 100;
      const te = Math.max(0, Math.min(100, evaluate(p.trimEnd, time, 100) as number)) / 100;
      if ((ts > 0 || te < 1) && length > 0) {
        const visible = Math.max(0, te - ts) * length;
        if (visible <= 0.01) return;
        ctx.setLineDash([visible, length + 1]);
        ctx.lineDashOffset = -ts * length;
      }
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
  }

  /** Police CSS d'un calque texte. */
  static font(layer: Layer, time: number) {
    const p = layer.props;
    const size = evaluate(p.fontSize, time, 64) as number;
    return { css: `${p.italic ? "italic " : ""}${p.fontWeight ?? 400} ${size}px ${p.fontFamily ?? "sans-serif"}`, size };
  }

  /** Mise en page du texte (lignes + positions de caractères), en coordonnées locales centrées. */
  layoutText(ctx: Canvas2D, layer: Layer, time: number) {
    const p = layer.props;
    const { css, size } = Renderer.font(layer, time);
    ctx.font = css;
    const spacing = evaluate(p.letterSpacing, time, 0) as number;
    const lineH = size * (p.lineHeight ?? 1.2);
    const lines = (p.text ?? "").split("\n");
    const chars: { ch: string; x: number; y: number; w: number; index: number }[] = [];
    let index = 0;
    let maxW = 0;
    const widths = lines.map((line) => {
      let w = 0;
      for (const ch of line) w += ctx.measureText(ch).width + spacing;
      if (line.length) w -= spacing;
      maxW = Math.max(maxW, w);
      return w;
    });
    const totalH = lines.length * lineH;
    lines.forEach((line, li) => {
      const w = widths[li];
      let x = p.align === "left" ? -maxW / 2 : p.align === "right" ? maxW / 2 - w : -w / 2;
      const y = -totalH / 2 + li * lineH + lineH / 2;
      for (const ch of line) {
        const cw = ctx.measureText(ch).width;
        chars.push({ ch, x, y, w: cw, index: index++ });
        x += cw + spacing;
      }
    });
    return { chars, width: maxW, height: totalH, size, css };
  }

  private drawText(ctx: Canvas2D, layer: Layer, time: number) {
    const p = layer.props;
    const layout = this.layoutText(ctx, layer, time);
    ctx.font = layout.css;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    const fill = toCssColor(evaluate(p.textColor, time, "#ffffff"));
    const sw = evaluate(p.strokeWidth, time, 0) as number;
    const stroke = sw > 0 ? toCssColor(evaluate(p.stroke, time, "#000000")) : null;
    const mode = p.textAnimator ?? "none";
    const progress = Math.max(0, Math.min(100, evaluate(p.textProgress, time, 100) as number)) / 100;
    const n = layout.chars.length;
    const spread = 4;
    for (const c of layout.chars) {
      let alpha = 1;
      let dy = 0;
      let sc = 1;
      if (mode === "typewriter") {
        if (c.index >= Math.floor(progress * n + 1e-6)) continue;
      } else if (mode !== "none") {
        const local = Math.max(0, Math.min(1, progress * (n + spread) - c.index) / spread);
        const e = 1 - Math.pow(1 - local, 3);
        if (mode === "fade") alpha = e;
        else if (mode === "slide-up") {
          alpha = e;
          dy = (1 - e) * layout.size * 0.6;
        } else if (mode === "scale") {
          alpha = Math.min(1, e * 2);
          sc = e;
        } else if (mode === "wave") {
          alpha = e;
          dy = Math.sin(time * 5 + c.index * 0.6) * layout.size * 0.12 * progress;
        }
      }
      if (alpha <= 0 || sc <= 0) continue;
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.translate(c.x + c.w / 2, c.y + dy);
      if (sc !== 1) ctx.scale(sc, sc);
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = sw;
        ctx.lineJoin = "round";
        ctx.strokeText(c.ch, -c.w / 2, 0);
      }
      ctx.fillStyle = fill;
      ctx.fillText(c.ch, -c.w / 2, 0);
      ctx.restore();
    }
  }

  /**
   * Particules déterministes : l'état de chaque particule est calculé analytiquement à
   * partir de son instant de naissance, sans simulation cumulative. Le rendu d'une
   * image donnée est donc identique en lecture, en scrubbing et à l'export.
   */
  private drawParticles(ctx: Canvas2D, comp: Composition, layer: Layer, time: number, viewMatrixNow: Mat) {
    const p = layer.props;
    const life = Math.max(0.05, p.lifetime ?? 2);
    const step = 1 / 60;
    const start = Math.max(layer.inPoint, time - life);
    const seed = p.seed ?? 1;
    // On reconstruit l'intégrale du débit depuis inPoint pour numéroter les particules.
    let emitted = 0;
    const births: { t: number; i: number }[] = [];
    for (let t = layer.inPoint; t <= time; t += step) {
      const rate = Math.max(0, evaluate(p.rate, t, 30) as number);
      const before = emitted;
      emitted += rate * step;
      if (t + step < start) continue;
      for (let k = Math.ceil(before); k < emitted; k++) {
        const bt = t + ((k - before) / Math.max(1e-6, emitted - before)) * step;
        if (bt <= time && bt >= time - life) births.push({ t: bt, i: k });
      }
      if (births.length > 4000) break;
    }
    // Matrice de vue sans le calque (caméra × échelle) : viewMatrixNow = view · layerMatrix(now)
    const view = mul(viewMatrixNow, invert(this.layerMatrix(comp, layer, time)));
    const shape = p.particleShape ?? "circle";
    const baseAlpha = ctx.globalAlpha;
    for (const b of births) {
      const rnd = mulberry32(seed * 7919 + b.i * 104729);
      const age = time - b.t;
      const k = age / life;
      const em = this.layerMatrix(comp, layer, b.t);
      const size = Math.max(0, evaluate(p.emitterSize, b.t, 100) as number);
      let ox = 0;
      let oy = 0;
      if (p.emitterShape === "line") ox = (rnd() - 0.5) * size;
      else if (p.emitterShape === "circle") {
        const a = rnd() * Math.PI * 2;
        const r = Math.sqrt(rnd()) * size * 0.5;
        ox = Math.cos(a) * r;
        oy = Math.sin(a) * r;
      }
      const [x0, y0] = apply(em, ox, oy);
      const dir = ((evaluate(p.direction, b.t, -90) as number) + (rnd() - 0.5) * (evaluate(p.spread, b.t, 60) as number)) * (Math.PI / 180);
      const spd = (evaluate(p.speed, b.t, 300) as number) * (0.6 + 0.8 * rnd());
      const g = evaluate(p.gravity, b.t, 0) as number;
      const x = x0 + Math.cos(dir) * spd * age;
      const y = y0 + Math.sin(dir) * spd * age + 0.5 * g * age * age;
      const sz = (evaluate(p.particleSize, b.t, 10) as number) * (1 - k) + (evaluate(p.particleSizeEnd, b.t, 2) as number) * k;
      const color = toCssColor(lerpColorSafe(evaluate(p.colorStart, b.t, "#ffffff"), evaluate(p.colorEnd, b.t, "#ffffff00"), k));
      const spin = (rnd() - 0.5) * 720 * age;
      ctx.setTransform(...mul(mul(view, translate(x, y)), rotate(spin)));
      ctx.fillStyle = color;
      ctx.globalAlpha = baseAlpha;
      const r = Math.max(0.1, sz / 2);
      if (shape === "square") ctx.fillRect(-r, -r, r * 2, r * 2);
      else if (shape === "spark") ctx.fillRect(-r * 2.5, -r * 0.3, r * 5, r * 0.6);
      else if (shape === "star") {
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          const rr = i % 2 ? r * 0.45 : r;
          ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr);
        }
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Boîte englobante locale d'un calque (coordonnées centrées) pour les poignées de
   * transformation et la sélection au clic.
   */
  localBounds(ctx: Canvas2D, project: Project, comp: Composition, layer: Layer, time: number, media?: MediaSource): { x: number; y: number; w: number; h: number } | null {
    const p = layer.props;
    switch (layer.type) {
      case "solid":
      case "shape": {
        const w = Math.abs(evaluate(p.width, time, 100) as number);
        const h = Math.abs(evaluate(p.height, time, 100) as number);
        return { x: -w / 2, y: -h / 2, w, h };
      }
      case "text": {
        const l = this.layoutText(ctx, layer, time);
        return { x: -l.width / 2, y: -l.height / 2, w: Math.max(l.width, 10), h: l.height };
      }
      case "image":
      case "video": {
        let w = evaluate(p.width, time, 0) as number;
        let h = evaluate(p.height, time, 0) as number;
        if ((!w || !h) && media && p.assetId) {
          const a = project.assets.find((x) => x.id === p.assetId);
          w = a?.width ?? 0;
          h = a?.height ?? 0;
        }
        return w && h ? { x: -w / 2, y: -h / 2, w, h } : null;
      }
      case "composition": {
        const sub = project.compositions.find((c) => c.id === p.compositionId);
        return sub ? { x: -sub.width / 2, y: -sub.height / 2, w: sub.width, h: sub.height } : null;
      }
      case "particles":
      case "null":
      case "camera": {
        const s = layer.type === "particles" ? Math.max(40, evaluate(p.emitterSize, time, 100) as number) : 60;
        return { x: -s / 2, y: -s / 2, w: s, h: s };
      }
      default:
        return null;
    }
  }
}

function lerpColorSafe(a: string, b: string, t: number) {
  return lerpColor(a, b, Math.max(0, Math.min(1, t)));
}
