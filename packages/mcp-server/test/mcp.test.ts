import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import httpLib from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { EditorEngine } from "@amai/core";
import { EditorBridgeClient } from "@amai/bridge";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverJs = path.resolve(here, "../dist/index.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amai-mcp-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const tokenFile = path.join(tmp, "token");
const exportDir = path.join(tmp, "exports");

let client: Client;
let transport: StdioClientTransport;
let token: string;
const engine = new EditorEngine();
let approveNext: boolean[] = [];
const approvalsAsked: string[] = [];
let imported: any = null;
let bridge: EditorBridgeClient;

function text(r: any) {
  return r.content.find((c: any) => c.type === "text")?.text as string;
}
async function call(name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as any;
}
async function waitFor(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs, "--port", String(port), "--export-dir", exportDir, "--http"],
    env: { ...process.env, AMAI_TOKEN_FILE: tokenFile } as Record<string, string>,
    stderr: "pipe",
  });
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(transport);
  await waitFor(() => fs.existsSync(tokenFile));
  token = fs.readFileSync(tokenFile, "utf8").trim();
});

afterAll(async () => {
  bridge?.disconnect();
  await client?.close();
});

describe("serveur MCP AFTER MOTION AI", () => {
  it("expose les outils requis avec des schémas", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["get_project_info", "create_project", "get_timeline", "create_layer", "delete_layer", "update_layer", "add_keyframe", "create_animation", "apply_effect", "create_text", "import_media", "export_video", "get_preview", "undo_action", "redo_action", "get_connection_status"]) {
      expect(names).toContain(n);
    }
    const cl = tools.find((t) => t.name === "create_layer")!;
    expect(cl.inputSchema.type).toBe("object");
    expect((cl.inputSchema as any).required).toContain("type");
    expect(tools.find((t) => t.name === "delete_layer")!.annotations?.destructiveHint).toBe(true);
  });

  it("refuse d'agir sans éditeur connecté", async () => {
    const st = JSON.parse(text(await call("get_connection_status")));
    expect(st.editorConnected).toBe(false);
    const r = await call("create_text", { text: "x" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("editor_not_connected");
  });

  it("rejette un éditeur avec un mauvais jeton", async () => {
    let status = "";
    const bad = new EditorBridgeClient({ url: `ws://127.0.0.1:${port}/bridge`, token: "mauvais", engine: new EditorEngine(), requestApproval: async () => true, reconnectDelay: 0, onStatus: (s) => (status = s) });
    bad.connect();
    await waitFor(() => status === "rejected");
    bad.disconnect();
  });

  it("contrôle le projet ouvert dans l'éditeur connecté", async () => {
    let status = "";
    bridge = new EditorBridgeClient({
      url: `ws://127.0.0.1:${port}/bridge`,
      token,
      engine,
      reconnectDelay: 0,
      onStatus: (s) => (status = s),
      requestApproval: async (tool) => {
        approvalsAsked.push(tool);
        return approveNext.shift() ?? false;
      },
      host: {
        renderPreview: async ({ time, width }) => ({ mimeType: "image/png", data: Buffer.from("fakepng").toString("base64"), width: width ?? 640, height: 360, time }),
        exportVideo: async (o, onProgress) => {
          onProgress?.(0.5);
          return { fileName: o.fileName ?? "film.mp4", mimeType: "video/mp4", size: 4, duration: 1, frames: 30, codec: "avc1", data: Buffer.from("MP4!").toString("base64") };
        },
        importMedia: async (req) => {
          imported = req;
          return engine.addAsset({ name: req.name ?? "media", kind: "image", mimeType: "image/png", size: 3, width: 10, height: 10, src: "mem" }, "mcp");
        },
      },
    });
    bridge.connect();
    await waitFor(() => status === "connected");
    expect(JSON.parse(text(await call("get_connection_status"))).editorConnected).toBe(true);

    const created = JSON.parse(text(await call("create_text", { text: "Depuis Claude", animation: "bounceIn" })));
    expect(engine.comp().layers).toHaveLength(1);
    expect(engine.comp().layers[0].props.text).toBe("Depuis Claude");
    expect(created.animatedProperties).toContain("transform.positionY");

    await call("add_keyframe", { layerId: created.id, property: "rotation", time: 1, value: 90, easing: "expoOut" });
    expect(engine.getValue(created.id, "rotation", 2)).toBe(90);
    const fx = await call("apply_effect", { layerId: created.id, effect: "glow", params: { intensity: 2 } });
    expect(fx.isError).toBeFalsy();
    const tl = JSON.parse(text(await call("get_timeline")));
    expect(tl.layers[0].effects[0].type).toBe("glow");

    // erreurs de validation renvoyées proprement
    const bad = await call("add_keyframe", { layerId: created.id, property: "rotation" });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("invalid_arguments");

    // chaque appel MCP = une entrée d'historique « mcp » annulable
    const hist = engine.store.history().undo;
    expect(hist[hist.length - 1].source).toBe("mcp");
    const u = JSON.parse(text(await call("undo_action")));
    expect(u.undone[0]).toBe("MCP : apply_effect");
    expect(engine.comp().layers[0].effects).toHaveLength(0);
    await call("redo_action");
    expect(engine.comp().layers[0].effects).toHaveLength(1);
  });

  it("demande l'accord de l'utilisateur pour les actions sensibles", async () => {
    const id = engine.comp().layers[0].id;
    approveNext = [false];
    const denied = await call("delete_layer", { layerIds: [id] });
    expect(denied.isError).toBe(true);
    expect(text(denied)).toContain("denied");
    expect(engine.comp().layers).toHaveLength(1);
    approveNext = [true];
    const ok = await call("delete_layer", { layerIds: [id] });
    expect(ok.isError).toBeFalsy();
    expect(engine.comp().layers).toHaveLength(0);
    expect(approvalsAsked).toEqual(["delete_layer", "delete_layer"]);
  });

  it("import_media lit un fichier local après accord", async () => {
    const png = path.join(tmp, "logo.png");
    fs.writeFileSync(png, Buffer.from([1, 2, 3]));
    approveNext = [false];
    expect((await call("import_media", { path: png })).isError).toBe(true);
    expect(imported).toBeNull();
    approveNext = [true];
    const r = JSON.parse(text(await call("import_media", { path: png })));
    expect(imported.url).toBe("data:image/png;base64,AQID");
    expect(r.layerId).toBeTruthy();
    approveNext = [true];
    const missing = await call("import_media", { path: path.join(tmp, "nope.png") });
    expect(text(missing)).toContain("introuvable");
  });

  it("get_preview renvoie une image MCP et export_video écrit le fichier", async () => {
    const p = await call("get_preview", { time: 0.5, width: 320 });
    const img = p.content.find((c: any) => c.type === "image");
    expect(img.mimeType).toBe("image/png");
    expect(Buffer.from(img.data, "base64").toString()).toBe("fakepng");

    approveNext = [true];
    const progress: number[] = [];
    const ex = (await client.callTool({ name: "export_video", arguments: { format: "mp4", fileName: "film.mp4" } }, undefined, { onprogress: (p) => progress.push(p.progress) })) as any;
    const meta = JSON.parse(text(ex));
    expect(fs.readFileSync(meta.path, "utf8")).toBe("MP4!");
    expect(meta.path.startsWith(exportDir)).toBe(true);
    expect(progress).toContain(50);
  });

  it("transport Streamable HTTP protégé par jeton", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(401);
    const http = new Client({ name: "http-client", version: "1.0.0" });
    await http.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    const r = (await http.callTool({ name: "get_project_info", arguments: {} })) as any;
    expect(JSON.parse(text(r)).activeComposition.width).toBe(1920);
    await http.close();
  });

  it("bloque le DNS rebinding et les origines inconnues", async () => {
    // fetch() interdit de modifier Host : requête bas niveau.
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpLib.request({ host: "127.0.0.1", port, path: "/health", headers: { host: "evil.example" } }, (res) => resolve(res.statusCode!));
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
    const info = await fetch(`http://127.0.0.1:${port}/bridge/info`, { headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example" } });
    expect(info.status).toBe(403);
  });
});

describe("mode headless", () => {
  it("exécute les outils sans éditeur et sauvegarde le projet", async () => {
    const projectFile = path.join(tmp, "headless.amai.json");
    const t = new StdioClientTransport({
      command: process.execPath,
      args: [serverJs, "--port", String(port + 1), "--headless", "--project", projectFile],
      env: { ...process.env, AMAI_TOKEN_FILE: tokenFile } as Record<string, string>,
      stderr: "pipe",
    });
    const c = new Client({ name: "h", version: "1" });
    await c.connect(t);
    const r = (await c.callTool({ name: "create_layer", arguments: { type: "shape", props: { shapeKind: "star", fill: "#ff0000" } } })) as any;
    expect(r.isError).toBeFalsy();
    const prev = (await c.callTool({ name: "get_preview", arguments: {} })) as any;
    expect(prev.isError).toBe(true);
    await c.close();
    const saved = JSON.parse(fs.readFileSync(projectFile, "utf8"));
    expect(saved.project.compositions[0].layers[0].props.fill.value).toBe("#ff0000");
  });
});
