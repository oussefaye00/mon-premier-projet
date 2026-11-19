import { useEffect, useMemo, useRef, useState } from "react";
import { getPropertyAtPath, isAnimated, listAnimatablePaths, type Layer } from "@amai/core";
import { app } from "../app/EditorApp";
import { fmtTime, useApp, useProject, useSession } from "../app/hooks";
import { beginGesture, safely } from "./controls";
import { Icon } from "./Icon";

const TYPE_ICON: Record<string, string> = {
  text: "text",
  shape: "star",
  solid: "solid",
  image: "image",
  video: "film",
  audio: "audio",
  particles: "particles",
  composition: "layers",
  camera: "camera",
  null: "null",
};

const PROP_LABEL: Record<string, string> = {
  "transform.positionX": "Position X",
  "transform.positionY": "Position Y",
  "transform.scaleX": "Échelle X",
  "transform.scaleY": "Échelle Y",
  "transform.rotation": "Rotation",
  "transform.opacity": "Opacité",
  "transform.anchorX": "Origine X",
  "transform.anchorY": "Origine Y",
};

export function propLabel(path: string, layer?: Layer) {
  if (PROP_LABEL[path]) return PROP_LABEL[path];
  const parts = path.split(".");
  if (parts[0] === "effects" && layer) {
    const fx = layer.effects.find((f) => f.id === parts[1]);
    return `${fx?.type ?? "effet"} · ${parts[2]}`;
  }
  return parts[parts.length - 1];
}

