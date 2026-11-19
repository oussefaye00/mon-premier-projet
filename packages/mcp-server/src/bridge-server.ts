import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { BRIDGE_PROTOCOL_VERSION, type BridgeMessage } from "@amai/bridge";
import type { ToolCallOutcome } from "@amai/core";
import type { ServerConfig } from "./config";
import { log } from "./log";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
};

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

interface Pending {
  resolve: (o: ToolCallOutcome) => void;
  timer: NodeJS.Timeout;
  onProgress?: (p: number, message?: string) => void;
}

/**
 * Serveur local : héberge le WebSocket du pont, sert l'éditeur compilé et
 * (optionnellement) le point d'accès MCP HTTP.
 */
export class BridgeServer {
  private http: http.Server;
  private wss: WebSocketServer;
  private editor: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private approvals = new Map<string, (ok: boolean) => void>();
  onEditorChange?: (connected: boolean) => void;
  /** Gestionnaire HTTP additionnel (transport MCP Streamable HTTP). */
  extraHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean | Promise<boolean>;

  constructor(private cfg: ServerConfig) {
    this.http = http.createServer((req, res) => void this.handleHttp(req, res));
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 * 1024 });
    this.http.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/bridge" || !this.hostAllowed(req) || !this.originAllowed(req.headers.origin)) {
        log("Connexion WebSocket refusée (origine/hôte non autorisé) :", req.headers.origin ?? "(aucune)");
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
  }

  get connected() {
    return !!this.editor;
  }

  get url() {
    return `http://${this.cfg.host === "0.0.0.0" ? "127.0.0.1" : this.cfg.host}:${this.cfg.port}`;
  }

  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.cfg.port, this.cfg.host, () => {
        this.http.off("error", reject);
        const addr = this.http.address();
        if (addr && typeof addr === "object") this.cfg.port = addr.port;
        resolve();
      });
    });
  }

  close() {
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.editor?.close();
    this.wss.close();
    this.http.close();
  }

  /** Protection contre le DNS rebinding : seul un hôte local est accepté. */
  hostAllowed(req: http.IncomingMessage) {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    return ["127.0.0.1", "localhost", "[::1]"].includes(host);
  }

  originAllowed(origin: string | undefined) {
    if (!origin) return true; // clients natifs (Node, applications) : le jeton reste exigé
    return this.cfg.allowedOrigins.includes(origin);
  }

  private onConnection(ws: WebSocket) {
    let authed = false;
    const authTimer = setTimeout(() => !authed && ws.close(), 5000);
    ws.on("message", (raw) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!authed) {
        if (msg.type !== "hello" || !safeEqual(String(msg.token ?? ""), this.cfg.token)) {
          ws.send(JSON.stringify({ type: "rejected", reason: "Jeton invalide." } satisfies BridgeMessage));
          log("Éditeur refusé : jeton invalide.");
          ws.close();
          return;
        }
        if (msg.protocol !== BRIDGE_PROTOCOL_VERSION) {
          ws.send(JSON.stringify({ type: "rejected", reason: `Protocole ${msg.protocol} non pris en charge (attendu ${BRIDGE_PROTOCOL_VERSION}).` } satisfies BridgeMessage));
          ws.close();
          return;
        }
        authed = true;
        clearTimeout(authTimer);
        if (this.editor && this.editor !== ws) {
          log("Nouvel éditeur connecté : l'ancienne connexion est fermée.");
          this.editor.close();
        }
        this.editor = ws;
        ws.send(JSON.stringify({ type: "welcome", protocol: BRIDGE_PROTOCOL_VERSION, server: { name: "after-motion-ai-mcp", version: "0.1.0" }, exportDir: this.cfg.exportDir } satisfies BridgeMessage));
        log("Éditeur connecté.");
        this.onEditorChange?.(true);
        return;
      }
      this.onMessage(msg);
    });
    ws.on("close", () => {
      clearTimeout(authTimer);
      if (this.editor === ws) {
        this.editor = null;
        log("Éditeur déconnecté.");
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, error: { code: "editor_disconnected", message: "L'éditeur s'est déconnecté pendant l'opération." } });
          this.pending.delete(id);
        }
        for (const [id, a] of this.approvals) {
          a(false);
          this.approvals.delete(id);
        }
        this.onEditorChange?.(false);
      }
    });
    // Battement de cœur pour détecter les connexions mortes.
    const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 20_000);
    ws.on("close", () => clearInterval(ping));
  }

  private onMessage(msg: BridgeMessage) {
    if (msg.type === "response") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg.outcome);
    } else if (msg.type === "progress") {
      this.pending.get(msg.id)?.onProgress?.(msg.progress, msg.message);
    } else if (msg.type === "approval_result") {
      const a = this.approvals.get(msg.id);
      this.approvals.delete(msg.id);
      a?.(msg.approved);
    }
  }

  /** Demande à l'utilisateur, dans l'éditeur, d'autoriser une action sensible. */
  requestApproval(id: string, tool: string, args: unknown, summary: string, timeoutMs = 120_000): Promise<boolean> {
    const ws = this.editor;
    if (!ws) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(id);
        resolve(false);
      }, timeoutMs);
      this.approvals.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      ws.send(JSON.stringify({ type: "approval", id, tool, args, summary } satisfies BridgeMessage));
    });
  }

  /** Envoie un appel d'outil à l'éditeur et attend le résultat. */
  call(tool: string, args: unknown, opts: { id?: string; approved?: boolean; timeoutMs?: number; onProgress?: (p: number, m?: string) => void } = {}): Promise<ToolCallOutcome> {
    const ws = this.editor;
    if (!ws) return Promise.resolve({ ok: false, error: { code: "editor_not_connected", message: this.notConnectedMessage() } });
    const id = opts.id ?? randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: { code: "timeout", message: `L'éditeur n'a pas répondu à ${tool} dans le délai imparti.` } });
      }, opts.timeoutMs ?? this.cfg.requestTimeoutMs);
      this.pending.set(id, { resolve, timer, onProgress: opts.onProgress });
      ws.send(JSON.stringify({ type: "request", id, tool, args, approved: opts.approved } satisfies BridgeMessage));
    });
  }

  notConnectedMessage() {
    return this.cfg.editorDir
      ? `Aucun éditeur AFTER MOTION AI n'est connecté. Ouvrez ${this.url}/ dans un navigateur (connexion automatique).`
      : `Aucun éditeur AFTER MOTION AI n'est connecté. Lancez l'éditeur et connectez-le au pont MCP (ws://127.0.0.1:${this.cfg.port}/bridge, jeton dans ${this.cfg.tokenFile}).`;
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse) {
    if (!this.hostAllowed(req)) {
      res.writeHead(403).end("Hôte non autorisé");
      return;
    }
    if (this.extraHandler && (await this.extraHandler(req, res))) return;
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/bridge/info") {
      // Appairage automatique pour l'éditeur servi par ce même serveur (même origine uniquement).
      const site = req.headers["sec-fetch-site"];
      const origin = req.headers.origin;
      const sameOrigin = site === "same-origin" || (!site && (!origin || origin === this.url));
      if (!sameOrigin) {
        res.writeHead(403).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ token: this.cfg.token, ws: `ws://${req.headers.host}/bridge`, exportDir: this.cfg.exportDir }));
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, editorConnected: this.connected }));
      return;
    }
    if (!this.cfg.editorDir) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Éditeur non compilé (npm run build).");
      return;
    }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.resolve(this.cfg.editorDir, "." + p);
    if (!file.startsWith(path.resolve(this.cfg.editorDir))) {
      res.writeHead(403).end();
      return;
    }
    const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(this.cfg.editorDir, "index.html");
    res.writeHead(200, {
      "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
      "cache-control": target.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(target).pipe(res);
  }

  get httpServer() {
    return this.http;
  }
}
