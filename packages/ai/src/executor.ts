import { executeTool, getTool, type EditorEngine, type EditorHost, type HistoryEntry, type ToolCallOutcome } from "@amai/core";
import type { Plan } from "./local-planner";

export interface StepOutcome {
  tool: string;
  args: Record<string, unknown>;
  description: string;
  outcome: ToolCallOutcome;
}

export interface ExecutionReport {
  steps: StepOutcome[];
  ok: boolean;
  /** Entrée d'historique unique regroupant toutes les modifications (annulable d'un clic). */
  historyEntry: HistoryEntry | null;
}

export type ApprovalFn = (tool: string, args: Record<string, unknown>, description: string) => Promise<boolean>;

function createdId(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const r = result as Record<string, unknown>;
  return (r.id ?? r.layerId ?? r.newLayerId) as string | undefined;
}

function resolveRefs(v: unknown, created: (string | undefined)[]): unknown {
  if (typeof v === "string") {
    const m = v.match(/^\$step:(\d+)$/);
    if (m) {
      const id = created[parseInt(m[1])];
      if (!id) throw new Error(`L'étape ${m[1]} n'a pas créé de calque.`);
      return id;
    }
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => resolveRefs(x, created));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveRefs(x, created)]));
  return v;
}

/**
 * Exécute un plan de l'assistant dans une transaction unique (source « ai »).
 * Si une étape échoue, toutes les modifications du plan sont annulées.
 */
export async function executePlan(engine: EditorEngine, plan: Plan, opts: { host?: EditorHost; approve?: ApprovalFn; label?: string } = {}): Promise<ExecutionReport> {
  const steps: StepOutcome[] = [];
  const created: (string | undefined)[] = [];
  try {
    const { entry } = await engine.store.batch(opts.label ?? `IA : ${plan.steps.map((s) => s.description).join(" · ").slice(0, 120)}`, "ai", async () => {
      for (const s of plan.steps) {
        const args = resolveRefs(s.args, created) as Record<string, unknown>;
        if (getTool(s.tool).sensitive && opts.approve && !(await opts.approve(s.tool, args, s.description))) {
          const outcome: ToolCallOutcome = { ok: false, error: { code: "denied", message: "Refusé par l'utilisateur." } };
          steps.push({ ...s, args, outcome });
          throw Object.assign(new Error("denied"), { report: true });
        }
        const outcome = await executeTool({ engine, host: opts.host, source: "ai" }, s.tool, args);
        steps.push({ ...s, args, outcome });
        created.push(outcome.ok ? createdId(outcome.result) : undefined);
        if (!outcome.ok) throw Object.assign(new Error(outcome.error?.message), { report: true });
      }
    });
    return { steps, ok: true, historyEntry: entry };
  } catch (e) {
    if ((e as { report?: boolean }).report) return { steps, ok: false, historyEntry: null };
    throw e;
  }
}
