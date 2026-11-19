import { useEffect, useRef, useState } from "react";
import { app, type ChatMessage } from "../app/EditorApp";
import { useApp } from "../app/hooks";
import { Icon } from "./Icon";

const SUGGESTIONS = [
  "Anime ce texte avec une apparition fluide.",
  "Crée une animation professionnelle de logo.",
  "Ajoute un effet de caméra dynamique.",
  "Fais apparaître ce texte avec un effet de rebond.",
  "Ajoute des transitions entre mes clips.",
  "Crée une animation de particules.",
  "Optimise les animations de ce projet.",
  'Écris le titre "Bienvenue" en jaune avec une lueur',
];

const TOOL_LABEL: Record<string, string> = {
  create_text: "Créer un texte",
  create_layer: "Créer un calque",
  create_animation: "Animer",
  apply_effect: "Effet",
  add_keyframe: "Keyframe",
  add_keyframes: "Keyframes",
  update_layer: "Modifier",
  set_property: "Propriété",
  update_composition: "Composition",
  add_transitions_between_clips: "Transitions",
  optimize_animations: "Optimisation",
  get_timeline: "Lecture de la timeline",
  get_layer: "Lecture d'un calque",
  get_preview: "Aperçu",
};

function Message({ m }: { m: ChatMessage }) {
  const a = useApp();
  return (
    <div className={`msg ${m.role} ${m.error ? "error" : ""}`} data-testid={`msg-${m.role}`}>
      {m.text && <div className="msg-text">{m.text}</div>}
      {m.plan && m.plan.steps.length > 0 && (
        <ol className="plan">
          {m.plan.steps.map((s, i) => {
            const outcome = m.steps?.[i]?.outcome;
            return (
              <li key={i} className={outcome ? (outcome.ok ? "ok" : "ko") : ""}>
                <span className="tool-tag">{TOOL_LABEL[s.tool] ?? s.tool}</span> {s.description}
                {outcome && !outcome.ok && <div className="err">{outcome.error?.message}</div>}
              </li>
            );
          })}
        </ol>
      )}
      {m.tools && m.tools.length > 0 && (
        <ul className="plan">
          {m.tools.map((t, i) => (
            <li key={i} className={t.ok === undefined ? "run" : t.ok ? "ok" : "ko"} title={t.summary}>
              <span className="tool-tag">{TOOL_LABEL[t.name] ?? t.name}</span> {t.ok === false ? t.summary : ""}
            </li>
          ))}
        </ul>
      )}
      {m.planState === "pending" && (
        <div className="msg-actions">
          <button className="btn primary" disabled={a.aiBusy} onClick={() => void app.applyPlan(m.id)} data-testid="apply-plan">
            <Icon name="check" /> Appliquer
          </button>
          <button className="btn" onClick={() => app.cancelPlan(m.id)}>
            Ignorer
          </button>
        </div>
      )}
      {m.planState === "applied" && m.historyEntryId && (
        <div className="msg-actions">
          <span className="ok-tag">✓ Appliqué</span>
          <button className="btn" onClick={() => app.undoAIChange(m.id)} data-testid="undo-ai">
            <Icon name="undo" /> Annuler ces modifications
          </button>
        </div>
      )}
      {m.planState === "undone" && <div className="msg-actions muted">↶ Modifications annulées</div>}
      {m.planState === "cancelled" && <div className="msg-actions muted">Plan ignoré</div>}
    </div>
  );
}

export function AIPanel() {
  const a = useApp();
  const [text, setText] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [a.chat]);
  const claude = a.settings.aiMode === "claude" && !!a.settings.apiKey;
  const send = () => {
    if (!text.trim()) return;
    void app.sendToAI(text);
    setText("");
  };
  return (
    <div className="ai-panel" data-testid="ai-panel">
      <div className="ai-mode">
        <span className={`mode ${claude ? "claude" : "local"}`}>{claude ? `Claude · ${a.settings.model}` : "Assistant local (hors-ligne)"}</span>
        <button className="link" onClick={() => app.set("dialogs", { ...a.dialogs, settings: true })}>
          {claude ? "Paramètres" : "Activer Claude"}
        </button>
        {a.chat.length > 0 && (
          <button className="link" onClick={() => app.clearChat()}>
            Effacer
          </button>
        )}
      </div>
      <div className="chat" ref={listRef}>
        {a.chat.length === 0 && (
          <div className="ai-welcome">
            <Icon name="sparkle" size={28} />
            <p>Décrivez ce que vous voulez créer. L'assistant modifie directement votre projet ; chaque modification est présentée et annulable.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => void app.sendToAI(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {a.chat.map((m) => (
          <Message key={m.id} m={m} />
        ))}
        {a.aiBusy && <div className="msg assistant typing">…</div>}
      </div>
      <div className="ai-input">
        <textarea
          data-testid="ai-input"
          value={text}
          placeholder="Ex. : Fais apparaître ce texte avec un rebond en 1 seconde"
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn primary" onClick={send} disabled={a.aiBusy || !text.trim()} data-testid="ai-send" aria-label="Envoyer">
          <Icon name="send" />
        </button>
      </div>
    </div>
  );
}