/** Timeline multipistes : un calque par piste, clips déplaçables/redimensionnables, keyframes. */
export function Timeline() {
  const a = useApp();
  const project = useProject();
  const session = useSession();
  const comp = project.compositions.find((c) => c.id === project.activeCompositionId)!;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [renaming, setRenaming] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const pps = a.timelineZoom; // pixels par seconde
  const totalW = Math.max(width - 4, comp.duration * pps + 40);
  const layers = useMemo(() => [...comp.layers].reverse(), [comp.layers]);

  useEffect(() => {
    const el = scrollRef.current!;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const xToTime = (clientX: number) => {
    const el = scrollRef.current!;
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(comp.duration, (clientX - r.left + el.scrollLeft) / pps));
  };
  const snap = (t: number, ev?: { altKey?: boolean }) => {
    if (ev?.altKey) return t;
    const fr = Math.round(t * comp.fps) / comp.fps;
    // Magnétisme sur la tête de lecture et les bords des autres clips
    const targets = [session.currentTime, 0, comp.duration, ...comp.layers.flatMap((l) => [l.inPoint, l.outPoint])];
    for (const x of targets) if (Math.abs(x - t) * pps < 6) return x;
    return fr;
  };

  const scrubStart = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    app.stop();
    app.seek(snap(xToTime(e.clientX), e));
    const move = (ev: PointerEvent) => app.seek(snap(xToTime(ev.clientX), ev));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const clipDrag = (e: React.PointerEvent, l: Layer, mode: "move" | "in" | "out") => {
    e.stopPropagation();
    if (e.button !== 0) return;
    if (!session.selectedLayerIds.includes(l.id)) app.engine.select(e.shiftKey ? [...session.selectedLayerIds, l.id] : [l.id]);
    if (l.locked) return;
    const t0 = xToTime(e.clientX);
    const init = { inPoint: l.inPoint, outPoint: l.outPoint, offset: l.props.mediaOffset ?? 0 };
    let applied = 0;
    let end: (() => void) | null = null;
    const move = (ev: PointerEvent) => {
      const dt = xToTime(ev.clientX) - t0;
      if (!end && Math.abs(dt * pps) < 3) return;
      if (!end) end = beginGesture(mode === "move" ? "Déplacer le clip" : "Rogner le clip");
      safely(() => {
        if (mode === "move") {
          const target = snap(init.inPoint + dt, ev) - init.inPoint;
          const d = Math.max(-init.inPoint, target) - applied;
          if (Math.abs(d) > 1e-6) {
            app.engine.shiftLayer(l.id, d);
            applied += d;
          }
        } else if (mode === "in") {
          let ni = Math.max(0, Math.min(init.outPoint - 1 / comp.fps, snap(init.inPoint + dt, ev)));
          const rate = l.props.playbackRate ?? 1;
          if (l.props.mediaOffset !== undefined) ni = Math.max(ni, init.inPoint - init.offset / rate);
          const props = l.props.mediaOffset !== undefined ? { mediaOffset: init.offset + (ni - init.inPoint) * rate } : undefined;
          app.engine.updateLayer(l.id, { inPoint: ni, ...(props ? { props } : {}) });
        } else {
          let no = Math.max(init.inPoint + 1 / comp.fps, snap(init.outPoint + dt, ev));
          const asset = project.assets.find((x) => x.id === l.props.assetId);
          if (asset?.duration) no = Math.min(no, init.inPoint + (asset.duration - init.offset) / (l.props.playbackRate ?? 1));
          app.engine.updateLayer(l.id, { outPoint: no });
        }
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      end?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const kfDrag = (e: React.PointerEvent, l: Layer, path: string, kfId: string, time: number) => {
    e.stopPropagation();
    app.engine.select([l.id]);
    app.engine.setSession({ selectedKeyframe: { layerId: l.id, path, keyframeId: kfId } });
    app.seek(time);
    const t0 = xToTime(e.clientX);
    let end: (() => void) | null = null;
    const move = (ev: PointerEvent) => {
      const nt = snap(time + xToTime(ev.clientX) - t0, ev);
      if (!end && Math.abs(nt - time) < 1e-6) return;
      if (!end) end = beginGesture("Déplacer une keyframe");
      safely(() => app.engine.moveKeyframe(l.id, path, kfId, nt));
      app.seek(nt);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      end?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Graduations
  const ticks = useMemo(() => {
    const out: { x: number; label?: string; major: boolean }[] = [];
    const step = pps > 150 ? 1 / comp.fps * Math.ceil(10 / (pps / comp.fps)) : pps > 40 ? 0.5 : pps > 15 ? 1 : 5;
    for (let t = 0; t <= comp.duration + 1e-6; t += step) {
      const major = Math.abs(t - Math.round(t)) < 1e-6;
      out.push({ x: t * pps, major, label: major ? `${Math.round(t)}s` : undefined });
    }
    return out;
  }, [pps, comp.duration, comp.fps]);

  const selectedLayers = comp.layers.filter((l) => session.selectedLayerIds.includes(l.id));
  const sel = selectedLayers[0];

  const split = () =>
    safely(() => {
      if (!selectedLayers.length) throw new Error("Sélectionnez un clip à découper.");
      for (const l of selectedLayers) app.engine.splitLayer(l.id, session.currentTime);
    });
  const merge = () =>
    safely(() => {
      if (selectedLayers.length !== 2) throw new Error("Sélectionnez exactement deux clips contigus à fusionner (Maj+clic).");
      const m = app.engine.mergeLayers(selectedLayers[0].id, selectedLayers[1].id);
      app.engine.select([m.id]);
    });

  const rowFor = (l: Layer) => {
    const animated = listAnimatablePaths(l).filter((p) => isAnimated(getPropertyAtPath(l, p)));
    const allKf = animated.flatMap((p) => getPropertyAtPath(l, p)!.keyframes!.map((k) => ({ k, p })));
    const isSel = session.selectedLayerIds.includes(l.id);
    const isOpen = !!expanded[l.id];
    return { animated, allKf, isSel, isOpen };
  };

  return (
    <div className="timeline" data-testid="timeline">
      <div className="tl-toolbar">
        <button className="icon-btn" onClick={() => app.stepFrame(-1)} title="Image précédente (←)">
          <Icon name="frameBack" />
        </button>
        <button className="icon-btn play" onClick={() => app.togglePlay()} title="Lecture / pause (Espace)" data-testid="play">
          <Icon name={a.playing ? "pause" : "play"} />
        </button>
        <button className="icon-btn" onClick={() => app.stepFrame(1)} title="Image suivante (→)">
          <Icon name="frameFwd" />
        </button>
        <span className="timecode" data-testid="timecode">
          {fmtTime(session.currentTime, comp.fps)} <small>/ {fmtTime(comp.duration, comp.fps)}</small>
        </span>
        <span className="sep" />
        <button className="tbtn" onClick={split} title="Découper les clips sélectionnés à la tête de lecture (S)" data-testid="split">
          <Icon name="scissors" /> <span className="lbl">Découper</span>
        </button>
        <button className="tbtn" onClick={merge} title="Fusionner deux clips contigus">
          <Icon name="merge" /> <span className="lbl">Fusionner</span>
        </button>
        <button className="tbtn" disabled={!sel} onClick={() => safely(() => app.engine.duplicateLayer(sel!.id))} title="Dupliquer (Ctrl+D)">
          <Icon name="copy" />
        </button>
        <button className="tbtn" disabled={!selectedLayers.length} onClick={() => safely(() => app.engine.deleteLayers(selectedLayers.map((l) => l.id)))} title="Supprimer (Suppr)">
          <Icon name="trash" />
        </button>
        <button className="tbtn" disabled={selectedLayers.length < 1} onClick={() => safely(() => { const r = app.engine.precompose(selectedLayers.map((l) => l.id)); app.engine.select([r.layer.id]); })} title="Pré-composer la sélection">
          <Icon name="layers" /> <span className="lbl">Pré-composer</span>
        </button>
        <button className={`tbtn ${a.graphEditor.open ? "on" : ""}`} onClick={() => app.set("graphEditor", { open: !a.graphEditor.open })} title="Éditeur de courbes">
          <Icon name="graph" /> <span className="lbl">Courbes</span>
        </button>
        <span className="grow" />
        <label className="zoom" title="Zoom de la timeline">
          <Icon name="film" size={13} />
          <input type="range" min={10} max={600} value={pps} onChange={(e) => app.set("timelineZoom", +e.target.value)} />
        </label>
      </div>
      <div className="tl-body">
        <div className="tl-names">
          <div className="tl-ruler-spacer">
            <span>{comp.layers.length} calque{comp.layers.length > 1 ? "s" : ""}</span>
          </div>
          {layers.map((l) => {
            const r = rowFor(l);
            return (
              <div key={l.id}>
                <div
                  className={`tl-name ${r.isSel ? "sel" : ""} ${!l.visible ? "hidden" : ""}`}
                  data-testid={`layer-row-${l.name}`}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData("text/layer", l.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData("text/layer");
                    if (id && id !== l.id) safely(() => app.engine.reorderLayer(id, comp.layers.findIndex((x) => x.id === l.id)));
                  }}
                  onPointerDown={(e) => {
                    if ((e.target as HTMLElement).closest("button,input")) return;
                    app.engine.select(e.shiftKey ? Array.from(new Set([...session.selectedLayerIds, l.id])) : [l.id]);
                  }}
                  onDoubleClick={() => setRenaming(l.id)}
                >
                  <button className={`exp ${r.isOpen ? "open" : ""}`} onClick={() => setExpanded({ ...expanded, [l.id]: !r.isOpen })} title="Afficher les propriétés animées">
                    <Icon name="chevron" size={12} />
                  </button>
                  <button className="mini" onClick={() => safely(() => app.engine.updateLayer(l.id, { visible: !l.visible }))} title="Visibilité">
                    <Icon name={l.visible ? "eye" : "eyeOff"} size={13} />
                  </button>
                  <button className="mini" onClick={() => safely(() => app.engine.updateLayer(l.id, { locked: !l.locked }))} title="Verrouiller">
                    <Icon name={l.locked ? "lock" : "unlock"} size={12} />
                  </button>
                  <span className={`type t-${l.type}`}>
                    <Icon name={TYPE_ICON[l.type]} size={13} />
                  </span>
                  {renaming === l.id ? (
                    <input
                      autoFocus
                      defaultValue={l.name}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={(e) => {
                        setRenaming(null);
                        if (e.target.value.trim() && e.target.value !== l.name) safely(() => app.engine.updateLayer(l.id, { name: e.target.value.trim() }));
                      }}
                    />
                  ) : (
                    <span className="nm" title={l.name}>
                      {l.name}
                    </span>
                  )}
                </div>
                {r.isOpen &&
                  r.animated.map((p) => (
                    <div key={p} className="tl-name sub">
                      <span className="nm">{propLabel(p, l)}</span>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
        <div className="tl-tracks" ref={scrollRef}>
          <div style={{ width: totalW, position: "relative" }}>
            <div className="tl-ruler" onPointerDown={scrubStart} data-testid="ruler">
              {ticks.map((t, i) => (
                <div key={i} className={`tick ${t.major ? "major" : ""}`} style={{ left: t.x }}>
                  {t.label && <span>{t.label}</span>}
                </div>
              ))}
              <div className="comp-end" style={{ left: comp.duration * pps }} />
            </div>
            {layers.map((l) => {
              const r = rowFor(l);
              return (
                <div key={l.id}>
                  <div className={`tl-track ${r.isSel ? "sel" : ""}`} onPointerDown={scrubStart}>
                    <div
                      className={`clip c-${l.type} ${r.isSel ? "sel" : ""} ${l.locked ? "locked" : ""} ${!l.visible ? "hidden" : ""}`}
                      style={{ left: l.inPoint * pps, width: Math.max(4, (l.outPoint - l.inPoint) * pps) }}
                      onPointerDown={(e) => clipDrag(e, l, "move")}
                      data-testid={`clip-${l.name}`}
                    >
                      <div className="trim in" onPointerDown={(e) => clipDrag(e, l, "in")} />
                      {l.transitionIn && <div className="trans in" style={{ width: l.transitionIn.duration * pps }} title={`Transition d'entrée : ${l.transitionIn.type}`} />}
                      {l.transitionOut && <div className="trans out" style={{ width: l.transitionOut.duration * pps }} title={`Transition de sortie : ${l.transitionOut.type}`} />}
                      <span className="clip-name">{l.name}</span>
                      {!r.isOpen &&
                        r.allKf.map(({ k }, i) => (
                          <span key={i} className="kf-dot" style={{ left: (k.time - l.inPoint) * pps }} />
                        ))}
                      <div className="trim out" onPointerDown={(e) => clipDrag(e, l, "out")} />
                    </div>
                  </div>
                  {r.isOpen &&
                    r.animated.map((p) => {
                      const prop = getPropertyAtPath(l, p)!;
                      return (
                        <div key={p} className="tl-track sub" onPointerDown={scrubStart}>
                          {prop.keyframes!.map((k) => {
                            const selK = session.selectedKeyframe?.keyframeId === k.id;
                            return (
                              <span
                                key={k.id}
                                className={`kf ${selK ? "sel" : ""} e-${k.easing.type}`}
                                style={{ left: k.time * pps }}
                                title={`${propLabel(p, l)} = ${typeof k.value === "number" ? +k.value.toFixed(2) : k.value} @ ${k.time.toFixed(2)}s (${k.easing.type})`}
                                onPointerDown={(e) => kfDrag(e, l, p, k.id, k.time)}
                                onDoubleClick={() => app.set("graphEditor", { open: true })}
                                onContextMenu={(e) => {
                                  e.preventDefault();
                                  safely(() => app.engine.removeKeyframe(l.id, p, k.id));
                                }}
                              />
                            );
                          })}
                        </div>
                      );
                    })}
                </div>
              );
            })}
            <div className="playhead" style={{ left: session.currentTime * pps }} data-testid="playhead">
              <div className="ph-head" onPointerDown={scrubStart} />
            </div>
            {!comp.layers.length && <div className="tl-empty">Importez des médias ou ajoutez un texte, une forme, des particules…</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
