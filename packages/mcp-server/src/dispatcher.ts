import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { EditorEngine, executeTool, getTool, parseProjectFile, serializeProject, type ToolCallOutcome } from "@amai/core";
import type { BridgeServer } from "./bridge-server";
import type { ServerConfig } from "./config";
import { log } from "./log";

const EXT_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
};

export interface DispatchResult {
  outcome: ToolCallOutcome;
  /** Contenu image (aperçu) à renvoyer au client MCP. */
  image?: { data: string; mimeType: string };
}

/**
 * Achemine chaque appel d'outil MCP :
 *  - vers l'éditeur connecté (cas normal : contrôle du projet réellement ouvert),
 *  - sinon, en mode --headless, vers un moteur local (sans rendu).
 * Gère aussi ce qui dépend du système de fichiers (lecture de médias, écriture des exports).
 */
export class Dispatcher {
  private headless: EditorEngine | null = null;

  constructor(private cfg: ServerConfig, private bridge: BridgeServer) {
    if (cfg.headless) {
      this.headless = new EditorEngine();
      if (cfg.projectFile && fs.existsSync(cfg.projectFile)) {
        this.headless.loadProject(parseProjectFile(fs.readFileSync(cfg.projectFile, "utf8")).project);
        log("Projet headless chargé :", cfg.projectFile);
      }
      this.headless.store.subscribe(() => this.saveHeadless());
    }
  }

  private saveHeadless() {
    if (!this.headless || !this.cfg.projectFile) return;
    fs.mkdirSync(path.dirname(this.cfg.projectFile), { recursive: true });
    fs.writeFileSync(this.cfg.projectFile, serializeProject(this.headless.project));
  }

  status() {
    return {
      editorConnected: this.bridge.connected,
      mode: this.bridge.connected ? "editor" : this.headless ? "headless" : "none",
      editorUrl: this.cfg.editorDir ? `${this.bridge.url}/` : null,
      bridgeUrl: `ws://127.0.0.1:${this.cfg.port}/bridge`,
      tokenFile: this.cfg.tokenFile,
      exportDir: this.cfg.exportDir,
      message: this.bridge.connected ? "Éditeur connecté : les outils agissent sur le projet ouvert." : this.bridge.notConnectedMessage(),
    };
  }

  async call(tool: string, args: Record<string, unknown>, onProgress?: (p: number, m?: string) => void): Promise<DispatchResult> {
    let def;
    try {
      def = getTool(tool);
    } catch (e) {
      return { outcome: { ok: false, error: { code: "unknown_tool", message: (e as Error).message } } };
    }

    if (!this.bridge.connected) {
      if (this.headless) {
        if (tool === "get_preview" || tool === "export_video" || tool === "import_media") {
          return { outcome: { ok: false, error: { code: "unsupported", message: `${tool} nécessite l'éditeur (rendu navigateur). ${this.bridge.notConnectedMessage()}` } } };
        }
        return { outcome: await executeTool({ engine: this.headless, source: "mcp" }, tool, args) };
      }
      return { outcome: { ok: false, error: { code: "editor_not_connected", message: this.bridge.notConnectedMessage() } } };
    }

    const id = randomUUID();
    let approved = false;
    if (def.sensitive) {
      // Vérification des autorisations AVANT toute action (y compris la lecture de fichiers locaux).
      approved = await this.bridge.requestApproval(id, tool, args, describe(tool, args));
      if (!approved) return { outcome: { ok: false, error: { code: "denied", message: "L'utilisateur a refusé cette action dans l'éditeur (ou n'a pas répondu)." } } };
    }

    let forwarded = args;
    if (tool === "import_media" && typeof args.path === "string") {
      const r = this.readLocalMedia(args.path);
      if ("error" in r) return { outcome: { ok: false, error: { code: "invalid_arguments", message: r.error } } };
      forwarded = { ...args, path: undefined, url: `data:${r.mimeType};base64,${r.data}`, name: args.name ?? r.name };
    }

    const outcome = await this.bridge.call(tool, forwarded, {
      id,
      approved,
      timeoutMs: tool === "export_video" ? this.cfg.exportTimeoutMs : undefined,
      onProgress,
    });
    if (!outcome.ok) return { outcome };

    if (tool === "get_preview") {
      const r = outcome.result as { data: string; mimeType: string; width: number; height: number; time: number };
      return { outcome: { ok: true, result: { width: r.width, height: r.height, time: r.time, mimeType: r.mimeType } }, image: { data: r.data, mimeType: r.mimeType } };
    }
    if (tool === "export_video") {
      const r = outcome.result as { data?: string; fileName: string; mimeType: string; size: number; duration: number; frames: number; codec: string };
      if (!r.data) return { outcome: { ok: false, error: { code: "export_failed", message: "L'éditeur n'a pas renvoyé de données vidéo." } } };
      fs.mkdirSync(this.cfg.exportDir, { recursive: true });
      const safe = path.basename(r.fileName).replace(/[^\w.\- ]+/g, "_") || `export.${r.mimeType.includes("webm") ? "webm" : "mp4"}`;
      let file = path.join(this.cfg.exportDir, safe);
      if (fs.existsSync(file)) file = path.join(this.cfg.exportDir, `${path.parse(safe).name}-${Date.now()}${path.extname(safe)}`);
      fs.writeFileSync(file, Buffer.from(r.data, "base64"));
      log("Export écrit :", file);
      const { data: _omit, ...meta } = r;
      return { outcome: { ok: true, result: { ...meta, path: file } } };
    }
    return { outcome };
  }

  private readLocalMedia(p: string): { data: string; mimeType: string; name: string } | { error: string } {
    const file = path.resolve(p);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return { error: `Fichier introuvable : ${file}` };
    }
    if (!st.isFile()) return { error: "Le chemin doit désigner un fichier." };
    const mimeType = EXT_MIME[path.extname(file).toLowerCase()];
    if (!mimeType) return { error: `Type de fichier non pris en charge : ${path.extname(file)} (formats : ${Object.keys(EXT_MIME).join(" ")})` };
    if (st.size > this.cfg.maxImportBytes) return { error: `Fichier trop volumineux (${Math.round(st.size / 1e6)} Mo, max ${Math.round(this.cfg.maxImportBytes / 1e6)} Mo).` };
    return { data: fs.readFileSync(file).toString("base64"), mimeType, name: path.basename(file) };
  }
}

function describe(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "create_project":
      return `Créer un nouveau projet « ${args.name ?? "Nouveau projet"} » (le projet actuel sera fermé, il reste dans la sauvegarde automatique).`;
    case "delete_layer":
      return `Supprimer ${(args.layerIds as string[] | undefined)?.length ?? 0} calque(s).`;
    case "import_media":
      return `Importer le média ${args.path ?? String(args.url ?? "").slice(0, 120)}.`;
    case "export_video":
      return `Exporter la vidéo (${args.format ?? "mp4"}) vers le dossier d'export.`;
    default:
      return `Exécuter ${tool}.`;
  }
}
