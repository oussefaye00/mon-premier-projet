import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, toolJsonSchema } from "@amai/core";
import type { Dispatcher } from "./dispatcher";

export const SERVER_INFO = { name: "after-motion-ai", version: "0.1.0" };

const INSTRUCTIONS = `AFTER MOTION AI est un éditeur vidéo et de motion design. Ce serveur contrôle le projet RÉELLEMENT ouvert dans l'éditeur de l'utilisateur.
- Commencez par get_connection_status puis get_timeline pour connaître l'état.
- Temps en secondes ; positions en pixels (origine en haut à gauche, contenu centré sur la position) ; échelle/opacité en % ; rotation en degrés.
- Chaque appel d'outil crée une entrée d'historique annulable (undo_action) visible par l'utilisateur.
- create_project, delete_layer, import_media et export_video sont des actions sensibles : l'utilisateur doit les approuver dans l'éditeur.
- Utilisez get_preview pour vérifier visuellement le rendu.`;

/** Crée une instance de serveur MCP (une par transport / session). */
export function createMcpServer(dispatcher: Dispatcher): Server {
  const server = new Server(SERVER_INFO, { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "get_connection_status",
        title: "État de la connexion",
        description: "Indique si l'éditeur AFTER MOTION AI est connecté à ce serveur MCP, et comment l'ouvrir sinon.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      ...TOOLS.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: toolJsonSchema(t as any) as { type: "object"; [k: string]: unknown },
        annotations: {
          title: t.title,
          readOnlyHint: !!t.readOnly,
          destructiveHint: !!t.sensitive && t.name !== "import_media",
          idempotentHint: !!t.readOnly,
          openWorldHint: t.name === "import_media",
        },
      })),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const { name, arguments: args = {} } = req.params;
    if (name === "get_connection_status") {
      return { content: [{ type: "text", text: JSON.stringify(dispatcher.status(), null, 2) }] };
    }
    const progressToken = req.params._meta?.progressToken;
    const onProgress =
      progressToken !== undefined
        ? (p: number, message?: string) =>
            void extra
              .sendNotification({ method: "notifications/progress", params: { progressToken, progress: Math.round(p * 1000) / 10, total: 100, message } })
              .catch(() => {})
        : undefined;
    const { outcome, image } = await dispatcher.call(name, args as Record<string, unknown>, onProgress);
    if (!outcome.ok) {
      return { isError: true, content: [{ type: "text", text: `Erreur (${outcome.error!.code}) : ${outcome.error!.message}` }] };
    }
    const content: CallToolResult["content"] = [];
    if (image) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    content.push({ type: "text", text: JSON.stringify(outcome.result ?? { ok: true }, null, 2) });
    return { content };
  });

  return server;
}
