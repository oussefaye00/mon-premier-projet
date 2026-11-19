import { useEffect, useState } from "react";
import type { ExportOptions } from "@amai/core";
import { app } from "../app/EditorApp";
import { fmtBytes, useApp, useProject } from "../app/hooks";
import { db, storageEstimate, type StoredProject } from "../storage/db";
import { exportCapabilities, type ExportCapabilities } from "../export/exporter";
import { Modal, NumberField } from "./controls";
import { Icon } from "./Icon";

export function ExportDialog() {
  const a = useApp();
  const project = useProject();
  const comp = project.compositions.find((c) => c.id === project.activeCompositionId)!;
  const [caps, setCaps] = useState<ExportCapabilities | null>(null);
  const [opts, setOpts] = useState<ExportOptions>({ format: "mp4", quality: "high", includeAudio: true });
  const [res, setRes] = useState("comp");
  const [range, setRange] = useState<"all" | "custom">("all");
  useEffect(() => {
    void exportCapabilities().then((c) => {
      setCaps(c);
      if (!c.mp4 && c.webm) setOpts((o) => ({ ...o, format: "webm" }));
    });
  }, []);
  const st = a.exportState;
  const close = () => !st.running && app.set("dialogs", { ...a.dialogs, export: false });
  const resolutions: Record<string, [number, number] | null> = {
    comp: null,
    "2160": [Math.round((2160 * comp.width) / comp.height), 2160],
    "1080": [Math.round((1080 * comp.width) / comp.height), 1080],
    "720": [Math.round((720 * comp.width) / comp.height), 720],
    "480": [Math.round((480 * comp.width) / comp.height), 480],
  };
  const start = () => {
    const r = resolutions[res];
    const o: ExportOptions = { ...opts, ...(r ? { width: r[0], height: r[1] } : {}), ...(range === "all" ? { start: 0, end: comp.duration } : {}) };
    void app.runExport(o).catch(() => {});
  };
  return (
    <Modal title="Exporter la vidéo" onClose={close} testId="export-dialog">
      {!st.running && !st.result && (
        <>
          <div className="row">
            <label>Format</label>
            <div className="seg">
              <button className={opts.format === "mp4" ? "on" : ""} disabled={caps ? !caps.mp4 : false} onClick={() => setOpts({ ...opts, format: "mp4" })} data-testid="fmt-mp4">
                MP4 (H.264)
              </button>
              <button className={opts.format === "webm" ? "on" : ""} disabled={caps ? !caps.webm : false} onClick={() => setOpts({ ...opts, format: "webm" })} data-testid="fmt-webm">
                WebM (VP9)
              </button>
            </div>
          </div>
          {caps && (
            <p className="hint">
              Encodeurs détectés : {caps.mp4 ? `H.264 (${caps.mp4})` : "pas de H.264"} · {caps.webm ? `${caps.webm}` : "pas de VP9/VP8"} · audio {caps.audioMp4 ?? (caps.audioWebm ? "opus" : "indisponible")}
              {!caps.webcodecs && " — WebCodecs indisponible dans ce navigateur."}
            </p>
          )}
          <div className="row">
            <label>Résolution</label>
            <select value={res} onChange={(e) => setRes(e.target.value)}>
              <option value="comp">Composition ({comp.width}×{comp.height})</option>
              {Object.entries(resolutions)
                .filter(([k, v]) => k !== "comp" && v && v[1] !== comp.height)
                .map(([k, v]) => (
                  <option key={k} value={k}>
                    {k}p ({v![0]}×{v![1]})
                  </option>
                ))}
            </select>
          </div>
          <div className="row">
            <label>Images/s</label>
            <select value={opts.fps ?? comp.fps} onChange={(e) => setOpts({ ...opts, fps: +e.target.value })}>
              {Array.from(new Set([comp.fps, 24, 25, 30, 50, 60])).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
          <div className="row">
            <label>Qualité</label>
            <select value={opts.quality} onChange={(e) => setOpts({ ...opts, quality: e.target.value as "high" })}>
              <option value="high">Haute</option>
              <option value="medium">Moyenne</option>
              <option value="low">Légère</option>
            </select>
          </div>
          <div className="row">
            <label>Plage</label>
            <select value={range} onChange={(e) => setRange(e.target.value as "all")}>
              <option value="all">Toute la composition ({comp.duration}s)</option>
              <option value="custom">Personnalisée</option>
            </select>
          </div>
          {range === "custom" && (
            <div className="row">
              <label>De / à</label>
              <NumberField value={opts.start ?? 0} onChange={(v) => setOpts({ ...opts, start: v })} min={0} max={comp.duration} step={0.1} unit="s" />
              <NumberField value={opts.end ?? comp.duration} onChange={(v) => setOpts({ ...opts, end: v })} min={0} max={comp.duration} step={0.1} unit="s" />
            </div>
          )}
          <label className="row inline">
            <input type="checkbox" checked={opts.includeAudio !== false} onChange={(e) => setOpts({ ...opts, includeAudio: e.target.checked })} /> Inclure l'audio
          </label>
          {st.error && <p className="error-text">{st.error}</p>}
          <div className="modal-actions">
            <button className="btn" onClick={close}>
              Fermer
            </button>
            <button className="btn primary" onClick={start} disabled={!!caps && !caps[opts.format]} data-testid="start-export">
              <Icon name="export" /> Exporter
            </button>
          </div>
        </>
      )}
      {st.running && (
        <div className="export-progress">
          <p>{st.origin === "mcp" ? "Export demandé par un assistant externe (MCP)…" : "Rendu et encodage en cours…"}</p>
          <div className="progress">
            <div style={{ width: `${Math.round(st.progress * 100)}%` }} />
          </div>
          <p className="muted" data-testid="export-progress">
            {Math.round(st.progress * 100)} %
          </p>
          <button className="btn" onClick={() => app.cancelExport()}>
            Annuler
          </button>
        </div>
      )}
      {!st.running && st.result && (
        <div className="export-result" data-testid="export-result">
          <video src={st.result.url} controls playsInline />
          <p>
            <b>{st.result.fileName}</b> · {fmtBytes(st.result.size)} · {st.result.codec}
          </p>
          {st.result.warnings.map((w) => (
            <p key={w} className="warn-text">
              ⚠ {w}
            </p>
          ))}
          <div className="modal-actions">
            <button className="btn" onClick={() => app.set("exportState", { running: false, progress: 0 })}>
              Nouvel export
            </button>
            <a className="btn primary" href={st.result.url} download={st.result.fileName} data-testid="download-export">
              <Icon name="export" /> Télécharger
            </a>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function SettingsDialog() {
  const a = useApp();
  const s = a.settings;
  const [key, setKey] = useState(s.apiKey);
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => void storageEstimate().then(setUsage), []);
  const close = () => app.set("dialogs", { ...a.dialogs, settings: false });
  return (
    <Modal title="Paramètres" onClose={close} testId="settings-dialog">
      <h4>Assistant IA</h4>
      <div className="row">
        <label>Moteur</label>
        <div className="seg">
          <button className={s.aiMode === "local" ? "on" : ""} onClick={() => app.saveSettings({ aiMode: "local" })}>
            Local (hors-ligne)
          </button>
          <button className={s.aiMode === "claude" ? "on" : ""} onClick={() => app.saveSettings({ aiMode: "claude" })} data-testid="ai-mode-claude">
            Claude (API)
          </button>
        </div>
      </div>
      {s.aiMode === "claude" && (
        <>
          <div className="row">
            <label>Clé API</label>
            <input type="password" value={key} placeholder="sk-ant-…" onChange={(e) => setKey(e.target.value)} onBlur={() => app.saveSettings({ apiKey: key.trim() })} onKeyDown={(e) => e.stopPropagation()} />
          </div>
          <p className="hint">La clé est stockée uniquement dans ce navigateur (IndexedDB) et envoyée directement à l'API Anthropic.</p>
          <div className="row">
            <label>Modèle</label>
            <select value={s.model} onChange={(e) => app.saveSettings({ model: e.target.value })}>
              <option value="claude-opus-5-5">Claude Opus 5.5</option>
              <option value="claude-sonnet-5-5">Claude Sonnet 5.5</option>
              <option value="claude-haiku-5-5">Claude Haiku 5.5</option>
              <option value="claude-fable-5-2">Claude Fable 5.2</option>
            </select>
          </div>
          <div className="row">
            <label>Effort</label>
            <select value={s.effort} onChange={(e) => app.saveSettings({ effort: e.target.value as "medium" })}>
              {["low", "medium", "high", "xhigh", "max"].map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
        </>
      )}
      <label className="row inline">
        <input type="checkbox" checked={s.confirmAIPlans} onChange={(e) => app.saveSettings({ confirmAIPlans: e.target.checked })} /> Assistant local : montrer le plan avant de l'appliquer
      </label>
      <h4>Prévisualisation</h4>
      <label className="row inline">
        <input type="checkbox" checked={s.motionBlurPreview} onChange={(e) => app.saveSettings({ motionBlurPreview: e.target.checked })} /> Motion blur dans l'aperçu
      </label>
      <h4>Sauvegarde</h4>
      <div className="row">
        <label>Autosauvegarde</label>
        <select value={s.autosaveSeconds} onChange={(e) => app.saveSettings({ autosaveSeconds: +e.target.value })}>
          <option value={1}>Après chaque modification (1 s)</option>
          <option value={5}>Toutes les 5 s</option>
          <option value={30}>Toutes les 30 s</option>
        </select>
      </div>
      {usage && (
        <p className="hint">
          Stockage local utilisé : {fmtBytes(usage.usage)} / {fmtBytes(usage.quota)}
        </p>
      )}
      <h4>Raccourcis clavier</h4>
      <ul className="shortcuts">
        <li><kbd>Espace</kbd> lecture/pause · <kbd>←</kbd>/<kbd>→</kbd> image (Maj : 1 s) · <kbd>Début</kbd>/<kbd>Fin</kbd></li>
        <li><kbd>Ctrl</kbd>+<kbd>Z</kbd> annuler · <kbd>Ctrl</kbd>+<kbd>Maj</kbd>+<kbd>Z</kbd> rétablir · <kbd>Ctrl</kbd>+<kbd>D</kbd> dupliquer · <kbd>Suppr</kbd></li>
        <li><kbd>S</kbd> découper · <kbd>K</kbd> keyframes position/échelle/rotation/opacité · <kbd>V</kbd> <kbd>H</kbd> <kbd>T</kbd> <kbd>R</kbd> <kbd>E</kbd> outils</li>
      </ul>
      <div className="modal-actions">
        <button className="btn primary" onClick={close}>
          Fermer
        </button>
      </div>
    </Modal>
  );
}

export function NewProjectDialog() {
  const a = useApp();
  const [o, setO] = useState({ name: "Nouveau projet", width: 1920, height: 1080, fps: 30, duration: 10, background: "#101014" });
  const close = () => app.set("dialogs", { ...a.dialogs, newProject: false });
  const presets: [string, number, number][] = [
    ["YouTube 1080p", 1920, 1080],
    ["4K", 3840, 2160],
    ["Reels / TikTok 9:16", 1080, 1920],
    ["Instagram carré", 1080, 1080],
    ["Instagram portrait 4:5", 1080, 1350],
    ["720p", 1280, 720],
  ];
  return (
    <Modal title="Nouveau projet" onClose={close} testId="new-project-dialog">
      <div className="row">
        <label>Nom</label>
        <input value={o.name} onChange={(e) => setO({ ...o, name: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="preset-grid">
        {presets.map(([n, w, h]) => (
          <button key={n} className={`chip ${o.width === w && o.height === h ? "on" : ""}`} onClick={() => setO({ ...o, width: w, height: h })}>
            {n} <small>{w}×{h}</small>
          </button>
        ))}
      </div>
      <div className="row">
        <label>Taille</label>
        <NumberField value={o.width} onChange={(v) => setO({ ...o, width: Math.round(v) })} min={16} max={7680} precision={0} unit="px" />
        <NumberField value={o.height} onChange={(v) => setO({ ...o, height: Math.round(v) })} min={16} max={7680} precision={0} unit="px" />
      </div>
      <div className="row">
        <label>FPS</label>
        <select value={o.fps} onChange={(e) => setO({ ...o, fps: +e.target.value })}>
          {[24, 25, 30, 50, 60].map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <label>Durée</label>
        <NumberField value={o.duration} onChange={(v) => setO({ ...o, duration: v })} min={0.5} max={3600} unit="s" />
      </div>
      <div className="modal-actions">
        <button className="btn" onClick={close}>
          Annuler
        </button>
        <button
          className="btn primary"
          data-testid="create-project"
          onClick={() => {
            void app.newProject(o).then(() => app.toast(`Projet « ${o.name} » créé. Le précédent reste dans « Projets ».`, "success"));
            close();
          }}
        >
          Créer
        </button>
      </div>
    </Modal>
  );
}

export function ProjectsDialog() {
  const a = useApp();
  const current = useProject();
  const [list, setList] = useState<StoredProject[]>([]);
  const [snaps, setSnaps] = useState<{ savedAt: number; key: string }[]>([]);
  const refresh = () => {
    void db.listProjects().then((l) => setList(l.sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))));
    void db.listSnapshots(current.id).then((s) => setSnaps(s.sort((x, y) => y.savedAt - x.savedAt)));
  };
  useEffect(refresh, [current.id]);
  const close = () => app.set("dialogs", { ...a.dialogs, projects: false });
  return (
    <Modal title="Projets" onClose={close} wide testId="projects-dialog">
      <h4>Projets enregistrés sur cet appareil</h4>
      <div className="project-list">
        {list.map((p) => (
          <div key={p.id} className={`list-item ${p.id === current.id ? "active" : ""}`}>
            <Icon name="film" />
            <span className="grow">
              {p.name} <small>· {new Date(p.updatedAt).toLocaleString()} · {p.project.compositions[0]?.width}×{p.project.compositions[0]?.height}</small>
            </span>
            {p.id !== current.id && (
              <>
                <button className="btn" onClick={() => void app.openProject(p.project).then(close)}>
                  Ouvrir
                </button>
                <button className="mini" title="Supprimer" onClick={() => confirm(`Supprimer « ${p.name} » ?`) && void db.deleteProject(p.id).then(refresh)}>
                  <Icon name="trash" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <h4>Versions de récupération du projet actuel</h4>
      <p className="hint">Une version est conservée automatiquement toutes les 30 secondes d'édition (10 dernières).</p>
      <div className="project-list">
        {snaps.map((s) => (
          <div key={s.key} className="list-item">
            <Icon name="history" />
            <span className="grow">{new Date(s.savedAt).toLocaleString()}</span>
            <button className="btn" onClick={() => void db.listSnapshots(current.id).then((all) => { const x = all.find((y) => y.key === s.key); if (x) void app.restoreSnapshot(x).then(close); })}>
              Restaurer
            </button>
          </div>
        ))}
        {!snaps.length && <div className="empty">Aucune version pour l'instant.</div>}
      </div>
    </Modal>
  );
}

export function RecoveryBanner() {
  const a = useApp();
  if (!a.recovery) return null;
  return (
    <div className="recovery" data-testid="recovery-banner">
      <Icon name="history" /> L'application ne s'est pas fermée correctement : votre projet a été récupéré depuis la dernière sauvegarde automatique.
      {a.recovery.snapshots.length > 0 && (
        <button className="btn" onClick={() => app.set("dialogs", { ...a.dialogs, projects: true })}>
          Voir les versions
        </button>
      )}
      <button className="icon-btn" onClick={() => app.set("recovery", null)}>
        <Icon name="close" />
      </button>
    </div>
  );
}

export function ApprovalDialog() {
  const a = useApp();
  const req = a.approvals[0];
  if (!req) return null;
  return (
    <div className="modal-backdrop approval">
      <div className="modal" role="alertdialog" data-testid="approval-dialog">
        <div className="modal-head">
          <span>
            <Icon name={req.origin === "mcp" ? "plug" : "sparkle"} /> Autorisation requise — {req.origin === "mcp" ? "assistant externe (MCP)" : "assistant IA"}
          </span>
        </div>
        <div className="modal-body">
          <p>{req.summary}</p>
          <p>
            Action : <code>{req.tool}</code>
          </p>
          <pre className="code small">{JSON.stringify(req.args, (k, v) => (typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v), 2)}</pre>
          <div className="modal-actions">
            <button className="btn" onClick={() => req.resolve(false)} data-testid="approval-deny">
              Refuser
            </button>
            <button className="btn primary" onClick={() => req.resolve(true)} data-testid="approval-allow">
              Autoriser
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const a = useApp();
  return (
    <div className="toasts">
      {a.toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
