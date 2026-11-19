import { app } from "../app/EditorApp";
import { useProject } from "../app/hooks";
import { Icon } from "./Icon";

const SRC: Record<string, string> = { user: "Vous", ai: "IA", mcp: "MCP", system: "Système" };

export function HistoryPanel() {
  useProject();
  const { undo, redo } = app.engine.store.history();
  return (
    <div className="history" data-testid="history">
      <p className="hint">Cliquez sur une action pour revenir à l'état précédant celle-ci. Les actions de l'IA et des assistants MCP sont marquées.</p>
      {[...redo].map((e) => (
        <div key={`r${e.id}`} className="hist-item redo" onClick={() => {
          while (app.engine.store.canRedo()) {
            const r = app.engine.redo();
            if (!r || r.id === e.id) break;
          }
        }}>
          <span className={`src s-${e.source}`}>{SRC[e.source]}</span>
          <span className="grow">{e.label}</span>
          <Icon name="redo" size={12} />
        </div>
      ))}
      <div className="hist-now">● État actuel</div>
      {[...undo].reverse().map((e) => (
        <div key={e.id} className="hist-item" onClick={() => app.engine.store.undoUntil(e.id)} title={new Date(e.timestamp).toLocaleTimeString()}>
          <span className={`src s-${e.source}`}>{SRC[e.source]}</span>
          <span className="grow">{e.label}</span>
          <small>{new Date(e.timestamp).toLocaleTimeString()}</small>
        </div>
      ))}
      {!undo.length && !redo.length && <div className="empty">Aucune action pour l'instant.</div>}
    </div>
  );
}
