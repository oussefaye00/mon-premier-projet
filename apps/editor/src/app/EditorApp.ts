import {
  createProject,
  EditorEngine,
  parseProjectFile,
  serializeProject,
  type Asset,
  type EditorHost,
  type ExportOptions,
  type ExportResult,
  type HistoryEntry,
  type Project,
} from "@amai/core";
import { Renderer } from "@amai/renderer";
import { ClaudeAgent, executePlan, planFromText, type AgentEvent, type Plan, type StepOutcome } from "@amai/ai";
import { DEFAULT_BRIDGE_PORT, EditorBridgeClient, type ActivityEvent, type BridgeStatus } from "@amai/bridge";
import { MediaManager } from "../media/MediaManager";
import { db, type Snapshot } from "../storage/db";
import { blobToBase64, ExportCancelled, exportVideo } from "../export/exporter";
import { createStarterProject } from "./starter";

export type PanelTab = "media" | "effects" | "presets";
export type SideTab = "properties" | "ai" | "history" | "mcp";
export type MobileTab = "timeline" | "properties" | "media" | "effects" | "ai";
export type Tool = "select" | "hand" | "text" | "rectangle" | "ellipse" | "star";

export interface Settings {
  aiMode: "local" | "claude";
  apiKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  confirmAIPlans: boolean;
  bridgeUrl: string;
  bridgeToken: string;
  bridgeAuto: boolean;
  previewScale: "auto" | 1 | 0.5 | 0.25;
  motionBlurPreview: boolean;
  autosaveSeconds: number;
}

const DEFAULT_SETTINGS: Settings = {
  aiMode: "local",
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "medium",
  confirmAIPlans: true,
  bridgeUrl: `ws://127.0.0.1:${DEFAULT_BRIDGE_PORT}/bridge`,
  bridgeToken: "",
  bridgeAuto: true,
  previewScale: "auto",
  motionBlurPreview: true,
  autosaveSeconds: 1,
};

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  plan?: Plan;
  planState?: "pending" | "applied" | "cancelled" | "failed" | "undone";
  steps?: StepOutcome[];
  tools?: { name: string; ok?: boolean; summary?: string; input?: unknown }[];
  historyEntryId?: number | null;
  error?: boolean;
}

export interface ApprovalRequest {
  id: string;
  tool: string;
  args: unknown;
  summary: string;
  origin: "mcp" | "ai";
  resolve: (ok: boolean) => void;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error" | "success";
}

export interface ExportState {
  running: boolean;
  progress: number;
  result?: { url: string; fileName: string; size: number; codec: string; warnings: string[] };
  error?: string;
  origin?: "user" | "mcp";
}

let idc = 0;
const nid = () => `m${++idc}_${Date.now().toString(36)}`;

/**
 * Racine de l'application éditeur. Les composants React lisent cet objet via des hooks
 * (voir hooks.ts) ; toute modification de projet passe par `engine` (API interne).
 */
export class EditorApp {
  engine = new EditorEngine(createProject());
  renderer = new Renderer();
  media = new MediaManager(this.engine);
  settings: Settings = { ...DEFAULT_SETTINGS };

  // UI
  tool: Tool = "select";
  panelTab: PanelTab = "media";
  sideTab: SideTab = "properties";
  mobileTab: MobileTab = "timeline";
  playing = false;
  loop = true;
  timelineZoom = 80;
  graphEditor: { open: boolean } = { open: false };
  dialogs = { export: false, settings: false, projects: false, newProject: false, shortcuts: false };
  recovery: { snapshots: Snapshot[]; recovered: boolean } | null = null;
  chat: ChatMessage[] = [];
  aiBusy = false;
  approvals: ApprovalRequest[] = [];
  activity: ActivityEvent[] = [];
  toasts: Toast[] = [];
  exportState: ExportState = { running: false, progress: 0 };
  bridgeStatus: BridgeStatus = "disconnected";
  bridgeDetail = "";
  lastSavedAt = 0;
  ready = false;

  private listeners = new Set<() => void>();
  version = 0;
  private bridge: EditorBridgeClient | null = null;
  private agent: ClaudeAgent | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSnapshot = 0;
  private exportAbort: AbortController | null = null;
  private raf = 0;
  private lastTick = 0;

