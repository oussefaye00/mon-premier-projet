import { evaluate, toCssColor, type Effect, type PropertyValue } from "@amai/core";

export type Canvas2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

export interface EffectRenderContext {
  /** Canvas du calque (taille de sortie), à modifier en place. */
  ctx: Canvas2D;
  canvas: AnyCanvas;
  /** Canvas temporaire de même taille, libre d'utilisation. */
  tmp: AnyCanvas;
  tmpCtx: Canvas2D;
  /** Pixels de sortie par pixel de composition (résolution d'aperçu). */
  pxScale: number;
  time: number;
  params: (key: string) => PropertyValue;
}

export type EffectRenderer = (rc: EffectRenderContext) => void;

const renderers = new Map<string, EffectRenderer>();

/** Point d'extension : implémentation du rendu d'un effet déclaré dans @amai/core. */
export function registerEffectRenderer(type: string, fn: EffectRenderer) {
  renderers.set(type, fn);
}

export function hasPixelRenderer(type: string) {
  return renderers.has(type);
}

export const supportsCanvasFilter = (() => {
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const c = new OffscreenCanvas(1, 1).getContext("2d") as OffscreenCanvasRenderingContext2D;
      return typeof c.filter === "string";
    }
    if (typeof document !== "undefined") {
      const c = document.createElement("canvas").getContext("2d")!;
      return typeof c.filter === "string";
    }
  } catch {
    /* ignore */
  }
  return false;
})();

function clear(ctx: Canvas2D, c: AnyCanvas) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.filter = "none";
  ctx.shadowColor = "transparent";
  ctx.clearRect(0, 0, c.width, c.height);
}

/** Applique un filtre CSS sur le canvas du calque via le canvas temporaire. */
function filterPass(rc: EffectRenderContext, filter: string) {
  if (!supportsCanvasFilter) return;
  clear(rc.tmpCtx, rc.tmp);
  rc.tmpCtx.filter = filter;
  rc.tmpCtx.drawImage(rc.canvas as CanvasImageSource, 0, 0);
  rc.tmpCtx.filter = "none";
  clear(rc.ctx, rc.canvas);
  rc.ctx.drawImage(rc.tmp as CanvasImageSource, 0, 0);
}

const num = (rc: EffectRenderContext, k: string) => Number(rc.params(k));

registerEffectRenderer("gaussianBlur", (rc) => {
  const r = num(rc, "radius") * rc.pxScale;
  if (r > 0.05) filterPass(rc, `blur(${r.toFixed(2)}px)`);
});

registerEffectRenderer("brightnessContrast", (rc) => {
  filterPass(rc, `brightness(${num(rc, "brightness")}) contrast(${num(rc, "contrast")})`);
});

registerEffectRenderer("hueSaturation", (rc) => {
  filterPass(rc, `hue-rotate(${num(rc, "hue")}deg) saturate(${num(rc, "saturation")})`);
});

registerEffectRenderer("grayscale", (rc) => filterPass(rc, `grayscale(${num(rc, "amount")})`));
registerEffectRenderer("invert", (rc) => filterPass(rc, `invert(${num(rc, "amount")})`));

registerEffectRenderer("glow", (rc) => {
  const r = num(rc, "radius") * rc.pxScale;
  const intensity = num(rc, "intensity");
  if (intensity <= 0) return;
  clear(rc.tmpCtx, rc.tmp);
  if (supportsCanvasFilter) rc.tmpCtx.filter = `blur(${Math.max(0.1, r).toFixed(2)}px)`;
  rc.tmpCtx.drawImage(rc.canvas as CanvasImageSource, 0, 0);
  rc.tmpCtx.filter = "none";
  rc.tmpCtx.globalCompositeOperation = "source-in";
  rc.tmpCtx.fillStyle = toCssColor(String(rc.params("color")));
  rc.tmpCtx.fillRect(0, 0, rc.tmp.width, rc.tmp.height);
  rc.tmpCtx.globalCompositeOperation = "source-over";
  rc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  rc.ctx.globalCompositeOperation = "lighter";
  let remaining = intensity;
  while (remaining > 0) {
    rc.ctx.globalAlpha = Math.min(1, remaining);
    rc.ctx.drawImage(rc.tmp as CanvasImageSource, 0, 0);
    remaining -= 1;
  }
  rc.ctx.globalAlpha = 1;
  rc.ctx.globalCompositeOperation = "source-over";
});

