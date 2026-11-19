import { useEffect, useRef, useState } from "react";
import { listEffectDefs, PRESETS, type Asset } from "@amai/core";
import { app } from "../app/EditorApp";
import { fmtBytes, useApp, useProject, useSession } from "../app/hooks";
import { safely } from "./controls";
import { Icon } from "./Icon";

function Thumb({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void app.media.resolveUrl(asset).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [asset]);
  if (!url) return <div className="thumb" />;
  if (asset.kind === "image" || asset.kind === "svg") return <img className="thumb" src={url} alt="" draggable={false} />;
  if (asset.kind === "video") return <video className="thumb" src={url + "#t=0.1"} muted preload="metadata" />;
  return (
    <div className="thumb audio">
      <Icon name="audio" size={20} />
    </div>
  );
}

export function MediaLibrary() {
  const project = useProject();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="library" data-testid="media-library">
      <input ref={input} type="file" multiple hidden accept="video/*,image/*,audio/*,.svg" data-testid="media-input" onChange={(e) => e.target.files && void app.importFiles(e.target.files).then(() => (e.target.value = ""))} />
      <button className="btn primary block" onClick={() => input.current?.click()}>
        <Icon name="plus" /> Importer des médias
      </button>
      <p className="hint">Vidéos, images, sons et SVG — ou glissez-déposez vos fichiers sur la vue.</p>
      <div className="assets">
        {project.assets.map((a) => (
          <div key={a.id} className="asset" draggable onDoubleClick={() => safely(() => app.addAssetToTimeline(a))} title={`${a.name} — double-clic pour ajouter à la timeline`}>
            <Thumb asset={a} />
            <div className="asset-info">
              <span className="asset-name">{a.name}</span>
              <small>
                {a.kind.toUpperCase()} {a.width ? `· ${a.width}×${a.height}` : ""} {a.duration ? `· ${a.duration.toFixed(1)}s` : ""} · {fmtBytes(a.size)}
              </small>
            </div>
            <div className="asset-actions">
              <button className="mini" onClick={() => safely(() => app.addAssetToTimeline(a))} title="Ajouter à la timeline">
                <Icon name="plus" size={13} />
              </button>
              <button className="mini" onClick={() => safely(() => app.engine.removeAsset(a.id))} title="Retirer du projet">
                <Icon name="trash" size={12} />
              </button>
            </div>
          </div>
        ))}
        {!project.assets.length && <div className="empty">Aucun média importé.</div>}
      </div>
    </div>
  );
}

export function EffectsLibrary() {
  const session = useSession();
  const sel = session.selectedLayerIds;
  const defs = listEffectDefs();
  const cats = Array.from(new Set(defs.map((d) => d.category)));
  return (
    <div className="library">
      {!sel.length && <p className="hint">Sélectionnez un calque pour lui appliquer un effet.</p>}
      {cats.map((c) => (
        <div key={c} className="lib-group">
          <div className="lib-cat">{c}</div>
          {defs
            .filter((d) => d.category === c)
            .map((d) => (
              <button key={d.type} className="lib-item" disabled={!sel.length} title={d.description} onClick={() => safely(() => sel.forEach((id) => app.engine.addEffect(id, d.type)))} data-testid={`effect-${d.type}`}>
                <Icon name="wand" size={13} /> {d.label}
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}

export function PresetsLibrary() {
  const session = useSession();
  const sel = session.selectedLayerIds;
  const cats = Array.from(new Set(PRESETS.map((p) => p.category)));
  return (
    <div className="library">
      {!sel.length && <p className="hint">Sélectionnez un calque pour lui appliquer une animation.</p>}
      {cats.map((c) => (
        <div key={c} className="lib-group">
          <div className="lib-cat">{c}</div>
          {PRESETS.filter((p) => p.category === c).map((p) => (
            <button
              key={p.id}
              className="lib-item"
              disabled={!sel.length}
              title={p.description}
              data-testid={`preset-${p.id}`}
              onClick={() => safely(() => sel.forEach((id) => app.engine.applyPreset(id, p.id, p.category === "sortie" ? undefined : Math.max(app.engine.findLayer(id).layer.inPoint, session.currentTime))))}
            >
              <Icon name="sparkle" size={13} /> {p.label}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export function LibraryPanel() {
  const a = useApp();
  return (
    <div className="panel">
      <div className="tabs">
        {(
          [
            ["media", "Médias"],
            ["effects", "Effets"],
            ["presets", "Animations"],
          ] as const
        ).map(([k, l]) => (
          <button key={k} className={a.panelTab === k ? "on" : ""} onClick={() => app.set("panelTab", k)} data-testid={`tab-${k}`}>
            {l}
          </button>
        ))}
      </div>
      <div className="panel-body">{a.panelTab === "media" ? <MediaLibrary /> : a.panelTab === "effects" ? <EffectsLibrary /> : <PresetsLibrary />}</div>
    </div>
  );
}
