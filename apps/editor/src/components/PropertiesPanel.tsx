import { getEffectDef, listEffectDefs, PRESETS, type Composition, type Layer, type TransitionType } from "@amai/core";
import { app } from "../app/EditorApp";
import { useProject, useSession } from "../app/hooks";
import { AnimRow, ColorField, NumberField, safely, Section } from "./controls";
import { Icon } from "./Icon";

const TRANSITIONS: { v: TransitionType | ""; l: string }[] = [
  { v: "", l: "Aucune" },
  { v: "fade", l: "Fondu" },
  { v: "slide-left", l: "Glissement ←" },
  { v: "slide-right", l: "Glissement →" },
  { v: "slide-up", l: "Glissement ↑" },
  { v: "slide-down", l: "Glissement ↓" },
  { v: "zoom", l: "Zoom" },
  { v: "blur", l: "Flou" },
  { v: "wipe", l: "Volet" },
];

const FONTS = [
  "Inter, Segoe UI, Roboto, sans-serif",
  "Georgia, serif",
  "'Times New Roman', serif",
  "'Courier New', monospace",
  "Impact, 'Arial Black', sans-serif",
  "'Trebuchet MS', sans-serif",
  "Verdana, sans-serif",
  "'Comic Sans MS', cursive",
];

export function PropertiesPanel() {
  const project = useProject();
  const session = useSession(app.playing ? 120 : 0);
  const comp = project.compositions.find((c) => c.id === project.activeCompositionId)!;
  const layer = comp.layers.find((l) => l.id === session.selectedLayerIds[session.selectedLayerIds.length - 1]);
  if (!layer) return <CompositionProps comp={comp} />;
  return <LayerProps key={layer.id} layer={layer} comp={comp} time={session.currentTime} />;
}

