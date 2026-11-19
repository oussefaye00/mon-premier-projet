import { useState } from "react";
import { app } from "../app/EditorApp";
import { useApp } from "../app/hooks";
import { Icon } from "./Icon";

const LABEL: Record<string, string> = { connected: "Connecté", connecting: "Connexion…", disconnected: "Déconnecté", rejected: "Refusé" };

export function MCPPanel() {
  const a = useApp();
  const [url, setUrl] = useState(a.settings.bridgeUrl);
  const [token, setToken] = useState(a.settings.bridgeToken);
  const config = JSON.stringify({ mcpServers: { "after-motion-ai": { command: "node", args: ["<chemin>/packages/mcp-server/dist/index.js"] } } }, null, 2);
  return (
    <div className="mcp-panel" data-testid="mcp-panel">
      <div className={`mcp-status ${a.bridgeStatus}`}>
        <span className="dot" /> {LABEL[a.bridgeStatus]} {a.bridgeDetail && <small>— {a.bridgeDetail}</small>}
      </div>
      <p className="hint">
        Le serveur MCP permet à Claude Desktop (ou tout client MCP) de piloter le projet ouvert ici. Les actions sensibles (nouveau projet, suppression, import, export) vous seront soumises pour accord.
      </p>
      <div className="row">
        <label>Adresse</label>
        <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      <div className="row">
        <label>Jeton</label>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="after-motion-mcp --print-token" onKeyDown={(e) => e.stopPropagation()} data-testid="bridge-token" />
      </div>
      <div className="row">
        {a.bridgeStatus === "connected" || a.bridgeStatus === "connecting" ? (
          <button className="btn" onClick={() => app.disconnectBridge()}>
            Déconnecter
          </button>
        ) : (
          <button
            className="btn primary"
            data-testid="bridge-connect"
            onClick={() => {
              app.saveSettings({ bridgeUrl: url, bridgeToken: token });
              app.connectBridge();
            }}
          >
            <Icon name="plug" /> Connecter
          </button>
        )}
      </div>
      <details>
        <summary>Configurer Claude Desktop</summary>
        <p className="hint">Ajoutez ceci à claude_desktop_config.json puis redémarrez Claude Desktop. Ouvrez ensuite l'éditeur via l'adresse affichée par le serveur (http://127.0.0.1:7823/) : la connexion est automatique.</p>
        <pre className="code">{config}</pre>
      </details>
      <div className="activity-title">Activité des assistants externes</div>
      <div className="activity">
        {a.activity.map((e, i) => (
          <div key={i} className={`act ${e.ok ? "ok" : "ko"}`}>
            <span className="time">{new Date(e.at).toLocaleTimeString()}</span>
            <span className="tool-tag">{e.tool}</span>
            <span className="grow act-msg" title={e.message}>{e.ok ? "" : e.message}</span>
            {e.ok && e.historyEntryId && app.engine.store.history().undo.some((h) => h.id === e.historyEntryId) && (
              <button className="mini" onClick={() => app.engine.store.undoUntil(e.historyEntryId!)} title="Annuler cette action (et les suivantes)">
                <Icon name="undo" size={12} />
              </button>
            )}
          </div>
        ))}
        {!a.activity.length && <div className="empty">Aucune action reçue.</div>}
      </div>
    </div>
  );
}
