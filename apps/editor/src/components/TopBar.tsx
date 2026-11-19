import { useRef } from "react";
import { app } from "../app/EditorApp";
import { useApp, useProject } from "../app/hooks";
import { Icon } from "./Icon";

export function TopBar() {
  const a = useApp();
  const project = useProject();
  const fileRef = useRef<HTMLInputElement>(null);
  const st = a.bridgeStatus;
  const saved = a.lastSavedAt ? new Date(a.lastSavedAt).toLocaleTimeString() : null;
  return (
    <header className="topbar">
      <div className="brand">
        <img src="/icon.svg" alt="" width={22} height={22} />
        <span className="brand-name">
          AFTER MOTION <b>AI</b>
        </span>
      </div>
      <nav className="menu">
        <button onClick={() => app.set("dialogs", { ...a.dialogs, newProject: true })} title="Nouveau projet">
          <Icon name="plus" /> <span className="lbl">Nouveau</span>
        </button>
        <button onClick={() => app.set("dialogs", { ...a.dialogs, projects: true })} title="Projets enregistrés et récupération">
          <Icon name="folder" /> <span className="lbl">Projets</span>
        </button>
        <input ref={fileRef} type="file" accept=".json,.amai.json,application/json" hidden onChange={(e) => e.target.files?.[0] && void app.openProjectFile(e.target.files[0]).catch((err) => app.toast(err.message, "error"))} />
        <button onClick={() => void app.downloadProjectFile()} title="Enregistrer le projet dans un fichier .amai.json (médias inclus)">
          <Icon name="save" /> <span className="lbl">Enregistrer</span>
        </button>
        <button onClick={() => fileRef.current?.click()} title="Ouvrir un fichier projet">
          <Icon name="folder" /> <span className="lbl">Ouvrir</span>
        </button>
        <span className="sep" />
        <button disabled={!app.engine.store.canUndo()} onClick={() => app.engine.undo()} title="Annuler (Ctrl+Z)" data-testid="undo">
          <Icon name="undo" />
        </button>
        <button disabled={!app.engine.store.canRedo()} onClick={() => app.engine.redo()} title="Rétablir (Ctrl+Maj+Z)" data-testid="redo">
          <Icon name="redo" />
        </button>
      </nav>
      <div className="project-name" title={saved ? `Sauvegarde automatique : ${saved}` : ""}>
        <input
          key={project.name}
          defaultValue={project.name}
          onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && app.engine.renameProject(e.target.value.trim())}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        <small>{saved ? `✓ enregistré ${saved}` : "…"}</small>
      </div>
      <div className="top-right">
        <button className={`mcp-pill ${st}`} onClick={() => app.set("sideTab", "mcp")} title="Serveur MCP (assistants externes)" data-testid="mcp-status">
          <Icon name="plug" size={14} /> <span className="lbl">MCP</span> <span className="dot" />
        </button>
        <button className="btn ai-btn" onClick={() => { app.set("sideTab", "ai"); app.set("mobileTab", "ai"); }} title="Assistant IA">
          <Icon name="sparkle" /> <span className="lbl">Assistant IA</span>
        </button>
        <button className="btn primary" onClick={() => app.set("dialogs", { ...a.dialogs, export: true })} data-testid="open-export">
          <Icon name="export" /> <span className="lbl">Exporter</span>
        </button>
        <button className="icon-btn" onClick={() => app.set("dialogs", { ...a.dialogs, settings: true })} title="Paramètres" data-testid="open-settings">
          <Icon name="settings" />
        </button>
      </div>
    </header>
  );
}