  constructor() {
    this.media.onReady = () => this.requestRender();
    if (typeof document !== "undefined") {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "path");
      this.renderer.measurePath = (d) => {
        try {
          svg.setAttribute("d", d);
          return svg.getTotalLength();
        } catch {
          return 0;
        }
      };
    }
    this.engine.store.subscribe(() => {
      this.scheduleSave();
      this.requestRender();
      this.emit();
    });
    this.engine.onSession(() => this.requestRender());
  }

  // ------------------------------------------------------------ abonnement

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  set<K extends keyof this>(k: K, v: this[K]) {
    this[k] = v;
    this.emit();
  }

  renderListeners = new Set<() => void>();
  requestRender() {
    for (const l of this.renderListeners) l();
  }

  toast(text: string, kind: Toast["kind"] = "info") {
    const t = { id: ++idc, text, kind };
    this.toasts = [...this.toasts, t];
    this.emit();
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id);
      this.emit();
    }, kind === "error" ? 7000 : 3500);
  }

  // ------------------------------------------------------------ démarrage / sauvegarde

  async boot() {
    try {
      const saved = await db.getKV<Partial<Settings>>("settings");
      if (saved) this.settings = { ...DEFAULT_SETTINGS, ...saved };
    } catch {
      /* IndexedDB indisponible (navigation privée) */
    }
    const params = new URLSearchParams(location.search + location.hash.replace(/^#/, "&"));
    if (params.get("bridgeToken")) this.settings.bridgeToken = params.get("bridgeToken")!;
    if (params.get("bridgeUrl")) this.settings.bridgeUrl = params.get("bridgeUrl")!;

    let project: Project | null = null;
    try {
      const session = await db.getKV<{ projectId: string; clean: boolean }>("session");
      if (session?.projectId && !params.has("new")) {
        const stored = await db.getProject(session.projectId);
        project = stored?.project ?? null;
        if (project && session.clean === false) {
          const snaps = (await db.listSnapshots(project.id)).sort((a, b) => b.savedAt - a.savedAt);
          this.recovery = { snapshots: snaps, recovered: true };
        }
      }
    } catch {
      /* ignore */
    }
    if (!project) project = createStarterProject();
    this.engine.loadProject(project);
    this.markSession(false);
    window.addEventListener("pagehide", () => this.markSession(true));
    window.addEventListener("beforeunload", () => this.flushSave());
    this.ready = true;
    this.emit();
    await this.autoPairBridge();
  }

  private markSession(clean: boolean) {
    void db.setKV("session", { projectId: this.engine.project.id, clean }).catch(() => {});
  }

  saveSettings(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    this.agent = null;
    void db.setKV("settings", this.settings).catch(() => {});
    this.emit();
  }

  private scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushSave(), this.settings.autosaveSeconds * 1000);
  }

  async flushSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const p = this.engine.project;
    try {
      await db.saveProject(p);
      if (Date.now() - this.lastSnapshot > 30_000) {
        this.lastSnapshot = Date.now();
        await db.addSnapshot(p);
      }
      this.lastSavedAt = Date.now();
      this.markSession(false);
      this.emit();
    } catch (e) {
      this.toast(`Sauvegarde automatique impossible : ${(e as Error).message}`, "error");
    }
  }

  async openProject(p: Project) {
    await this.flushSave();
    this.stop();
    this.engine.loadProject(p);
    this.media.gc(p);
    this.lastSnapshot = 0;
    this.markSession(false);
    await this.flushSave();
    this.emit();
  }

  async restoreSnapshot(s: Snapshot) {
    await this.openProject(s.project);
    this.recovery = null;
    this.toast(`Version du ${new Date(s.savedAt).toLocaleString()} restaurée.`, "success");
  }

  async newProject(opts: { name: string; width: number; height: number; fps: number; duration: number; background?: string }) {
    await this.flushSave();
    this.engine.newProject({ projectName: opts.name, width: opts.width, height: opts.height, fps: opts.fps, duration: opts.duration, background: opts.background });
    this.lastSnapshot = 0;
    await this.flushSave();
  }

  /** Exporte le projet en fichier .amai.json (médias embarqués). */
  async downloadProjectFile() {
    const p = this.engine.project;
    const media: Record<string, { mimeType: string; data: string }> = {};
    for (const a of p.assets) {
      const b = await this.media.getBlob(a);
      if (b) media[a.id] = { mimeType: a.mimeType, data: await blobToBase64(b) };
    }
    download(new Blob([serializeProject(p, media)], { type: "application/json" }), `${p.name || "projet"}.amai.json`);
  }

  async openProjectFile(file: File) {
    const parsed = parseProjectFile(await file.text());
    for (const [id, m] of Object.entries(parsed.media ?? {})) {
      const bin = Uint8Array.from(atob(m.data), (c) => c.charCodeAt(0));
      await db.putMedia(id, new Blob([bin], { type: m.mimeType }));
    }
    for (const a of parsed.project.assets) if (parsed.media?.[a.id]) a.src = `idb:${a.id}`;
    await this.openProject(parsed.project);
    this.toast(`Projet « ${parsed.project.name} » ouvert.`, "success");
  }

  // ------------------------------------------------------------ médias

  async importFiles(files: FileList | File[], addToTimeline = true) {
    for (const f of Array.from(files)) {
      try {
        const asset = await this.media.importBlob(f, f.name);
        if (addToTimeline) this.addAssetToTimeline(asset);
        this.toast(`« ${f.name} » importé.`, "success");
      } catch (e) {
        this.toast((e as Error).message, "error");
      }
    }
  }

  addAssetToTimeline(asset: Asset, source: "user" | "ai" | "mcp" = "user") {
    const type = asset.kind === "svg" ? "image" : asset.kind;
    const l = this.engine.createLayer(type, { assetId: asset.id, inPoint: this.engine.session.currentTime }, source);
    this.engine.select([l.id]);
    return l;
  }

  // ------------------------------------------------------------ lecture

  play() {
    if (this.playing) return;
    const comp = this.engine.comp();
    if (this.engine.session.currentTime >= comp.duration - 1 / comp.fps) this.engine.setSession({ currentTime: 0 });
    this.playing = true;
    this.lastTick = performance.now();
    this.emit();
    const tick = (now: number) => {
      if (!this.playing) return;
      const c = this.engine.comp();
      const dt = Math.min(0.25, (now - this.lastTick) / 1000);
      this.lastTick = now;
      let t = this.engine.session.currentTime + dt;
      if (t >= c.duration) {
        if (this.loop) t = 0;
        else {
          t = c.duration;
          this.stop();
        }
      }
      this.engine.setSession({ currentTime: t });
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.media.pauseAll();
    const c = this.engine.comp();
    // Recalage sur une image exacte
    this.engine.setSession({ currentTime: Math.round(this.engine.session.currentTime * c.fps) / c.fps });
    this.emit();
  }

  togglePlay() {
    if (this.playing) this.stop();
    else this.play();
  }

  seek(t: number) {
    const c = this.engine.comp();
    this.engine.setSession({ currentTime: Math.max(0, Math.min(c.duration, t)) });
  }

  stepFrame(n: number) {
    const c = this.engine.comp();
    this.stop();
    this.seek(Math.round((this.engine.session.currentTime + n / c.fps) * c.fps) / c.fps);
  }

  // ------------------------------------------------------------ hôte des outils (MCP / IA)

  /** Rendu d'une image fixe (aperçu MCP, vignettes). */
  async renderStill(time: number, width: number, format: "png" | "jpeg" = "png") {
    const p = this.engine.project;
    const comp = this.engine.comp();
    const scale = Math.min(1, width / comp.width);
    const w = Math.max(1, Math.round(comp.width * scale));
    const h = Math.max(1, Math.round(comp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d")!;
    this.media.beginExport();
    try {
      await this.media.prepareExportFrame(p, comp.id, time);
      this.renderer.render(ctx, p, comp.id, time, this.media, { scale, motionBlur: true });
    } finally {
      this.media.endExport();
    }
    const blob = await canvas.convertToBlob({ type: format === "png" ? "image/png" : "image/jpeg", quality: 0.85 });
    return { blob, width: w, height: h };
  }

  host: EditorHost = {
    renderPreview: async ({ time, width, format }) => {
      const { blob, width: w, height: h } = await this.renderStill(time, width ?? 640, format ?? "jpeg");
      return { mimeType: blob.type as "image/png" | "image/jpeg", data: await blobToBase64(blob), width: w, height: h, time };
    },
    exportVideo: async (opts, onProgress) => {
      const r = await this.runExport(opts, "mcp", onProgress);
      return { ...r, data: await blobToBase64(r.blob) };
    },
    importMedia: async (req) => {
      if (req.data) return this.media.importBlob(new Blob([Uint8Array.from(atob(req.data), (c) => c.charCodeAt(0))], { type: req.mimeType ?? "" }), req.name ?? "media", "mcp");
      if (req.url) return this.media.importFromUrl(req.url, req.name, "mcp");
      throw new Error("Aucune source de média fournie.");
    },
  };

  async runExport(opts: ExportOptions, origin: "user" | "mcp" = "user", onProgress?: (p: number) => void): Promise<ExportResult & { blob: Blob; warnings: string[] }> {
    if (this.exportState.running) throw new Error("Un export est déjà en cours.");
    this.stop();
    await this.flushSave();
    this.exportAbort = new AbortController();
    if (this.exportState.result) URL.revokeObjectURL(this.exportState.result.url);
    this.exportState = { running: true, progress: 0, origin };
    this.dialogs.export = true;
    this.emit();
    let last = 0;
    try {
      const r = await exportVideo(
        this.engine.project,
        new Renderer(),
        this.media,
        opts,
        (p) => {
          onProgress?.(p);
          if (p - last > 0.01 || p === 1) {
            last = p;
            this.exportState = { ...this.exportState, progress: p };
            this.emit();
          }
        },
        this.exportAbort.signal,
      );
      this.exportState = { running: false, progress: 1, origin, result: { url: URL.createObjectURL(r.blob), fileName: r.fileName, size: r.size, codec: r.codec, warnings: r.warnings } };
      this.emit();
      return r;
    } catch (e) {
      this.exportState = { running: false, progress: 0, origin, error: e instanceof ExportCancelled ? "Export annulé." : (e as Error).message };
      this.emit();
      throw e;
    } finally {
      this.exportAbort = null;
    }
  }

  cancelExport() {
    this.exportAbort?.abort();
  }

  // ------------------------------------------------------------ autorisations

  requestApproval = (tool: string, args: unknown, summary: string, origin: "mcp" | "ai" = "mcp"): Promise<boolean> =>
    new Promise((resolve) => {
      const req: ApprovalRequest = {
        id: nid(),
        tool,
        args,
        summary,
        origin,
        resolve: (ok) => {
          this.approvals = this.approvals.filter((a) => a.id !== req.id);
          this.emit();
          resolve(ok);
        },
      };
      this.approvals = [...this.approvals, req];
      this.emit();
    });

  // ------------------------------------------------------------ pont MCP

  private async autoPairBridge() {
    // Éditeur servi par le serveur MCP local : appairage automatique (même origine).
    try {
      const r = await fetch("/bridge/info", { cache: "no-store" });
      if (r.ok && (r.headers.get("content-type") ?? "").includes("json")) {
        const info = (await r.json()) as { token: string; ws: string };
        this.settings.bridgeToken = info.token;
        this.settings.bridgeUrl = info.ws;
      }
    } catch {
      /* pas de serveur local sur cette origine */
    }
    if (this.settings.bridgeAuto && this.settings.bridgeToken) this.connectBridge();
  }

  connectBridge() {
    this.bridge?.disconnect();
    if (!this.settings.bridgeToken) {
      this.toast("Renseignez le jeton du serveur MCP dans les paramètres.", "error");
      return;
    }
    this.bridge = new EditorBridgeClient({
      url: this.settings.bridgeUrl,
      token: this.settings.bridgeToken,
      engine: this.engine,
      host: this.host,
      requestApproval: (tool, args, summary) => this.requestApproval(tool, args, summary, "mcp"),
      onStatus: (s, d) => {
        const was = this.bridgeStatus;
        this.bridgeStatus = s;
        this.bridgeDetail = d ?? "";
        if (s === "connected" && was !== "connected") this.toast("Serveur MCP connecté : les assistants externes peuvent piloter ce projet.", "success");
        if (s === "rejected") this.toast(`Connexion MCP refusée : ${d}`, "error");
        this.emit();
      },
      onActivity: (e) => {
        this.activity = [e, ...this.activity].slice(0, 200);
        this.emit();
      },
    });
    this.bridge.connect();
  }

  disconnectBridge() {
    this.bridge?.disconnect();
    this.bridge = null;
  }

  // ------------------------------------------------------------ assistant IA

  private pushChat(m: ChatMessage) {
    this.chat = [...this.chat, m];
    this.emit();
    return m.id;
  }

  private patchChat(id: string, patch: Partial<ChatMessage>) {
    this.chat = this.chat.map((m) => (m.id === id ? { ...m, ...patch } : m));
    this.emit();
  }

  async sendToAI(text: string) {
    const t = text.trim();
    if (!t || this.aiBusy) return;
    this.pushChat({ id: nid(), role: "user", text: t });
    if (this.settings.aiMode === "claude" && this.settings.apiKey) return this.sendToClaude(t);
    const plan = planFromText(t, this.engine);
    const id = this.pushChat({
      id: nid(),
      role: "assistant",
      text: plan.summary + (plan.notes.length ? "\n" + plan.notes.map((n) => `• ${n}`).join("\n") : ""),
      plan,
      planState: plan.understood ? "pending" : undefined,
    });
    if (plan.understood && !this.settings.confirmAIPlans) await this.applyPlan(id);
  }

  async applyPlan(messageId: string) {
    const m = this.chat.find((x) => x.id === messageId);
    if (!m?.plan || m.planState !== "pending") return;
    this.aiBusy = true;
    this.emit();
    try {
      const r = await executePlan(this.engine, m.plan, { host: this.host, approve: (tool, args, d) => this.requestApproval(tool, args, d, "ai") });
      const failed = r.steps.find((s) => !s.outcome.ok);
      this.patchChat(messageId, {
        planState: r.ok ? "applied" : "failed",
        steps: r.steps,
        historyEntryId: r.historyEntry?.id ?? null,
        text: r.ok ? `${m.plan.summary} Modifications appliquées.` : `Échec : ${failed?.outcome.error?.message ?? "erreur"} — aucune modification conservée.`,
        error: !r.ok,
      });
      // Sélectionne le dernier calque créé pour le montrer à l'utilisateur.
      const createdLayer = [...r.steps].reverse().map((s) => s.outcome.result as { id?: string; layerId?: string } | undefined).find((x) => x?.id?.startsWith("layer_") || x?.layerId);
      if (r.ok && createdLayer) this.engine.select([(createdLayer.id ?? createdLayer.layerId)!]);
    } finally {
      this.aiBusy = false;
      this.emit();
    }
  }

  cancelPlan(messageId: string) {
    this.patchChat(messageId, { planState: "cancelled" });
  }

  undoAIChange(messageId: string) {
    const m = this.chat.find((x) => x.id === messageId);
    if (!m?.historyEntryId) return;
    const ok = this.engine.store.undoEntry(m.historyEntryId) || this.engine.store.undoUntil(m.historyEntryId) > 0;
    if (ok) {
      this.patchChat(messageId, { planState: "undone" });
      this.toast("Modifications de l'IA annulées.", "success");
    }
  }

  private async sendToClaude(text: string) {
    if (!this.agent) {
      this.agent = new ClaudeAgent(this.engine, { apiKey: this.settings.apiKey, model: this.settings.model, effort: this.settings.effort, browser: true }, this.host, (tool, args, d) =>
        this.requestApproval(tool, args, d, "ai"),
      );
    }
    this.aiBusy = true;
    const id = this.pushChat({ id: nid(), role: "assistant", text: "", tools: [] });
    this.emit();
    let textAcc = "";
    const tools: NonNullable<ChatMessage["tools"]> = [];
    try {
      await this.agent.send(text, (e: AgentEvent) => {
        if (e.type === "text") textAcc += (textAcc ? "\n\n" : "") + e.text;
        if (e.type === "tool_call") tools.push({ name: e.name, input: e.input });
        if (e.type === "tool_result") {
          const t = [...tools].reverse().find((x) => x.name === e.name && x.ok === undefined);
          if (t) Object.assign(t, { ok: e.ok, summary: e.summary });
        }
        if (e.type === "error") textAcc += (textAcc ? "\n\n" : "") + `⚠ ${e.message}`;
        if (e.type === "done") this.patchChat(id, { historyEntryId: (e.historyEntry as HistoryEntry | null)?.id ?? null, planState: e.historyEntry ? "applied" : undefined });
        this.patchChat(id, { text: textAcc, tools: [...tools] });
      });
    } finally {
      this.aiBusy = false;
      this.emit();
    }
  }

  clearChat() {
    this.chat = [];
    this.agent?.reset();
    this.emit();
  }
}

export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export const app = new EditorApp();
if (typeof window !== "undefined") (window as unknown as { __amai: EditorApp }).__amai = app;
