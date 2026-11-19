import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_BRIDGE_PORT } from "@amai/bridge";

export interface ServerConfig {
  host: string;
  port: number;
  token: string;
  tokenFile: string;
  exportDir: string;
  editorDir: string | null;
  http: boolean;
  stdio: boolean;
  headless: boolean;
  projectFile: string | null;
  allowedOrigins: string[];
  requestTimeoutMs: number;
  exportTimeoutMs: number;
  maxImportBytes: number;
}

const HELP = `AFTER MOTION AI — serveur MCP

Usage : after-motion-mcp [options]

  --port <n>            Port local du pont éditeur / HTTP (défaut ${DEFAULT_BRIDGE_PORT}, env AMAI_PORT)
  --host <h>            Interface d'écoute (défaut 127.0.0.1 ; ne pas exposer sur le réseau)
  --export-dir <dir>    Dossier des exports vidéo (défaut ~/AfterMotionAI/exports)
  --editor-dir <dir>    Dossier de l'éditeur compilé à servir (défaut apps/editor/dist)
  --http                Active aussi le transport MCP Streamable HTTP sur /mcp (jeton requis)
  --no-stdio            Désactive le transport stdio (utile avec --http)
  --headless            Sans éditeur connecté, exécute les outils sur un projet local en mémoire
  --project <file>      Fichier projet utilisé/sauvegardé en mode headless
  --allow-origin <url>  Origine supplémentaire autorisée pour l'éditeur (ex. http://localhost:5173)
  --print-token         Affiche le jeton du pont et quitte
  -h, --help            Aide
`;

function tokenFilePath() {
  return process.env.AMAI_TOKEN_FILE ?? path.join(os.homedir(), ".after-motion-ai", "bridge-token");
}

/** Jeton secret partagé avec l'éditeur : variable d'environnement ou fichier (0600). */
export function loadOrCreateToken(file = tokenFilePath()): string {
  if (process.env.AMAI_BRIDGE_TOKEN) return process.env.AMAI_BRIDGE_TOKEN;
  try {
    const t = fs.readFileSync(file, "utf8").trim();
    if (t.length >= 32) return t;
  } catch {
    /* création ci-dessous */
  }
  const t = randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, t + "\n", { mode: 0o600 });
  return t;
}

export function parseArgs(argv: string[]): ServerConfig | "help" | "print-token" {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("-h") || argv.includes("--help")) return "help";
  if (argv.includes("--print-token")) return "print-token";
  const port = parseInt(get("--port") ?? process.env.AMAI_PORT ?? String(DEFAULT_BRIDGE_PORT), 10);
  const host = get("--host") ?? "127.0.0.1";
  const candidates = [get("--editor-dir"), path.resolve(here, "../../../apps/editor/dist"), path.resolve(here, "../editor")].filter(Boolean) as string[];
  const editorDir = candidates.find((d) => fs.existsSync(path.join(d, "index.html"))) ?? null;
  const origins = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, "http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:4173", "http://127.0.0.1:4173"];
  argv.forEach((a, i) => a === "--allow-origin" && argv[i + 1] && origins.push(argv[i + 1]));
  const tokenFile = tokenFilePath();
  return {
    host,
    port,
    token: loadOrCreateToken(tokenFile),
    tokenFile,
    exportDir: path.resolve(get("--export-dir") ?? process.env.AMAI_EXPORT_DIR ?? path.join(os.homedir(), "AfterMotionAI", "exports")),
    editorDir,
    http: argv.includes("--http"),
    stdio: !argv.includes("--no-stdio"),
    headless: argv.includes("--headless"),
    projectFile: get("--project") ? path.resolve(get("--project")!) : null,
    allowedOrigins: origins,
    requestTimeoutMs: 120_000,
    exportTimeoutMs: 60 * 60_000,
    maxImportBytes: 512 * 1024 * 1024,
  };
}

export { HELP };
