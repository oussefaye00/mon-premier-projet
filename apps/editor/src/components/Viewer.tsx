import { useEffect, useRef, useState } from "react";
import { evaluate, evaluateTransform, type Layer } from "@amai/core";
import { apply, invert, mul, rotate, scale as mScale, translate, type Mat } from "@amai/renderer";
import { app } from "../app/EditorApp";
import { useApp, useProject, useSession } from "../app/hooks";
import { beginGesture, safely } from "./controls";

function localMatrix(l: Layer, t: number): Mat {
  const tr = evaluateTransform(l.transform, t);
  return mul(mul(mul(translate(tr.positionX, tr.positionY), rotate(tr.rotation)), mScale(tr.scaleX / 100, tr.scaleY / 100)), translate(-tr.anchorX, -tr.anchorY));
}

/**
 * Fenêtre de prévisualisation : rendu temps réel (qualité adaptative), sélection au clic,
 * déplacement, mise à l'échelle et rotation directement dans l'image, création de textes
 * et de formes avec les outils.
 */
export function Viewer() {
  const a = useApp();
  const project = useProject();
  const session = useSession();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState({ w: 640, h: 360 });
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [stats, setStats] = useState({ ms: 0, scale: 1 });
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dirty = useRef(true);
  const adaptive = useRef(1);
  const comp = project.compositions.find((c) => c.id === project.activeCompositionId)!;

  // Taille disponible
  useEffect(() => {
    const el = wrapRef.current!;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = Math.max(0.05, Math.min((box.w - 24) / comp.width, (box.h - 24) / comp.height));
  const viewScale = zoom === "fit" ? fit : zoom;
  const dispW = comp.width * viewScale;
  const dispH = comp.height * viewScale;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // Résolution de rendu : pixels réels affichés, plafonnée par le réglage et la qualité adaptative.
  const setting = a.settings.previewScale;
  const baseScale = setting === "auto" ? Math.min(1, viewScale * dpr) : setting;
  const renderScale = Math.max(0.1, baseScale * (a.playing ? adaptive.current : 1));
  const W = Math.max(1, Math.round(comp.width * renderScale));
  const H = Math.max(1, Math.round(comp.height * renderScale));

  // Boucle de rendu : ne redessine que si nécessaire.
  useEffect(() => {
    const mark = () => (dirty.current = true);
    app.renderListeners.add(mark);
    mark();
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      if (!dirty.current) return;
      dirty.current = false;
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext("2d")!;
      const p = app.engine.project;
      const t = app.engine.session.currentTime;
      app.media.syncPreview(p, t, app.playing);
      const t0 = performance.now();
      app.renderer.render(ctx, p, p.activeCompositionId, t, app.media, {
        scale: c.width / app.engine.comp().width,
        motionBlur: app.settings.motionBlurPreview && !(app.playing && adaptive.current < 1),
      });
      const ms = performance.now() - t0;
      // Qualité adaptative pendant la lecture (appareils modestes).
      if (app.playing) {
        if (ms > 28 && adaptive.current > 0.35) adaptive.current *= 0.8;
        else if (ms < 10 && adaptive.current < 1) adaptive.current = Math.min(1, adaptive.current * 1.1);
      } else adaptive.current = 1;
      setStats((s) => (Math.abs(s.ms - ms) > 2 || s.scale !== c.width / app.engine.comp().width ? { ms, scale: c.width / app.engine.comp().width } : s));
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      app.renderListeners.delete(mark);
    };
  }, []);

  useEffect(() => {
    dirty.current = true;
  }, [W, H, project, session.currentTime]);

  // ---------------------------------------------------------------- géométrie

  const toComp = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: ((clientX - r.left) / r.width) * comp.width, y: ((clientY - r.top) / r.height) * comp.height };
  };

  const measureCtx = useRef<CanvasRenderingContext2D | null>(null);
  if (!measureCtx.current && typeof document !== "undefined") measureCtx.current = document.createElement("canvas").getContext("2d");

  const layerGeom = (l: Layer) => {
    const t = session.currentTime;
    const b = app.renderer.localBounds(measureCtx.current!, project, comp, l, t, app.media);
    if (!b) return null;
    const m = app.renderer.layerViewMatrix(comp, l, t);
    const corners = [apply(m, b.x, b.y), apply(m, b.x + b.w, b.y), apply(m, b.x + b.w, b.y + b.h), apply(m, b.x, b.y + b.h)];
    const center = apply(m, b.x + b.w / 2, b.y + b.h / 2);
    const origin = apply(m, evaluate(l.transform.anchorX, t), evaluate(l.transform.anchorY, t));
    return { m, b, corners, center, origin };
  };

  const hitTest = (x: number, y: number): Layer | null => {
    const t = session.currentTime;
    for (let i = comp.layers.length - 1; i >= 0; i--) {
      const l = comp.layers[i];
      if (!l.visible || l.locked || t < l.inPoint || t >= l.outPoint || l.type === "audio") continue;
      const g = layerGeom(l);
      if (!g) continue;
      const [lx, ly] = apply(invert(g.m), x, y);
      if (lx >= g.b.x && lx <= g.b.x + g.b.w && ly >= g.b.y && ly <= g.b.y + g.b.h) return l;
    }
    return null;
  };

  const selected = comp.layers.filter((l) => session.selectedLayerIds.includes(l.id));
  const primary = selected[selected.length - 1];
  const geom = primary && session.currentTime >= primary.inPoint && session.currentTime < primary.outPoint ? layerGeom(primary) : null;

  // ---------------------------------------------------------------- interactions

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || a.tool === "hand" || (e.button === 0 && e.altKey && e.shiftKey)) {
      const sx = e.clientX;
      const sy = e.clientY;
      const p0 = { ...pan };
      const move = (ev: PointerEvent) => setPan({ x: p0.x + ev.clientX - sx, y: p0.y + ev.clientY - sy });
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }
    if (e.button !== 0) return;
    const pt = toComp(e.clientX, e.clientY);
    const t = session.currentTime;

    if (a.tool === "text") {
      safely(() => {
        const l = app.engine.createText("Texte", { x: pt.x, y: pt.y, inPoint: t });
        app.engine.select([l.id]);
        app.set("tool", "select");
        app.set("sideTab", "properties");
      });
      return;
    }
    if (a.tool === "rectangle" || a.tool === "ellipse" || a.tool === "star") {
      const kind = a.tool;
      setDraft({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
      const move = (ev: PointerEvent) => {
        const p = toComp(ev.clientX, ev.clientY);
        setDraft({ x0: pt.x, y0: pt.y, x1: p.x, y1: p.y });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDraft(null);
        const p = toComp(ev.clientX, ev.clientY);
        let w = Math.abs(p.x - pt.x);
        let h = Math.abs(p.y - pt.y);
        if (w < 8 && h < 8) w = h = 300;
        if (ev.shiftKey) w = h = Math.max(w, h);
        safely(() => {
          const l = app.engine.createShape(kind, { x: (p.x + pt.x) / 2 || pt.x, y: (p.y + pt.y) / 2 || pt.y, width: Math.round(w), height: Math.round(h), inPoint: t });
          app.engine.select([l.id]);
          app.set("tool", "select");
        });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }

    // Outil sélection
    const hit = hitTest(pt.x, pt.y);
    const target = hit && (e.shiftKey ? hit : session.selectedLayerIds.includes(hit.id) ? hit : hit);
    if (!target) {
      app.engine.select([]);
      return;
    }
    if (e.shiftKey) {
      const ids = session.selectedLayerIds.includes(target.id) ? session.selectedLayerIds.filter((x) => x !== target.id) : [...session.selectedLayerIds, target.id];
      app.engine.select(ids);
      return;
    }
    if (!session.selectedLayerIds.includes(target.id)) app.engine.select([target.id]);
    startMove(e, [target.id]);
  };

  const startMove = (e: React.PointerEvent | PointerEvent, ids: string[]) => {
    const t = session.currentTime;
    const start = toComp(e.clientX, e.clientY);
    const layers = ids.map((id) => comp.layers.find((l) => l.id === id)!).filter((l) => l && !l.locked);
    const init = layers.map((l) => {
      // Conversion du déplacement écran → espace parent du calque.
      const view = app.renderer.layerViewMatrix(comp, l, t);
      const parent = mul(view, invert(localMatrix(l, t)));
      return { l, x: evaluate(l.transform.positionX, t), y: evaluate(l.transform.positionY, t), inv: invert(parent) };
    });
    let end: (() => void) | null = null;
    const move = (ev: PointerEvent) => {
      const p = toComp(ev.clientX, ev.clientY);
      let dx = p.x - start.x;
      let dy = p.y - start.y;
      if (!end && Math.hypot(dx, dy) < 2) return;
      if (!end) end = beginGesture("Déplacer");
      if (ev.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      for (const it of init) {
        const [x0, y0] = apply(it.inv, start.x, start.y);
        const [x1, y1] = apply(it.inv, start.x + dx, start.y + dy);
        safely(() =>
          app.engine.updateLayer(it.l.id, { transform: { positionX: Math.round((it.x + x1 - x0) * 10) / 10, positionY: Math.round((it.y + y1 - y0) * 10) / 10 } }, "user", t),
        );
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      end?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startHandle = (e: React.PointerEvent, kind: "scale" | "rotate") => {
    e.stopPropagation();
    if (!primary || !geom) return;
    const t = session.currentTime;
    const c = geom.origin;
    const p0 = toComp(e.clientX, e.clientY);
    const sx = evaluate(primary.transform.scaleX, t);
    const sy = evaluate(primary.transform.scaleY, t);
    const r0 = evaluate(primary.transform.rotation, t);
    const d0 = Math.max(1, Math.hypot(p0.x - c[0], p0.y - c[1]));
    const a0 = Math.atan2(p0.y - c[1], p0.x - c[0]);
    const end = beginGesture(kind === "scale" ? "Mise à l'échelle" : "Rotation");
    const move = (ev: PointerEvent) => {
      const p = toComp(ev.clientX, ev.clientY);
      if (kind === "scale") {
        const f = Math.hypot(p.x - c[0], p.y - c[1]) / d0;
        safely(() => app.engine.updateLayer(primary.id, { transform: { scaleX: Math.round(sx * f * 10) / 10, scaleY: Math.round(sy * f * 10) / 10 } }, "user", t));
      } else {
        let ang = r0 + ((Math.atan2(p.y - c[1], p.x - c[0]) - a0) * 180) / Math.PI;
        if (ev.shiftKey) ang = Math.round(ang / 15) * 15;
        safely(() => app.engine.updateLayer(primary.id, { transform: { rotation: Math.round(ang * 10) / 10 } }, "user", t));
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      end();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    const z = (zoom === "fit" ? fit : zoom) * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
    setZoom(Math.max(0.05, Math.min(8, z)));
  };

  // Points en coordonnées d'affichage
  const k = viewScale;
  const pts = geom?.corners.map(([x, y]) => [x * k, y * k]);
  const topMid = pts ? [(pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2] : null;
  const ctr = geom ? [geom.center[0] * k, geom.center[1] * k] : null;
  const rotHandle = topMid && ctr ? (() => {
    const dx = topMid[0] - ctr[0];
    const dy = topMid[1] - ctr[1];
    const len = Math.hypot(dx, dy) || 1;
    return [topMid[0] + (dx / len) * 28, topMid[1] + (dy / len) * 28];
  })() : null;

  return (
    <div className={`viewer tool-${a.tool}`} ref={wrapRef} onWheel={onWheel} onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) void app.importFiles(e.dataTransfer.files);
    }}>
      <div className="stage" style={{ width: dispW, height: dispH, transform: `translate(${pan.x}px, ${pan.y}px)` }}>
        <canvas ref={canvasRef} width={W} height={H} style={{ width: dispW, height: dispH }} onPointerDown={onPointerDown} data-testid="viewer-canvas" />
        <svg className="overlay" width={dispW} height={dispH}>
          {selected.length > 1 &&
            selected.slice(0, -1).map((l) => {
              const g = layerGeom(l);
              return g ? <polygon key={l.id} points={g.corners.map(([x, y]) => `${x * k},${y * k}`).join(" ")} className="sel-secondary" /> : null;
            })}
          {pts && ctr && rotHandle && topMid && (
            <g>
              <polygon points={pts.map((p) => p.join(",")).join(" ")} className="sel-box" />
              <line x1={topMid[0]} y1={topMid[1]} x2={rotHandle[0]} y2={rotHandle[1]} className="sel-line" />
              {pts.map((p, i) => (
                <rect key={i} x={p[0] - 5} y={p[1] - 5} width={10} height={10} className="handle" onPointerDown={(e) => startHandle(e, "scale")} data-testid={`handle-scale-${i}`} />
              ))}
              <circle cx={rotHandle[0]} cy={rotHandle[1]} r={6} className="handle rot" onPointerDown={(e) => startHandle(e, "rotate")} data-testid="handle-rotate" />
              <circle cx={geom!.origin[0] * k} cy={geom!.origin[1] * k} r={4} className="anchor" />
            </g>
          )}
          {draft && (
            <rect x={Math.min(draft.x0, draft.x1) * k} y={Math.min(draft.y0, draft.y1) * k} width={Math.abs(draft.x1 - draft.x0) * k} height={Math.abs(draft.y1 - draft.y0) * k} className="draft" />
          )}
        </svg>
      </div>
      <div className="viewer-hud">
        <select value={zoom === "fit" ? "fit" : String(zoom)} onChange={(e) => { setZoom(e.target.value === "fit" ? "fit" : parseFloat(e.target.value)); setPan({ x: 0, y: 0 }); }} title="Zoom de la vue">
          <option value="fit">Ajuster</option>
          {[0.25, 0.5, 1, 2].map((z) => (
            <option key={z} value={z}>
              {z * 100}%
            </option>
          ))}
          {zoom !== "fit" && ![0.25, 0.5, 1, 2].includes(zoom) && <option value={zoom}>{Math.round(zoom * 100)}%</option>}
        </select>
        <select value={String(a.settings.previewScale)} onChange={(e) => app.saveSettings({ previewScale: e.target.value === "auto" ? "auto" : (parseFloat(e.target.value) as 1 | 0.5 | 0.25) })} title="Résolution de prévisualisation">
          <option value="auto">Résolution auto</option>
          <option value="1">Complète</option>
          <option value="0.5">1/2</option>
          <option value="0.25">1/4</option>
        </select>
        <span className="hud-stat" title="Temps de rendu de la dernière image">
          {Math.round(stats.scale * comp.width)}×{Math.round(stats.scale * comp.height)} · {stats.ms.toFixed(1)} ms
        </span>
      </div>
    </div>
  );
}
