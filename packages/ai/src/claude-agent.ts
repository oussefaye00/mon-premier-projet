import Anthropic from "@anthropic-ai/sdk";
import { executeTool, getTool, TOOLS, toolJsonSchema, type EditorEngine, type EditorHost, type HistoryEntry, type PreviewResult } from "@amai/core";
import type { ApprovalFn } from "./executor";

/**
 * Connecteur IA : assistant Claude intégré à l'éditeur.
 *
 * Claude reçoit le même catalogue d'outils que le serveur MCP et agit directement sur
 * le projet ouvert. Toutes ses modifications d'un même tour sont regroupées en une seule
 * entrée d'historique (source « ai »), présentée à l'utilisateur et annulable en un clic.
 */

export const DEFAULT_MODEL = "claude-opus-5-5";

export interface ClaudeAgentOptions {
  apiKey: string;
  model?: string;
  /** Effort de raisonnement (le défaut de Claude Opus 5.5 est "medium"). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxIterations?: number;
  /** Navigateur : autorise l'appel direct à l'API avec la clé de l'utilisateur. */
  browser?: boolean;
  baseURL?: string;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; name: string; ok: boolean; summary: string }
  | { type: "error"; message: string }
  | { type: "done"; historyEntry: HistoryEntry | null; stopReason: string };

const SYSTEM_PROMPT = `Tu es l'assistant de motion design intégré à AFTER MOTION AI, un éditeur vidéo et de motion design (inspiré d'After Effects et d'Alight Motion).
Tu agis directement sur le projet ouvert de l'utilisateur via les outils fournis. Chaque modification que tu fais est visible par l'utilisateur et annulable.

Méthode :
- Si nécessaire, lis d'abord l'état (get_timeline, get_layer) avant de modifier.
- Préfère les presets (create_animation) pour les animations standards, et add_keyframes pour des animations sur mesure (plusieurs keyframes avec courbes : expoOut, backOut, easeInOut, bounce…).
- Coordonnées en pixels de composition, origine en haut à gauche ; le contenu d'un calque est centré sur sa position. Échelle et opacité en %, rotation en degrés, temps en secondes.
- « ce texte », « ce calque » désignent la sélection courante indiquée dans le contexte.
- Pour un mouvement de caméra, utilise un calque de type camera (sa position est le point visé, props.zoom en %).
- Tu peux vérifier visuellement avec get_preview.
- N'utilise pas create_project, delete_layer, import_media ni export_video sans que l'utilisateur l'ait clairement demandé.
- Réponds en français (ou dans la langue de l'utilisateur), en résumant brièvement ce que tu as modifié.`;

function contextBlock(engine: EditorEngine): string {
  const tl = engine.getTimeline();
  const sel = engine.session.selectedLayerIds;
  return [
    `Contexte du projet (au moment de la demande) :`,
    `Composition « ${tl.name} » ${tl.width}×${tl.height} @ ${tl.fps} i/s, durée ${tl.duration}s, temps courant ${tl.currentTime}s.`,
    `Sélection : ${sel.length ? sel.join(", ") : "aucune"}.`,
    `Calques (du dessus vers le dessous) :`,
    ...tl.layers.map(
      (l) =>
        `- ${l.id} « ${l.name} » [${l.type}] ${l.inPoint}s→${l.outPoint}s${l.text ? ` texte="${l.text}"` : ""}${l.effects.length ? ` effets=${l.effects.map((e) => e.type).join("/")}` : ""}${l.animatedProperties.length ? ` animé=${l.animatedProperties.join("/")}` : ""}`,
    ),
    tl.layers.length ? "" : "(aucun calque)",
  ].join("\n");
}

function summarize(result: unknown): string {
  const s = JSON.stringify(result);
  return s.length > 160 ? s.slice(0, 157) + "…" : s;
}

export class ClaudeAgent {
  private client: Anthropic;
  private history: Anthropic.Beta.BetaMessageParam[] = [];

  constructor(private engine: EditorEngine, private opts: ClaudeAgentOptions, private host?: EditorHost, private approve?: ApprovalFn) {
    this.client = new Anthropic({ apiKey: opts.apiKey, dangerouslyAllowBrowser: opts.browser ?? true, baseURL: opts.baseURL });
  }

  /** Oublie la conversation (le projet n'est pas modifié). */
  reset() {
    this.history = [];
  }

