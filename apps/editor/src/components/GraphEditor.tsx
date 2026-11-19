import { useState } from "react";
import { applyEasing, EASING_PRESETS, evaluate, getPropertyAtPath, isAnimated, listAnimatablePaths, type Easing } from "@amai/core";
import { app } from "../app/EditorApp";
import { useProject, useSession } from "../app/hooks";
import { beginGesture, safely } from "./controls";
import { Icon } from "./Icon";
import { propLabel } from "./Timeline";

const S = 200; // taille de l'éditeur Bézier
const PAD = 40;

/** Éditeur de courbes : courbe d'easing Bézier de la keyframe + graphe de valeur de la propriété. */
export function GraphEditor() {
  const project = useProject();
  const session = useSession();
  const comp = project.compositions.find((c) => c.id === project.activeCompositionId)!;
  const layer = comp.layers.find((l) => l.id === (session.selectedKeyframe?.layerId ?? session.selectedLayerIds[0]));
  const animated = layer ? listAnimatablePaths(layer).filter((p) => isAnimated(getPropertyAtPath(layer, p))) : [];
  const [pathSel, setPathSel] = useState<string | null>(null);
  const path = session.selectedKeyframe?.layerId === layer?.id && session.selectedKeyframe?.path ? session.selectedKeyframe.path : pathSel && animated.includes(pathSel) ? pathSel : animated[0];
  const prop = layer && path ? getPropertyAtPath(layer, path) : undefined;
  const kfs = prop?.keyframes ?? [];
  const kf = kfs.find((k) => k.id === session.selectedKeyframe?.keyframeId) ?? kfs[0];
  const close = () => app.set("graphEditor", { open: false });

  if (!layer || !prop || !kf) {
    return (
      <div className="graph-editor">
        <div className="ge-head">
          <Icon name="graph" /> Éditeur de courbes <span className="grow" />
          <button className="icon-btn" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <p className="hint">Sélectionnez un calque animé, puis une keyframe dans la timeline (dépliez le calque avec ▸).</p>
      </div>
    );
  }

  const e = kf.easing;
  const bez = e.type === "bezier" ? e : e.type === "linear" ? { x1: 0, y1: 0, x2: 1, y2: 1 } : null;
  const setEasing = (ez: Easing | string) => safely(() => app.engine.setKeyframeEasing(layer.id, path!, kf.id, ez));
  const toPx = (x: number, y: number): [number, number] => [PAD + x * S, PAD + (1 - y) * S];

  const drag = (ev: React.PointerEvent, which: 1 | 2) => {
    ev.preventDefault();
    const svg = (ev.currentTarget as SVGElement).ownerSVGElement!;
    const r = svg.getBoundingClientRect();
    const sx = r.width / (S + PAD * 2);
    const sy = r.height / (S + PAD * 2);
    const base = bez ?? { x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
    const end = beginGesture("Courbe d'animation");
    const move = (m: PointerEvent) => {
      const x = Math.min(1, Math.max(0, ((m.clientX - r.left) / sx - PAD) / S));
      const y = Math.min(2, Math.max(-1, 1 - ((m.clientY - r.top) / sy - PAD) / S));
      const nb = which === 1 ? { ...base, x1: +x.toFixed(3), y1: +y.toFixed(3) } : { ...base, x2: +x.toFixed(3), y2: +y.toFixed(3) };
      setEasing({ type: "bezier", ...nb });
      Object.assign(base, nb);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      end();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Courbe d'easing échantillonnée
  const curve = Array.from({ length: 61 }, (_, i) => toPx(i / 60, applyEasing(e, i / 60)).join(",")).join(" ");
  // Graphe de valeur (nombres uniquement)
  const numeric = typeof kf.value === "number";
  const t0 = kfs[0].time;
  const t1 = kfs[kfs.length - 1].time;
  const span = Math.max(0.001, t1 - t0);
  const samples = numeric ? Array.from({ length: 121 }, (_, i) => t0 - span * 0.05 + (span * 1.1 * i) / 120).map((t) => ({ t, v: evaluate(prop, t) as number })) : [];
  const vmin = Math.min(...samples.map((s) => s.v));
  const vmax = Math.max(...samples.map((s) => s.v));
  const GW = 420;
  const GH = 180;
  const gx = (t: number) => ((t - (t0 - span * 0.05)) / (span * 1.1)) * GW;
  const gy = (v: number) => GH - 10 - ((v - vmin) / Math.max(1e-6, vmax - vmin)) * (GH - 20);

  return (
    <div className="graph-editor" data-testid="graph-editor">
      <div className="ge-head">
        <Icon name="graph" /> Courbes — {layer.name}
        <select value={path} onChange={(ev) => { setPathSel(ev.target.value); app.engine.setSession({ selectedKeyframe: null }); }}>
          {animated.map((p) => (
            <option key={p} value={p}>
              {propLabel(p, layer)}
            </option>
          ))}
        </select>
        <select value={kf.id} onChange={(ev) => app.engine.setSession({ selectedKeyframe: { layerId: layer.id, path: path!, keyframeId: ev.target.value } })}>
          {kfs.map((k, i) => (
            <option key={k.id} value={k.id}>
              Keyframe {i + 1} @ {k.time.toFixed(2)}s
            </option>
          ))}
        </select>
        <span className="grow" />
        <button className="icon-btn" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="ge-body">
        <div className="ge-bezier">
          <svg viewBox={`0 0 ${S + PAD * 2} ${S + PAD * 2}`} width={S + PAD * 2} height={S + PAD * 2}>
            <rect x={PAD} y={PAD} width={S} height={S} className="ge-grid" />
            <line x1={PAD} y1={PAD + S} x2={PAD + S} y2={PAD} className="ge-diag" />
            <polyline points={curve} className="ge-curve" />
            {bez && (
              <>
                <line x1={toPx(0, 0)[0]} y1={toPx(0, 0)[1]} x2={toPx(bez.x1, bez.y1)[0]} y2={toPx(bez.x1, bez.y1)[1]} className="ge-arm" />
                <line x1={toPx(1, 1)[0]} y1={toPx(1, 1)[1]} x2={toPx(bez.x2, bez.y2)[0]} y2={toPx(bez.x2, bez.y2)[1]} className="ge-arm" />
                <circle cx={toPx(bez.x1, bez.y1)[0]} cy={toPx(bez.x1, bez.y1)[1]} r={7} className="ge-handle" onPointerDown={(ev) => drag(ev, 1)} data-testid="bezier-h1" />
                <circle cx={toPx(bez.x2, bez.y2)[0]} cy={toPx(bez.x2, bez.y2)[1]} r={7} className="ge-handle" onPointerDown={(ev) => drag(ev, 2)} />
              </>
            )}
          </svg>
          <code className="ge-code">{bez ? `cubic-bezier(${bez.x1}, ${bez.y1}, ${bez.x2}, ${bez.y2})` : e.type}</code>
          {kf === kfs[kfs.length - 1] && <p className="hint">La courbe s'applique au segment qui suit la keyframe : la dernière keyframe n'a pas de segment.</p>}
        </div>
        <div className="ge-side">
          <div className="preset-grid">
            {Object.keys(EASING_PRESETS).map((n) => (
              <button key={n} className="chip" onClick={() => setEasing(n)} data-testid={`ease-${n}`}>
                {n}
              </button>
            ))}
          </div>
          <button className="btn" onClick={() => safely(() => app.engine.setKeyframeEasing(layer.id, path!, "all", kf.easing))}>
            Appliquer cette courbe à toutes les keyframes
          </button>
          {numeric && (
            <svg className="ge-value" viewBox={`0 0 ${GW} ${GH}`} width="100%" height={GH}>
              <polyline points={samples.map((s) => `${gx(s.t)},${gy(s.v)}`).join(" ")} className="ge-curve" />
              {kfs.map((k) => (
                <rect key={k.id} x={gx(k.time) - 4} y={gy(k.value as number) - 4} width={8} height={8} transform={`rotate(45 ${gx(k.time)} ${gy(k.value as number)})`} className={`ge-kf ${k.id === kf.id ? "sel" : ""}`} onClick={() => app.engine.setSession({ selectedKeyframe: { layerId: layer.id, path: path!, keyframeId: k.id } })} />
              ))}
              <line x1={gx(session.currentTime)} y1={0} x2={gx(session.currentTime)} y2={GH} className="ge-ph" />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