registerEffectRenderer("dropShadow", (rc) => {
  const dist = num(rc, "distance") * rc.pxScale;
  const ang = (num(rc, "angle") * Math.PI) / 180;
  clear(rc.tmpCtx, rc.tmp);
  rc.tmpCtx.shadowColor = toCssColor(String(rc.params("color")), num(rc, "opacity"));
  rc.tmpCtx.shadowBlur = num(rc, "softness") * rc.pxScale;
  // Angle à la manière d'After Effects : 135° = ombre vers le bas-droite.
  rc.tmpCtx.shadowOffsetX = Math.sin(ang) * dist;
  rc.tmpCtx.shadowOffsetY = -Math.cos(ang) * dist;
  rc.tmpCtx.drawImage(rc.canvas as CanvasImageSource, 0, 0);
  rc.tmpCtx.shadowColor = "transparent";
  clear(rc.ctx, rc.canvas);
  rc.ctx.drawImage(rc.tmp as CanvasImageSource, 0, 0);
});

registerEffectRenderer("tint", (rc) => {
  const amount = num(rc, "amount");
  if (amount <= 0) return;
  clear(rc.tmpCtx, rc.tmp);
  if (supportsCanvasFilter) rc.tmpCtx.filter = "grayscale(1)";
  rc.tmpCtx.drawImage(rc.canvas as CanvasImageSource, 0, 0);
  rc.tmpCtx.filter = "none";
  rc.tmpCtx.globalCompositeOperation = "multiply";
  rc.tmpCtx.fillStyle = toCssColor(String(rc.params("color")));
  rc.tmpCtx.fillRect(0, 0, rc.tmp.width, rc.tmp.height);
  rc.tmpCtx.globalCompositeOperation = "destination-in";
  rc.tmpCtx.drawImage(rc.canvas as CanvasImageSource, 0, 0);
  rc.tmpCtx.globalCompositeOperation = "source-over";
  rc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  rc.ctx.globalAlpha = amount;
  rc.ctx.globalCompositeOperation = "source-atop";
  rc.ctx.drawImage(rc.tmp as CanvasImageSource, 0, 0);
  rc.ctx.globalAlpha = 1;
  rc.ctx.globalCompositeOperation = "source-over";
});

registerEffectRenderer("pixelate", (rc) => {
  const size = Math.max(1, num(rc, "size") * rc.pxScale);
  if (size <= 1) return;
  const w = Math.max(1, Math.round(rc.canvas.width / size));
  const h = Math.max(1, Math.round(rc.canvas.height / size));
  clear(rc.tmpCtx, rc.tmp);
  rc.tmpCtx.imageSmoothingEnabled = true;
  rc.tmpCtx.drawImage(rc.canvas as CanvasImageSource, 0, 0, w, h);
  clear(rc.ctx, rc.canvas);
  rc.ctx.imageSmoothingEnabled = false;
  rc.ctx.drawImage(rc.tmp as CanvasImageSource, 0, 0, w, h, 0, 0, rc.canvas.width, rc.canvas.height);
  rc.ctx.imageSmoothingEnabled = true;
});

registerEffectRenderer("vignette", (rc) => {
  const amount = num(rc, "amount");
  const size = num(rc, "size");
  const w = rc.canvas.width;
  const h = rc.canvas.height;
  const r = Math.hypot(w, h) / 2;
  const g = rc.ctx.createRadialGradient(w / 2, h / 2, r * size * 0.5, w / 2, h / 2, r);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, `rgba(0,0,0,${amount})`);
  rc.ctx.setTransform(1, 0, 0, 1, 0, 0);
  rc.ctx.globalCompositeOperation = "source-atop";
  rc.ctx.fillStyle = g;
  rc.ctx.fillRect(0, 0, w, h);
  rc.ctx.globalCompositeOperation = "source-over";
});

export function runEffect(fx: Effect, rc: Omit<EffectRenderContext, "params">) {
  const fn = renderers.get(fx.type);
  if (!fn || !fx.enabled) return;
  fn({ ...rc, params: (k) => evaluate(fx.params[k], rc.time) });
}

export { clear as clearCanvas };
