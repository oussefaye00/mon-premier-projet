/**
 * Tests de bout en bout d'AFTER MOTION AI dans un vrai navigateur (Chromium / Playwright).
 *
 *  - lance le serveur MCP compilé (qui sert aussi l'éditeur compilé),
 *  - pilote l'interface (outils, IA, import, découpe, export),
 *  - se connecte en client MCP (SDK officiel, transport stdio) et vérifie que les outils
 *    contrôlent réellement le projet ouvert dans le navigateur,
 *  - valide les fichiers vidéo exportés avec ffprobe.
 *
 * Prérequis : `npm run build`, Playwright + Chromium, ffmpeg/ffprobe.
 * Usage : node tests/e2e/run-e2e.mjs
 */
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const out = path.join(root, "test-output");
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "amai-e2e-"));
const serverJs = path.join(root, "packages/mcp-server/dist/index.js");
const exportDir = path.join(tmp, "exports");
const tokenFile = path.join(tmp, "token");
const PORT = 21000 + Math.floor(Math.random() * 9000);
const URL0 = `http://127.0.0.1:${PORT}/`;

let failures = 0;
let passed = 0;
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    results.push(`✔ ${name} (${Date.now() - t0} ms)`);
    console.log(`✔ ${name}`);
  } catch (e) {
    failures++;
    results.push(`✘ ${name}: ${e.message}`);
    console.log(`✘ ${name}\n   ${e.stack?.split("\n").slice(0, 4).join("\n   ")}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, msg = "condition") {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Délai dépassé : ${msg}`);
    await sleep(50);
  }
}
function ffprobe(file) {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-count_frames", "-of", "json", file]).toString());
}

// ---------------------------------------------------------------- médias de test
const media = {
  video: path.join(tmp, "clip.mp4"),
  png: path.join(tmp, "rouge.png"),
  svg: path.join(tmp, "logo.svg"),
  wav: path.join(tmp, "son.wav"),
};
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=0x00ff00:s=640x360:r=30:d=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", "-y", media.video]);
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=200x200", "-frames:v", "1", "-y", media.png]);
execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", "-y", media.wav]);
fs.writeFileSync(media.svg, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300" viewBox="0 0 300 300"><circle cx="150" cy="150" r="140" fill="#0000ff"/></svg>`);

// ---------------------------------------------------------------- démarrage
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverJs, "--port", String(PORT), "--export-dir", exportDir],
  env: { ...process.env, AMAI_TOKEN_FILE: tokenFile },
  stderr: "pipe",
});
const mcp = new Client({ name: "e2e", version: "1.0.0" });
await mcp.connect(transport);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await ctx.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(e.message));
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
const A = (fn, arg) => page.evaluate(fn, arg);
const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  return { r, json: (() => { try { return JSON.parse(r.content.find((c) => c.type === "text")?.text ?? "null"); } catch { return null; } })(), text: r.content.find((c) => c.type === "text")?.text };
};
/** Couleur moyenne d'une zone du canvas de prévisualisation (coordonnées de composition). */
const pixel = (x, y) =>
  A(
    ([x, y]) =>
      new Promise((res) => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const c = document.querySelector("[data-testid=viewer-canvas]");
            const comp = window.__amai.engine.comp();
            const k = c.width / comp.width;
            const d = c.getContext("2d").getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
            res([d[0], d[1], d[2], d[3]]);
          }),
        );
      }),
    [x, y],
  );

