import { executeTool, getTool, type EditorEngine, type EditorHost, type ToolCallOutcome } from "@amai/core";

/**
 * Protocole du pont entre le serveur MCP (Node, local) et l'éditeur (navigateur).
 *
 * Le serveur MCP héberge un WebSocket sur 127.0.0.1. L'éditeur s'y connecte, s'authentifie
 * avec un jeton secret, puis reçoit les requêtes d'outils qu'il exécute sur le projet
 * réellement ouvert. Les actions sensibles déclenchent d'abord une demande d'accord
 * affichée à l'utilisateur dans l'éditeur.
 */
export const BRIDGE_PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 7823;

export type BridgeMessage =
  | { type: "hello"; role: "editor"; token: string; protocol: number; app: { name: string; version: string } }
  | { type: "welcome"; protocol: number; server: { name: string; version: string }; exportDir?: string }
  | { type: "rejected"; reason: string }
  | { type: "request"; id: string; tool: string; args: unknown; approved?: boolean }
  | { type: "response"; id: string; outcome: ToolCallOutcome }
  | { type: "approval"; id: string; tool: string; args: unknown; summary: string; client?: string }
  | { type: "approval_result"; id: string; approved: boolean }
  | { type: "progress"; id: string; progress: number; message?: string }
  | { type: "ping" }
  | { type: "pong" };

export type BridgeStatus = "disconnected" | "connecting" | "connected" | "rejected";

export interface ActivityEvent {
  at: number;
  tool: string;
  args: unknown;
  ok: boolean;
  message: string;
  historyEntryId?: number;
}

export interface EditorBridgeOptions {
  url: string;
  token: string;
  engine: EditorEngine;
  host?: EditorHost;
  /** Demande d'accord à l'utilisateur pour une action sensible. */
  requestApproval: (tool: string, args: unknown, summary: string) => Promise<boolean>;
  onStatus?: (s: BridgeStatus, detail?: string) => void;
  onActivity?: (e: ActivityEvent) => void;
  appVersion?: string;
  /** Reconnexion automatique (ms) ; 0 pour désactiver. */
  reconnectDelay?: number;
  WebSocketImpl?: typeof WebSocket;
}

/**
 * Client du pont côté éditeur. Fonctionne dans le navigateur et dans Node ≥ 22
 * (WebSocket global), ce qui permet de le tester sans navigateur.
 */
export class EditorBridgeClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private approvals = new Set<string>();
  status: BridgeStatus = "disconnected";
  serverInfo: { name: string; version: string; exportDir?: string } | null = null;

  constructor(private opts: EditorBridgeOptions) {}

  private setStatus(s: BridgeStatus, detail?: string) {
    this.status = s;
    this.opts.onStatus?.(s, detail);
  }

  connect() {
    this.stopped = false;
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WS(this.opts.url);
    } catch (e) {
      this.setStatus("disconnected", (e as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.send({ type: "hello", role: "editor", token: this.opts.token, protocol: BRIDGE_PROTOCOL_VERSION, app: { name: "AFTER MOTION AI", version: this.opts.appVersion ?? "0.1.0" } });
    };
    ws.onmessage = (ev) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      } catch {
        return;
      }
      void this.handle(msg);
    };
    ws.onclose = () => {
      this.ws = null;
      if (this.status !== "rejected") this.setStatus("disconnected");
      this.scheduleReconnect();
    };
    ws.onerror = () => {
      /* onclose suit */
    };
  }

  private scheduleReconnect() {
    const delay = this.opts.reconnectDelay ?? 3000;
    if (this.stopped || delay <= 0 || this.status === "rejected") return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }

  private send(m: BridgeMessage) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  private async handle(msg: BridgeMessage) {
    switch (msg.type) {
      case "welcome":
        this.serverInfo = { ...msg.server, exportDir: msg.exportDir };
        this.setStatus("connected");
        break;
      case "rejected":
        this.setStatus("rejected", msg.reason);
        this.ws?.close();
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
      case "approval": {
        const ok = await this.opts.requestApproval(msg.tool, msg.args, msg.summary);
        if (ok) this.approvals.add(msg.id);
        this.send({ type: "approval_result", id: msg.id, approved: ok });
        break;
      }
      case "request": {
        const outcome = await this.execute(msg);
        this.send({ type: "response", id: msg.id, outcome });
        break;
      }
    }
  }

  private async execute(msg: Extract<BridgeMessage, { type: "request" }>): Promise<ToolCallOutcome> {
    const { engine } = this.opts;
    let sensitive = false;
    try {
      sensitive = !!getTool(msg.tool).sensitive;
    } catch {
      /* outil inconnu, executeTool renverra l'erreur */
    }
    // Vérification des autorisations : un outil sensible doit avoir été approuvé
    // explicitement par l'utilisateur pour CETTE requête.
    if (sensitive) {
      if (!this.approvals.has(msg.id)) {
        const ok = await this.opts.requestApproval(msg.tool, msg.args, `Un assistant externe (MCP) demande : ${msg.tool}`);
        if (!ok) {
          const outcome: ToolCallOutcome = { ok: false, error: { code: "denied", message: "L'utilisateur a refusé cette action dans l'éditeur." } };
          this.opts.onActivity?.({ at: Date.now(), tool: msg.tool, args: msg.args, ok: false, message: outcome.error!.message });
          return outcome;
        }
      }
      this.approvals.delete(msg.id);
    }
    const host: EditorHost | undefined = this.opts.host && {
      ...this.opts.host,
      exportVideo: this.opts.host.exportVideo
        ? (o, onProgress) =>
            this.opts.host!.exportVideo!(o, (p) => {
              onProgress?.(p);
              this.send({ type: "progress", id: msg.id, progress: p });
            })
        : undefined,
    };
    let outcome: ToolCallOutcome = { ok: false, error: { code: "internal", message: "non exécuté" } };
    const { entry } = await engine.store.batch(`MCP : ${msg.tool}`, "mcp", async () => {
      outcome = await executeTool({ engine, host, source: "mcp" }, msg.tool, msg.args);
    });
    this.opts.onActivity?.({
      at: Date.now(),
      tool: msg.tool,
      args: msg.args,
      ok: outcome.ok,
      message: outcome.ok ? "" : outcome.error!.message,
      historyEntryId: entry?.id,
    });
    return outcome;
  }
}