  private tools(): Anthropic.Beta.BetaTool[] {
    return TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: toolJsonSchema(t as any) as Anthropic.Beta.BetaTool["input_schema"],
    }));
  }

  /** Envoie une demande et exécute la boucle d'outils jusqu'à la réponse finale. */
  async send(userText: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    const messages = this.history;
    messages.push({ role: "user", content: [{ type: "text", text: `${contextBlock(this.engine)}\n\nDemande : ${userText}` }] });
    const maxIter = this.opts.maxIterations ?? 16;
    let stopReason = "end_turn";
    const { entry } = await this.engine.store.batch(`IA (Claude) : ${userText.slice(0, 80)}`, "ai", async () => {
      for (let iter = 0; iter < maxIter; iter++) {
        if (signal?.aborted) {
          stopReason = "aborted";
          return;
        }
        let response: Anthropic.Beta.BetaMessage;
        try {
          response = await this.client.beta.messages.create(
            {
              model: this.opts.model ?? DEFAULT_MODEL,
              max_tokens: 16000,
              system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
              tools: this.tools(),
              messages,
              output_config: { effort: this.opts.effort ?? "medium" },
              betas: ["server-side-fallback-2026-07-01"],
              fallbacks: "default",
            },
            { signal },
          );
        } catch (e) {
          stopReason = "error";
          const msg =
            e instanceof Anthropic.AuthenticationError
              ? "Clé API refusée. Vérifiez-la dans les paramètres."
              : e instanceof Anthropic.RateLimitError
                ? "Limite de requêtes atteinte, réessayez dans un instant."
                : e instanceof Anthropic.APIError
                  ? `Erreur API (${e.status ?? "réseau"}) : ${e.message}`
                  : (e as Error).message;
          onEvent({ type: "error", message: msg });
          // On retire la dernière demande si aucune réponse n'a été obtenue, pour garder un historique valide.
          if (messages[messages.length - 1]?.role === "user" && iter === 0) messages.pop();
          return;
        }
        messages.push({ role: "assistant", content: response.content as Anthropic.Beta.BetaContentBlockParam[] });
        for (const b of response.content) if (b.type === "text" && b.text.trim()) onEvent({ type: "text", text: b.text });
        stopReason = response.stop_reason ?? "end_turn";
        if (response.stop_reason === "refusal") {
          onEvent({ type: "error", message: "La demande a été refusée par le modèle." });
          return;
        }
        if (response.stop_reason === "pause_turn") continue;
        if (response.stop_reason !== "tool_use") return;

        const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
        for (const b of response.content) {
          if (b.type !== "tool_use") continue;
          onEvent({ type: "tool_call", id: b.id, name: b.name, input: b.input });
          let outcome;
          let sensitive = false;
          try {
            sensitive = !!getTool(b.name).sensitive;
          } catch {
            /* outil inconnu : executeTool renverra l'erreur */
          }
          if (sensitive && this.approve && !(await this.approve(b.name, b.input as Record<string, unknown>, `Claude souhaite exécuter ${b.name}`))) {
            outcome = { ok: false, error: { code: "denied", message: "L'utilisateur a refusé cette action." } };
          } else {
            outcome = await executeTool({ engine: this.engine, host: this.host, source: "ai" }, b.name, b.input);
          }
          onEvent({ type: "tool_result", id: b.id, name: b.name, ok: outcome.ok, summary: outcome.ok ? summarize(outcome.result) : outcome.error!.message });
          if (outcome.ok && b.name === "get_preview") {
            const p = outcome.result as PreviewResult;
            results.push({
              type: "tool_result",
              tool_use_id: b.id,
              content: [
                { type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } },
                { type: "text", text: `Aperçu ${p.width}×${p.height} à t=${p.time}s` },
              ],
            });
          } else {
            results.push({
              type: "tool_result",
              tool_use_id: b.id,
              content: JSON.stringify(outcome.ok ? outcome.result : outcome.error),
              is_error: !outcome.ok,
            });
          }
        }
        messages.push({ role: "user", content: results });
      }
      stopReason = "max_iterations";
      onEvent({ type: "error", message: "Nombre maximal d'étapes atteint : la demande a été interrompue." });
    });
    onEvent({ type: "done", historyEntry: entry, stopReason });
  }
}