try {
  await page.goto(URL0 + "?new");
  await page.waitForSelector("[data-testid=viewer-canvas]");

  await test("L'éditeur se charge avec le projet de démonstration et se connecte au serveur MCP", async () => {
    await waitFor(() => A(() => window.__amai.bridgeStatus === "connected"), 8000, "connexion pont");
    const n = await A(() => window.__amai.engine.comp().layers.length);
    assert(n >= 4, `projet de démo attendu, ${n} calques`);
    await page.screenshot({ path: path.join(out, "01-editeur.png") });
  });

  await test("Nouveau projet via l'interface (1080×1920, 30 i/s)", async () => {
    await page.click("text=Nouveau");
    await page.click(".chip:has-text('Reels')");
    await page.click("[data-testid=create-project]");
    await waitFor(() => A(() => window.__amai.engine.comp().layers.length === 0 && window.__amai.engine.comp().width === 1080), 5000, "projet vide");
  });

  await test("Outil texte : clic dans la vue → calque texte rendu dans le canvas", async () => {
    await A(() => window.__amai.engine.updateComposition({ background: "#000000", width: 1280, height: 720 }));
    await page.click("[data-testid=tool-text]");
    const box = await page.locator("[data-testid=viewer-canvas]").boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await waitFor(() => A(() => window.__amai.engine.comp().layers.some((l) => l.type === "text")), 3000, "texte créé");
    await page.fill("[data-testid=text-content]", "MOTION");
    await page.locator("[data-testid=text-content]").blur();
    await waitFor(() => A(() => window.__amai.engine.comp().layers[0].props.text === "MOTION"), 3000, "texte modifié");
    // Le texte blanc doit être visible au centre
    const lum = await A(() => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      const c = document.querySelector("[data-testid=viewer-canvas]");
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let white = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200) white++;
      res(white);
    }))));
    assert(lum > 200, `pixels blancs du texte attendus, ${lum}`);
  });

  await test("Déplacement à la souris dans la vue (une seule entrée d'historique)", async () => {
    const before = await A(() => ({ x: window.__amai.engine.comp().layers[0].transform.positionX.value, h: window.__amai.engine.store.history().undo.length }));
    const box = await page.locator("[data-testid=viewer-canvas]").boundingBox();
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(cx + i * 10, cy, { steps: 1 });
    await page.mouse.up();
    const after = await A(() => ({ x: window.__amai.engine.comp().layers[0].transform.positionX.value, h: window.__amai.engine.store.history().undo.length }));
    assert(after.x > before.x + 50, `position X attendue en hausse (${before.x} → ${after.x})`);
    assert(after.h === before.h + 1, `une seule entrée d'historique attendue (${before.h} → ${after.h})`);
    await page.click("[data-testid=undo]");
    assert((await A(() => window.__amai.engine.comp().layers[0].transform.positionX.value)) === before.x, "undo du déplacement");
  });

  await test("Assistant IA local : « Fais apparaître ce texte avec un effet de rebond. » → plan, application, annulation", async () => {
    await page.click("[data-testid=side-ai]");
    await page.fill("[data-testid=ai-input]", "Fais apparaître ce texte avec un effet de rebond.");
    await page.click("[data-testid=ai-send]");
    await page.waitForSelector("[data-testid=apply-plan]");
    // Rien n'est modifié tant que le plan n'est pas appliqué
    assert(!(await A(() => window.__amai.engine.comp().layers[0].transform.positionY.keyframes)), "aucune modification avant application");
    await page.click("[data-testid=apply-plan]");
    await waitFor(() => A(() => window.__amai.engine.comp().layers[0].transform.positionY.keyframes?.length > 0), 3000, "keyframes IA");
    const easing = await A(() => window.__amai.engine.comp().layers[0].transform.positionY.keyframes[0].easing.type);
    assert(easing === "bounce", `easing bounce attendu, ${easing}`);
    await page.screenshot({ path: path.join(out, "02-assistant-ia.png") });
    await page.click("[data-testid=undo-ai]");
    await waitFor(() => A(() => !window.__amai.engine.comp().layers[0].transform.positionY.keyframes), 3000, "annulation IA");
  });

  await test("Assistant IA local : particules + caméra dynamique + optimisation", async () => {
    await A(() => window.__amai.saveSettings({ confirmAIPlans: false }));
    for (const q of ["Crée une animation de particules.", "Ajoute un effet de caméra dynamique.", "Optimise les animations de ce projet."]) {
      await page.fill("[data-testid=ai-input]", q);
      await page.click("[data-testid=ai-send]");
      await sleep(300);
    }
    await waitFor(() => A(() => window.__amai.engine.comp().layers.some((l) => l.type === "particles") && window.__amai.engine.comp().layers.some((l) => l.type === "camera")), 5000, "particules et caméra");
    const hist = await A(() => window.__amai.engine.store.history().undo.filter((e) => e.source === "ai").length);
    assert(hist >= 3, `3 entrées IA attendues, ${hist}`);
    // Nettoyage pour la suite
    await A(() => { const e = window.__amai.engine; e.deleteLayers(e.comp().layers.filter((l) => l.type !== "text").map((l) => l.id)); window.__amai.saveSettings({ confirmAIPlans: true }); });
  });

  await test("Import de médias (vidéo+audio, PNG, SVG, WAV) via la bibliothèque", async () => {
    await page.click("[data-testid=tab-media]");
    await page.setInputFiles("[data-testid=media-input]", [media.video, media.png, media.svg, media.wav]);
    await waitFor(() => A(() => window.__amai.engine.project.assets.length === 4), 15000, "4 médias importés");
    const kinds = await A(() => window.__amai.engine.project.assets.map((a) => `${a.kind}:${a.width ?? ""}x${a.height ?? ""}:${a.duration ? Math.round(a.duration) : ""}`).sort());
    assert(kinds.includes("video:640x360:3") && kinds.includes("image:200x200:") && kinds.includes("svg:300x300:") && kinds.some((k) => k.startsWith("audio:")), `métadonnées : ${kinds}`);
    const types = await A(() => window.__amai.engine.comp().layers.map((l) => l.type).sort().join(","));
    assert(types === "audio,image,image,text,video", `calques créés : ${types}`);
  });

  await test("La vidéo importée est réellement décodée et rendue dans l'aperçu", async () => {
    await A(() => {
      const e = window.__amai.engine;
      for (const l of e.comp().layers) if (l.type !== "video") e.updateLayer(l.id, { visible: false });
      const v = e.comp().layers.find((l) => l.type === "video");
      e.updateLayer(v.id, { transform: { scaleX: 200, scaleY: 200, positionX: 640, positionY: 360 } });
      window.__amai.seek(1);
    });
    const px = await waitFor(async () => {
      const p = await pixel(640, 360);
      return p[1] > 200 && p[0] < 60 ? p : null;
    }, 8000, "pixel vert de la vidéo");
    assert(px[1] > 200, "vert attendu");
  });

  await test("Image PNG et SVG rendues ; masque et effets appliqués sans erreur", async () => {
    await A(() => {
      const e = window.__amai.engine;
      for (const l of e.comp().layers) e.updateLayer(l.id, { visible: false });
      const png = e.comp().layers.find((l) => l.type === "image" && l.name.endsWith(".png"));
      const svg = e.comp().layers.find((l) => l.type === "image" && l.name.endsWith(".svg"));
      e.updateLayer(png.id, { visible: true, transform: { positionX: 300, positionY: 360 } });
      e.updateLayer(svg.id, { visible: true, transform: { positionX: 900, positionY: 360 } });
      e.addEffect(svg.id, "dropShadow", {});
      e.addEffect(png.id, "glow", { intensity: 1, color: "#ff0000" });
      e.addMask(png.id, { shape: "ellipse", x: -100, y: -100, width: 200, height: 200, feather: 4 });
      e.updateLayer(png.id, { motionBlur: true });
      e.addKeyframe(png.id, "positionX", 0.9, 200);
      e.addKeyframe(png.id, "positionX", 1.1, 400);
      window.__amai.seek(1.05);
    });
    const red = await waitFor(async () => { const p = await pixel(300, 360); return p[0] > 150 && p[1] < 100 ? p : null; }, 5000, "PNG rouge rendu");
    const blue = await waitFor(async () => { const p = await pixel(900, 360); return p[2] > 150 && p[0] < 80 ? p : null; }, 5000, "SVG bleu rendu");
    // Coin du carré PNG masqué par l'ellipse → fond noir
    const corner = await pixel(300 - 95, 360 - 95);
    assert(corner[0] < 80, `le masque elliptique doit couper le coin (${corner})`);
    assert(red && blue, "rendu image");
    await page.screenshot({ path: path.join(out, "03-medias-effets.png") });
  });

  await test("Découpe puis fusion d'un clip vidéo depuis la timeline", async () => {
    await A(() => {
      const e = window.__amai.engine;
      for (const l of e.comp().layers) e.updateLayer(l.id, { visible: true });
      const v = e.comp().layers.find((l) => l.type === "video");
      e.select([v.id]);
      window.__amai.seek(1.5);
    });
    await page.click("[data-testid=split]");
    const parts = await A(() => window.__amai.engine.comp().layers.filter((l) => l.type === "video").map((l) => [l.inPoint, l.outPoint, l.props.mediaOffset]));
    assert(parts.length === 2 && parts.some((p) => p[0] === 1.5 && Math.abs(p[2] - 1.5) < 1e-6), `découpe : ${JSON.stringify(parts)}`);
    await A(() => window.__amai.engine.select(window.__amai.engine.comp().layers.filter((l) => l.type === "video").map((l) => l.id)));
    await page.click("text=Fusionner");
    const merged = await A(() => window.__amai.engine.comp().layers.filter((l) => l.type === "video").map((l) => [l.inPoint, l.outPoint]));
    assert(merged.length === 1 && merged[0][1] === 3, `fusion : ${JSON.stringify(merged)}`);
  });

  await test("Export MP4 depuis l'interface : fichier H.264 valide (ffprobe), audio mixé", async () => {
    await A(() => {
      const e = window.__amai.engine;
      e.updateComposition({ duration: 2, fps: 30 });
    });
    await page.click("[data-testid=open-export]");
    await page.click("[data-testid=fmt-mp4]");
    await page.click("[data-testid=start-export]");
    await page.waitForSelector("[data-testid=export-result]", { timeout: 120000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-testid=download-export]")]);
    const file = path.join(out, "export-ui.mp4");
    await dl.saveAs(file);
    const info = ffprobe(file);
    const v = info.streams.find((s) => s.codec_type === "video");
    const a = info.streams.find((s) => s.codec_type === "audio");
    assert(v.codec_name === "h264", `codec ${v.codec_name}`);
    assert(v.width === 1280 && v.height === 720, `taille ${v.width}x${v.height}`);
    assert(+v.nb_read_frames === 60, `60 images attendues, ${v.nb_read_frames}`);
    assert(Math.abs(+info.format.duration - 2) < 0.1, `durée ${info.format.duration}`);
    assert(a, "piste audio attendue (vidéo + WAV)");
    // Vérifie une image du milieu : la vidéo verte doit apparaître
    const png = path.join(out, "export-frame.png");
    execFileSync("ffmpeg", ["-v", "error", "-ss", "1.0", "-i", file, "-frames:v", "1", "-y", png]);
    assert(fs.statSync(png).size > 1000, "image extraite");
    await page.screenshot({ path: path.join(out, "04-export.png") });
    await page.keyboard.press("Escape");
    console.log(`   ↳ ${v.codec_name} ${v.width}x${v.height} ${v.nb_read_frames} images, audio ${a.codec_name}, ${info.format.size} octets`);
  });

  await test("Export WebM (VP9) depuis l'interface", async () => {
    await page.click("[data-testid=open-export]");
    if (await page.locator("text=Nouvel export").count()) await page.click("text=Nouvel export");
    await page.click("[data-testid=fmt-webm]");
    await page.click("[data-testid=start-export]");
    await page.waitForSelector("[data-testid=export-result]", { timeout: 120000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("[data-testid=download-export]")]);
    const file = path.join(out, "export-ui.webm");
    await dl.saveAs(file);
    const v = ffprobe(file).streams.find((s) => s.codec_type === "video");
    assert(v.codec_name === "vp9" && +v.nb_read_frames === 60, `webm ${v.codec_name} ${v.nb_read_frames}`);
    await page.keyboard.press("Escape");
  });

  // ------------------------------------------------------------ MCP réel → navigateur
  await test("MCP : create_text depuis un client MCP apparaît dans l'éditeur ouvert", async () => {
    const n0 = await A(() => window.__amai.engine.comp().layers.length);
    const { json, r } = await call("create_text", { text: "Depuis Claude", fontSize: 90, color: "#ff00ff", y: 120, animation: "popIn" });
    assert(!r.isError, JSON.stringify(r.content));
    await waitFor(() => A((id) => window.__amai.engine.comp().layers.some((l) => l.id === id), json.id), 3000, "calque dans le navigateur");
    assert((await A(() => window.__amai.engine.comp().layers.length)) === n0 + 1, "un calque de plus");
    await page.click("[data-testid=side-mcp]");
    await page.waitForSelector(".act .tool-tag:has-text('create_text')");
    const src = await A(() => window.__amai.engine.store.history().undo.at(-1).source);
    assert(src === "mcp", `source historique ${src}`);
  });

  await test("MCP : get_timeline, add_keyframe, apply_effect, update_layer, undo/redo", async () => {
    const tl = (await call("get_timeline")).json;
    const t = tl.layers.find((l) => l.name === "Depuis Claude");
    assert(t, "texte présent dans get_timeline");
    assert(!(await call("add_keyframe", { layerId: t.id, property: "rotation", time: 0, value: 0 })).r.isError, "kf1");
    assert(!(await call("add_keyframe", { layerId: t.id, property: "rotation", time: 1, value: 180, easing: "expoOut" })).r.isError, "kf2");
    assert(!(await call("apply_effect", { layerId: t.id, effect: "glow", params: { color: "#ffffff" } })).r.isError, "effet");
    assert(!(await call("update_layer", { layerId: t.id, transitionOut: { type: "fade", duration: 0.3 } })).r.isError, "transition");
    const rot = await A((id) => window.__amai.engine.getValue(id, "rotation", 1), t.id);
    assert(rot === 180, `rotation ${rot}`);
    await call("undo_action");
    assert((await A((id) => window.__amai.engine.findLayer(id).layer.transitionOut, t.id)) === null, "undo transition");
    await call("redo_action");
    assert((await A((id) => window.__amai.engine.findLayer(id).layer.transitionOut?.type, t.id)) === "fade", "redo transition");
    const bad = await call("add_keyframe", { layerId: t.id, property: "nope", time: 1, value: 1 });
    assert(bad.r.isError && bad.text.includes("introuvable"), "erreur propriété inconnue");
  });

  await test("MCP : get_preview renvoie une vraie image PNG rendue par l'éditeur", async () => {
    const r = await mcp.callTool({ name: "get_preview", arguments: { time: 1, width: 480, format: "png" } });
    const img = r.content.find((c) => c.type === "image");
    assert(img && img.mimeType === "image/png", "contenu image");
    const buf = Buffer.from(img.data, "base64");
    assert(buf.subarray(1, 4).toString() === "PNG", "signature PNG");
    fs.writeFileSync(path.join(out, "mcp-preview.png"), buf);
    assert(buf.readUInt32BE(16) === 480 && buf.readUInt32BE(20) === 270, `taille ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`);
  });

  await test("MCP : action sensible → dialogue d'autorisation dans l'éditeur (refus puis accord)", async () => {
    const id = await A(() => window.__amai.engine.comp().layers.find((l) => l.name === "Depuis Claude").id);
    const p1 = call("delete_layer", { layerIds: [id] });
    await page.waitForSelector("[data-testid=approval-dialog]");
    await page.screenshot({ path: path.join(out, "05-autorisation-mcp.png") });
    await page.click("[data-testid=approval-deny]");
    const r1 = await p1;
    assert(r1.r.isError && r1.text.includes("denied"), "refus renvoyé au client MCP");
    assert(await A((i) => window.__amai.engine.comp().layers.some((l) => l.id === i), id), "calque conservé");
    const p2 = call("delete_layer", { layerIds: [id] });
    await page.waitForSelector("[data-testid=approval-dialog]");
    await page.click("[data-testid=approval-allow]");
    const r2 = await p2;
    assert(!r2.r.isError, r2.text);
    assert(!(await A((i) => window.__amai.engine.comp().layers.some((l) => l.id === i), id)), "calque supprimé");
  });

  await test("MCP : import_media d'un fichier local + export_video écrit un MP4 valide sur disque", async () => {
    const pImp = call("import_media", { path: media.png, addToTimeline: true });
    await page.waitForSelector("[data-testid=approval-dialog]");
    await page.click("[data-testid=approval-allow]");
    const imp = await pImp;
    assert(!imp.r.isError && imp.json.asset.kind === "image", imp.text);
    const pExp = call("export_video", { format: "mp4", fileName: "via-mcp.mp4", width: 640, end: 1 });
    await page.waitForSelector("[data-testid=approval-dialog]");
    await page.click("[data-testid=approval-allow]");
    const ex = await pExp;
    assert(!ex.r.isError, ex.text);
    assert(ex.json.path.startsWith(exportDir), `chemin ${ex.json.path}`);
    const v = ffprobe(ex.json.path).streams.find((s) => s.codec_type === "video");
    assert(v.codec_name === "h264" && v.width === 640 && v.height === 360 && +v.nb_read_frames === 30, `${v.codec_name} ${v.width}x${v.height} ${v.nb_read_frames}`);
    await page.keyboard.press("Escape");
  });

  await test("MCP : create_project remplace le projet ouvert après accord", async () => {
    const p = call("create_project", { name: "Projet MCP", width: 1280, height: 720, fps: 25, duration: 5 });
    await page.waitForSelector("[data-testid=approval-dialog]");
    await page.click("[data-testid=approval-allow]");
    const r = await p;
    assert(!r.r.isError, r.text);
    const info = await A(() => ({ name: window.__amai.engine.project.name, fps: window.__amai.engine.comp().fps, n: window.__amai.engine.comp().layers.length }));
    assert(info.name === "Projet MCP" && info.fps === 25 && info.n === 0, JSON.stringify(info));
  });

  await test("Sauvegarde automatique et récupération après fermeture inattendue", async () => {
    await call("create_text", { text: "Persistant" });
    await sleep(1600); // délai d'autosauvegarde
    // Plantage réel de l'onglet (aucun événement de fermeture) → session « non propre »
    const cdp = await ctx.newCDPSession(page);
    const crashed = new Promise((r) => page.once("crash", r));
    void cdp.send("Page.crash").catch(() => {});
    await Promise.race([crashed, sleep(5000)]);
    const p2 = await ctx.newPage();
    p2.on("pageerror", (e) => consoleErrors.push(e.message));
    await p2.goto(URL0);
    await p2.waitForSelector("[data-testid=viewer-canvas]");
    await waitFor(() => p2.evaluate(() => window.__amai.ready), 5000, "boot");
    const names = await p2.evaluate(() => window.__amai.engine.comp().layers.map((l) => l.props.text));
    assert(names.includes("Persistant"), `projet restauré : ${names}`);
    assert(await p2.evaluate(() => window.__amai.engine.project.name === "Projet MCP"), "même projet");
    await p2.waitForSelector("[data-testid=recovery-banner]");
    await p2.screenshot({ path: path.join(out, "07-recuperation.png") });
  });

  await test("Interface mobile : vue, onglets et timeline utilisables sur petit écran", async () => {
    const m = await ctx.newPage();
    await m.setViewportSize({ width: 390, height: 844 });
    await m.goto(URL0);
    await m.waitForSelector("[data-testid=viewer-canvas]");
    await m.click("[data-testid=mtab-ai]");
    await m.waitForSelector("[data-testid=ai-panel]");
    await m.click("[data-testid=mtab-properties]");
    await m.click("[data-testid=mtab-timeline]");
    await m.waitForSelector("[data-testid=timeline]");
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    assert(!overflow, "pas de défilement horizontal de la page");
    await m.screenshot({ path: path.join(out, "06-mobile.png") });
    await m.close();
  });

  await test("Aucune erreur JavaScript dans la console pendant toute la session", async () => {
    const relevant = consoleErrors.filter((e) => !/favicon/.test(e));
    assert(relevant.length === 0, relevant.join(" | "));
  });
} finally {
  await browser.close();
  await mcp.close();
}

fs.writeFileSync(path.join(out, "e2e-results.txt"), results.join("\n") + `\n\n${passed} réussis, ${failures} échoués\n`);
console.log(`\n${passed} réussis, ${failures} échoués`);
process.exit(failures ? 1 : 0);
