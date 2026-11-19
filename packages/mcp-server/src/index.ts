import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { BridgeServer, safeEqual } from "./bridge-server";
import { HELP, parseArgs } from "./config";
import { Dispatcher } from "./dispatcher";
import { log } from "./log";
import { createMcpServer } from "./mcp";

async function main() {
  const cfg = parseArgs(process.argv.slice(2));
  if (cfg === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (cfg === "print-token") {
    const { loadOrCreateToken } = await import("./config");
    process.stdout.write(loadOrCreateToken() + "\n");
    return;
  }

  const bridge = new BridgeServer(cfg);
  const dispatcher = new Dispatcher(cfg, bridge);

  if (cfg.http) {
    // Transport MCP Streamable HTTP (sans état) sur /mcp, protégé par le jeton.
    bridge.extraHandler = async (req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/mcp") return false;
      const auth = String(req.headers.authorization ?? "");
      if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), cfg.token)) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: "Jeton manquant ou invalide (Authorization: Bearer <jeton>)." }));
        return true;
      }
      const server = createMcpServer(dispatcher);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableDnsRebindingProtection: true, allowedHosts: [`127.0.0.1:${cfg.port}`, `localhost:${cfg.port}`] });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return true;
    };
  }

  try {
    await bridge.listen();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "EADDRINUSE") {
      log(`Le port ${cfg.port} est déjà utilisé (une autre instance tourne-t-elle ?). Utilisez --port ou AMAI_PORT.`);
    } else log("Impossible de démarrer le serveur local :", err.message);
    if (!cfg.stdio) process.exit(1);
  }
  log(`Pont éditeur : ws://${cfg.host}:${cfg.port}/bridge`);
  if (cfg.editorDir) log(`Éditeur : ${bridge.url}/  (connexion automatique)`);
  if (cfg.http) log(`MCP HTTP : ${bridge.url}/mcp (Authorization: Bearer <jeton>)`);
  log(`Jeton : ${cfg.tokenFile} · Exports : ${cfg.exportDir}${cfg.headless ? " · mode headless actif" : ""}`);

  if (cfg.stdio) {
    const server = createMcpServer(dispatcher);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    transport.onclose = () => {
      bridge.close();
      process.exit(0);
    };
    process.stdin.on("end", () => {
      bridge.close();
      process.exit(0);
    });
  }
}

main().catch((e) => {
  log("Erreur fatale :", (e as Error).stack ?? String(e));
  process.exit(1);
});