function CompositionProps({ comp }: { comp: Composition }) {
  const project = useProject();
  const up = (patch: Parameters<typeof app.engine.updateComposition>[0]) => safely(() => app.engine.updateComposition(patch));
  return (
    <div className="props" data-testid="comp-props">
      <div className="props-title">
        <Icon name="film" /> Composition
      </div>
      <Section title="Paramètres">
        <div className="row">
          <label>Nom</label>
          <input defaultValue={comp.name} key={comp.id + comp.name} onBlur={(e) => e.target.value !== comp.name && up({ name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <div className="row">
          <label>Format</label>
          <select
            value={`${comp.width}x${comp.height}`}
            onChange={(e) => {
              const [w, h] = e.target.value.split("x").map(Number);
              if (w && h) up({ width: w, height: h });
            }}
          >
            {[
              ["1920x1080", "1080p 16:9"],
              ["3840x2160", "4K UHD"],
              ["1280x720", "720p"],
              ["1080x1920", "Vertical 9:16 (Reels, TikTok)"],
              ["1080x1080", "Carré 1:1"],
              ["1080x1350", "Portrait 4:5"],
            ].map(([v, l]) => (
              <option key={v} value={v}>
                {l} — {v.replace("x", "×")}
              </option>
            ))}
            {!["1920x1080", "3840x2160", "1280x720", "1080x1920", "1080x1080", "1080x1350"].includes(`${comp.width}x${comp.height}`) && <option value={`${comp.width}x${comp.height}`}>Personnalisé</option>}
          </select>
        </div>
        <div className="row">
          <label>Taille</label>
          <NumberField value={comp.width} onChange={(v) => up({ width: Math.round(v) })} min={16} max={7680} unit="px" precision={0} />
          <NumberField value={comp.height} onChange={(v) => up({ height: Math.round(v) })} min={16} max={7680} unit="px" precision={0} />
        </div>
        <div className="row">
          <label>FPS</label>
          <select value={comp.fps} onChange={(e) => up({ fps: +e.target.value })} data-testid="comp-fps">
            {[12, 15, 23.976, 24, 25, 29.97, 30, 48, 50, 60, 120].map((f) => (
              <option key={f} value={f}>
                {f} i/s
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>Durée</label>
          <NumberField value={comp.duration} onChange={(v) => up({ duration: v })} min={0.1} max={3600} step={0.1} unit="s" />
        </div>
        <div className="row">
          <label>Fond</label>
          <ColorField value={comp.background} onChange={(v) => up({ background: v })} />
        </div>
      </Section>
      <Section title="Motion blur" defaultOpen={false}>
        <div className="row">
          <label>Obturateur</label>
          <NumberField value={comp.shutterAngle ?? 180} onChange={(v) => up({ shutterAngle: v })} min={0} max={720} unit="°" precision={0} />
        </div>
        <div className="row">
          <label>Échantillons</label>
          <NumberField value={comp.motionBlurSamples ?? 8} onChange={(v) => up({ motionBlurSamples: Math.round(v) })} min={2} max={32} precision={0} />
        </div>
      </Section>
      {project.compositions.length > 1 && (
        <Section title="Compositions">
          {project.compositions.map((c) => (
            <div key={c.id} className={`list-item ${c.id === comp.id ? "active" : ""}`} onClick={() => safely(() => app.engine.setActiveComposition(c.id))}>
              <Icon name="layers" size={13} /> {c.name} <small>{c.layers.length} calques</small>
            </div>
          ))}
        </Section>
      )}
      <p className="hint">Sélectionnez un calque dans la vue ou la timeline pour modifier ses propriétés.</p>
    </div>
  );
}

function LayerProps({ layer, comp, time }: { layer: Layer; comp: Composition; time: number }) {
  const project = useProject();
  const p = layer.props;
  const upd = (u: Parameters<typeof app.engine.updateLayer>[1]) => safely(() => app.engine.updateLayer(layer.id, u));
  const props = (o: Record<string, unknown>) => upd({ props: o });
  const R = (path: string, label: string, extra: Partial<Parameters<typeof AnimRow>[0]> = {}) => <AnimRow layer={layer} path={path} label={label} time={time} {...extra} />;
  return (
    <div className="props" data-testid="layer-props">
      <div className="props-title">
        <input className="layer-name" key={layer.name} defaultValue={layer.name} onBlur={(e) => e.target.value.trim() && e.target.value !== layer.name && upd({ name: e.target.value.trim() })} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
        <span className={`badge t-${layer.type}`}>{layer.type}</span>
      </div>

      <Section title="Calque">
        <div className="row">
          <label>Début / fin</label>
          <NumberField value={layer.inPoint} onChange={(v) => upd({ inPoint: v })} min={0} step={1 / comp.fps} unit="s" />
          <NumberField value={layer.outPoint} onChange={(v) => upd({ outPoint: v })} min={0} step={1 / comp.fps} unit="s" />
        </div>
        <div className="row">
          <label>Fusion</label>
          <select value={layer.blendMode} onChange={(e) => upd({ blendMode: e.target.value as Layer["blendMode"] })}>
            {["normal", "multiply", "screen", "overlay", "darken", "lighten", "add", "difference"].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <label>Parent</label>
          <select value={layer.parentId ?? ""} onChange={(e) => upd({ parentId: e.target.value || null })}>
            <option value="">Aucun</option>
            {comp.layers
              .filter((l) => l.id !== layer.id)
              .map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
          </select>
        </div>
        <div className="row checks">
          <label>
            <input type="checkbox" checked={!!layer.motionBlur} onChange={(e) => upd({ motionBlur: e.target.checked })} data-testid="motion-blur" /> Motion blur
          </label>
          <label>
            <input type="checkbox" checked={!!layer.solo} onChange={(e) => upd({ solo: e.target.checked })} /> Solo
          </label>
        </div>
      </Section>

      {layer.type !== "audio" && (
        <Section title="Transformation">
          {R("transform.positionX", "Position X", { unit: "px" })}
          {R("transform.positionY", "Position Y", { unit: "px" })}
          {R("transform.scaleX", "Échelle X", { unit: "%" })}
          {R("transform.scaleY", "Échelle Y", { unit: "%" })}
          {R("transform.rotation", "Rotation", { unit: "°", step: 0.5 })}
          {R("transform.opacity", "Opacité", { unit: "%", min: 0, max: 100 })}
          {R("transform.anchorX", "Origine X", { unit: "px" })}
          {R("transform.anchorY", "Origine Y", { unit: "px" })}
        </Section>
      )}

      {layer.type === "text" && (
        <Section title="Texte">
          <textarea data-testid="text-content" defaultValue={p.text} key={layer.id + (p.text ?? "")} rows={2} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => e.target.value !== p.text && props({ text: e.target.value })} />
          <div className="row">
            <label>Police</label>
            <select value={p.fontFamily} onChange={(e) => props({ fontFamily: e.target.value })}>
              {[p.fontFamily!, ...FONTS.filter((f) => f !== p.fontFamily)].map((f) => (
                <option key={f} value={f}>
                  {f.split(",")[0].replace(/'/g, "")}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <label>Graisse</label>
            <select value={p.fontWeight} onChange={(e) => props({ fontWeight: +e.target.value })}>
              {[100, 300, 400, 500, 600, 700, 800, 900].map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <label className="inline">
              <input type="checkbox" checked={!!p.italic} onChange={(e) => props({ italic: e.target.checked })} /> Italique
            </label>
          </div>
          <div className="row">
            <label>Alignement</label>
            <div className="seg">
              {(["left", "center", "right"] as const).map((al) => (
                <button key={al} className={p.align === al ? "on" : ""} onClick={() => props({ align: al })}>
                  {al === "left" ? "⟸" : al === "center" ? "≡" : "⟹"}
                </button>
              ))}
            </div>
          </div>
          {R("props.fontSize", "Taille", { unit: "px", min: 1 })}
          {R("props.textColor", "Couleur", { kind: "color" })}
          {R("props.letterSpacing", "Interlettrage", { unit: "px", step: 0.5 })}
          {R("props.strokeWidth", "Contour", { unit: "px", min: 0, step: 0.5 })}
          {R("props.stroke", "Couleur contour", { kind: "color" })}
          <div className="row">
            <label>Animateur</label>
            <select value={p.textAnimator ?? "none"} onChange={(e) => props({ textAnimator: e.target.value })}>
              <option value="none">Aucun</option>
              <option value="typewriter">Machine à écrire</option>
              <option value="fade">Fondu par lettre</option>
              <option value="slide-up">Montée par lettre</option>
              <option value="scale">Échelle par lettre</option>
              <option value="wave">Vague</option>
            </select>
          </div>
          {p.textAnimator && p.textAnimator !== "none" && R("props.textProgress", "Progression", { unit: "%", min: 0, max: 100 })}
        </Section>
      )}

      {(layer.type === "shape" || layer.type === "solid") && (
        <Section title={layer.type === "shape" ? "Forme" : "Solide"}>
          {layer.type === "shape" && (
            <div className="row">
              <label>Type</label>
              <select value={p.shapeKind} onChange={(e) => props({ shapeKind: e.target.value })}>
                <option value="rectangle">Rectangle</option>
                <option value="ellipse">Ellipse</option>
                <option value="polygon">Polygone</option>
                <option value="star">Étoile</option>
                <option value="path">Tracé SVG</option>
              </select>
            </div>
          )}
          {R("props.width", "Largeur", { unit: "px" })}
          {R("props.height", "Hauteur", { unit: "px" })}
          {layer.type === "shape" && p.shapeKind === "rectangle" && R("props.cornerRadius", "Arrondi", { unit: "px", min: 0 })}
          {layer.type === "shape" && (p.shapeKind === "polygon" || p.shapeKind === "star") && (
            <div className="row">
              <label>Côtés / branches</label>
              <NumberField value={p.sides ?? 5} onChange={(v) => props({ sides: Math.round(v) })} min={3} max={64} precision={0} />
            </div>
          )}
          {layer.type === "shape" && p.shapeKind === "star" && R("props.innerRatio", "Rayon intérieur", { step: 0.01, min: 0, max: 1 })}
          {layer.type === "shape" && p.shapeKind === "path" && (
            <textarea placeholder="Données de tracé SVG (attribut d), ex. M0 0 L100 0 L50 100 Z" defaultValue={p.pathData} rows={3} onKeyDown={(e) => e.stopPropagation()} onBlur={(e) => props({ pathData: e.target.value })} />
          )}
          {layer.type === "shape" && (
            <label className="row inline">
              <input type="checkbox" checked={p.fillEnabled !== false} onChange={(e) => props({ fillEnabled: e.target.checked })} /> Remplissage
            </label>
          )}
          {R("props.fill", "Couleur", { kind: "color" })}
          {layer.type === "shape" && (
            <>
              <label className="row inline">
                <input type="checkbox" checked={!!p.strokeEnabled} onChange={(e) => props({ strokeEnabled: e.target.checked, ...(e.target.checked && !(p.strokeWidth?.value as number) ? { strokeWidth: 6 } : {}) })} /> Contour
              </label>
              {p.strokeEnabled && (
                <>
                  {R("props.stroke", "Couleur contour", { kind: "color" })}
                  {R("props.strokeWidth", "Épaisseur", { unit: "px", min: 0, step: 0.5 })}
                  {R("props.trimStart", "Début du tracé", { unit: "%", min: 0, max: 100 })}
                  {R("props.trimEnd", "Fin du tracé", { unit: "%", min: 0, max: 100 })}
                </>
              )}
            </>
          )}
        </Section>
      )}

      {(layer.type === "video" || layer.type === "audio") && (
        <Section title="Média">
          <div className="row">
            <label>Source</label>
            <span className="muted">{project.assets.find((a) => a.id === p.assetId)?.name ?? "—"}</span>
          </div>
          {R("props.volume", "Volume", { unit: "%", min: 0, max: 200 })}
          <label className="row inline">
            <input type="checkbox" checked={!!p.muted} onChange={(e) => props({ muted: e.target.checked })} /> Muet
          </label>
          <div className="row">
            <label>Vitesse</label>
            <NumberField value={p.playbackRate ?? 1} onChange={(v) => props({ playbackRate: v })} min={0.1} max={8} step={0.05} unit="×" />
          </div>
          <div className="row">
            <label>Décalage source</label>
            <NumberField value={p.mediaOffset ?? 0} onChange={(v) => props({ mediaOffset: Math.max(0, v) })} min={0} step={1 / comp.fps} unit="s" />
          </div>
        </Section>
      )}

      {layer.type === "particles" && (
        <Section title="Particules">
          <div className="row">
            <label>Émetteur</label>
            <select value={p.emitterShape} onChange={(e) => props({ emitterShape: e.target.value })}>
              <option value="point">Point</option>
              <option value="line">Ligne</option>
              <option value="circle">Disque</option>
            </select>
            <select value={p.particleShape} onChange={(e) => props({ particleShape: e.target.value })}>
              <option value="circle">Cercles</option>
              <option value="square">Carrés</option>
              <option value="star">Étoiles</option>
              <option value="spark">Étincelles</option>
            </select>
          </div>
          {R("props.emitterSize", "Taille émetteur", { unit: "px", min: 0 })}
          {R("props.rate", "Débit", { unit: "/s", min: 0 })}
          <div className="row">
            <label>Durée de vie</label>
            <NumberField value={p.lifetime ?? 2} onChange={(v) => props({ lifetime: v })} min={0.05} max={30} step={0.1} unit="s" />
          </div>
          {R("props.speed", "Vitesse", { unit: "px/s" })}
          {R("props.direction", "Direction", { unit: "°" })}
          {R("props.spread", "Dispersion", { unit: "°", min: 0, max: 360 })}
          {R("props.gravity", "Gravité", { unit: "px/s²" })}
          {R("props.particleSize", "Taille début", { unit: "px", min: 0 })}
          {R("props.particleSizeEnd", "Taille fin", { unit: "px", min: 0 })}
          {R("props.colorStart", "Couleur début", { kind: "color" })}
          {R("props.colorEnd", "Couleur fin", { kind: "color" })}
          <div className="row">
            <label>Graine</label>
            <NumberField value={p.seed ?? 1} onChange={(v) => props({ seed: Math.round(v) })} precision={0} />
          </div>
        </Section>
      )}

      {layer.type === "camera" && <Section title="Caméra">{R("props.zoom", "Zoom", { unit: "%", min: 1 })}</Section>}

      {layer.type === "composition" && (
        <Section title="Composition imbriquée">
          <div className="row">
            <button className="btn" onClick={() => safely(() => app.engine.setActiveComposition(p.compositionId!))}>
              Ouvrir « {project.compositions.find((c) => c.id === p.compositionId)?.name} »
            </button>
          </div>
        </Section>
      )}

      {layer.type !== "audio" && layer.type !== "null" && (
        <Section
          title={`Effets (${layer.effects.length})`}
          actions={
            <select
              className="add-select"
              value=""
              data-testid="add-effect"
              onChange={(e) => e.target.value && safely(() => app.engine.addEffect(layer.id, e.target.value))}
            >
              <option value="">+ Ajouter</option>
              {listEffectDefs().map((d) => (
                <option key={d.type} value={d.type}>
                  {d.label}
                </option>
              ))}
            </select>
          }
        >
          {layer.effects.length === 0 && <p className="hint">Aucun effet.</p>}
          {layer.effects.map((fx, i) => {
            const def = getEffectDef(fx.type);
            return (
              <div key={fx.id} className="effect">
                <div className="effect-head">
                  <input type="checkbox" checked={fx.enabled} onChange={(e) => safely(() => app.engine.updateEffect(layer.id, fx.id, { enabled: e.target.checked }))} title="Activer" />
                  <span className="grow">{def?.label ?? fx.type}</span>
                  <button className="mini" disabled={i === 0} onClick={() => safely(() => app.engine.moveEffect(layer.id, fx.id, i - 1))} title="Monter">
                    ↑
                  </button>
                  <button className="mini" disabled={i === layer.effects.length - 1} onClick={() => safely(() => app.engine.moveEffect(layer.id, fx.id, i + 1))} title="Descendre">
                    ↓
                  </button>
                  <button className="mini" onClick={() => safely(() => app.engine.removeEffect(layer.id, fx.id))} title="Supprimer">
                    <Icon name="trash" size={12} />
                  </button>
                </div>
                {def?.params.map((pd) => (
                  <AnimRow key={pd.key} layer={layer} path={`effects.${fx.id}.${pd.key}`} label={pd.label} time={time} kind={pd.kind} step={pd.step} min={pd.min} max={pd.max} />
                ))}
              </div>
            );
          })}
        </Section>
      )}

      {layer.type !== "audio" && layer.type !== "camera" && layer.type !== "null" && (
        <Section
          title={`Masques (${layer.masks.length})`}
          defaultOpen={layer.masks.length > 0}
          actions={
            <span className="seg small">
              <button onClick={() => safely(() => app.engine.addMask(layer.id, { shape: "rectangle" }))} title="Masque rectangulaire">
                ▭
              </button>
              <button onClick={() => safely(() => app.engine.addMask(layer.id, { shape: "ellipse" }))} title="Masque elliptique">
                ◯
              </button>
            </span>
          }
        >
          {layer.masks.map((m) => (
            <div key={m.id} className="effect">
              <div className="effect-head">
                <Icon name="mask" size={13} />
                <span className="grow">{m.name}</span>
                <select value={m.mode} onChange={(e) => safely(() => app.engine.updateMask(layer.id, m.id, { mode: e.target.value as "add" }))}>
                  <option value="add">Ajouter</option>
                  <option value="subtract">Soustraire</option>
                  <option value="intersect">Intersection</option>
                </select>
                <label className="inline">
                  <input type="checkbox" checked={m.inverted} onChange={(e) => safely(() => app.engine.updateMask(layer.id, m.id, { inverted: e.target.checked }))} /> Inv.
                </label>
                <button className="mini" onClick={() => safely(() => app.engine.removeMask(layer.id, m.id))}>
                  <Icon name="trash" size={12} />
                </button>
              </div>
              <div className="row">
                <label>X / Y</label>
                <NumberField value={m.x} onChange={(v) => safely(() => app.engine.updateMask(layer.id, m.id, { x: v }))} />
                <NumberField value={m.y} onChange={(v) => safely(() => app.engine.updateMask(layer.id, m.id, { y: v }))} />
              </div>
              <div className="row">
                <label>L / H</label>
                <NumberField value={m.width} onChange={(v) => safely(() => app.engine.updateMask(layer.id, m.id, { width: v }))} min={1} />
                <NumberField value={m.height} onChange={(v) => safely(() => app.engine.updateMask(layer.id, m.id, { height: v }))} min={1} />
              </div>
              <AnimRow layer={layer} path={`masks.${m.id}.feather`} label="Contour progressif" time={time} unit="px" min={0} />
              <AnimRow layer={layer} path={`masks.${m.id}.opacity`} label="Opacité" time={time} unit="%" min={0} max={100} />
            </div>
          ))}
        </Section>
      )}

      {layer.type !== "audio" && layer.type !== "camera" && (
        <Section title="Transitions" defaultOpen={!!(layer.transitionIn || layer.transitionOut)}>
          {(["transitionIn", "transitionOut"] as const).map((k) => (
            <div className="row" key={k}>
              <label>{k === "transitionIn" ? "Entrée" : "Sortie"}</label>
              <select value={layer[k]?.type ?? ""} onChange={(e) => upd({ [k]: e.target.value ? { type: e.target.value as TransitionType, duration: layer[k]?.duration ?? 0.5 } : null })} data-testid={`${k}-select`}>
                {TRANSITIONS.map((t) => (
                  <option key={t.v} value={t.v}>
                    {t.l}
                  </option>
                ))}
              </select>
              {layer[k] && <NumberField value={layer[k]!.duration} onChange={(v) => upd({ [k]: { ...layer[k]!, duration: Math.max(0.05, v) } })} min={0.05} max={10} step={0.05} unit="s" />}
            </div>
          ))}
        </Section>
      )}

      <Section title="Presets d'animation" defaultOpen={false}>
        <div className="preset-grid">
          {PRESETS.filter((pr) => (pr.category === "texte" ? layer.type === "text" : pr.category === "caméra" ? layer.type === "camera" : layer.type !== "camera")).map((pr) => (
            <button key={pr.id} className="chip" title={pr.description} onClick={() => safely(() => app.engine.applyPreset(layer.id, pr.id, pr.category === "sortie" ? undefined : Math.max(layer.inPoint, time)))}>
              {pr.label}
            </button>
          ))}
        </div>
      </Section>
    </div>
  );
}
