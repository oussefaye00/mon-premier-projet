import { describe, expect, it } from "vitest";
import http from "node:http";
import { EditorEngine, evaluate } from "@amai/core";
import { planFromText, executePlan, ClaudeAgent, type AgentEvent } from "@amai/ai";

function engineWithClips() {
  const e = new EditorEngine();
  const a = e.addAsset({ name: "a.mp4", kind: "video", mimeType: "video/mp4", size: 1, width: 1920, height: 1080, duration: 3, src: "x" });
  e.createLayer("video", { assetId: a.id, inPoint: 0 });
  e.createLayer("video", { assetId: a.id, inPoint: 3 });
  return e;
}

describe("local planner — exemples du cahier des charges", () => {
  it("« Anime ce texte avec une apparition fluide. »", async () => {
    const e = new EditorEngine();
    const t = e.createText("Bonjour");
    e.select([t.id]);
    const plan = planFromText("Anime ce texte avec une apparition fluide.", e);
    expect(plan.understood).toBe(true);
    expect(plan.steps[0]).toMatchObject({ tool: "create_animation", args: { layerId: t.id, preset: "slideInDown" } });
    const r = await executePlan(e, plan);
    expect(r.ok).toBe(true);
    expect(e.findLayer(t.id).layer.transform.opacity.keyframes!.length).toBeGreaterThan(1);
    // une seule entrée d'historique, annulable
    e.store.undoEntry(r.historyEntry!.id);
    expect(e.findLayer(t.id).layer.transform.opacity.keyframes).toBeUndefined();
  });

  it("« Crée une animation professionnelle de logo. » (sans logo : création + animation)", async () => {
    const e = new EditorEngine();
    const plan = planFromText("Crée une animation professionnelle de logo.", e);
    const r = await executePlan(e, plan);
    expect(r.ok).toBe(true);
    expect(e.comp().layers.length).toBe(2);
    expect(e.comp().layers[0].effects.map((f) => f.type)).toContain("glow");
  });

  it("« Ajoute un effet de caméra dynamique. »", async () => {
    const e = new EditorEngine();
    e.createText("A");
    const r = await executePlan(e, planFromText("Ajoute un effet de caméra dynamique.", e));
    expect(r.ok).toBe(true);
    const cam = e.comp().layers.find((l) => l.type === "camera")!;
    expect(cam.props.zoom!.keyframes!.length).toBeGreaterThan(2);
    expect(cam.effects[0].type).toBe("shake");
  });

  it("« Fais apparaître ce texte avec un effet de rebond. »", async () => {
    const e = new EditorEngine();
    const t = e.createText("Boing");
    const r = await executePlan(e, planFromText("Fais apparaître ce texte avec un effet de rebond.", e));
    expect(r.ok).toBe(true);
    expect(r.steps[0].args).toMatchObject({ preset: "bounceIn", layerId: t.id });
    expect(e.findLayer(t.id).layer.transform.positionY.keyframes![0].easing.type).toBe("bounce");
  });

  it("« Ajoute des transitions entre mes clips. »", async () => {
    const e = engineWithClips();
    const r = await executePlan(e, planFromText("Ajoute des transitions entre mes clips.", e));
    expect(r.ok).toBe(true);
    expect(e.comp().layers.some((l) => l.transitionIn?.type === "fade")).toBe(true);
  });

  it("« Crée une animation de particules. »", async () => {
    const e = new EditorEngine();
    const r = await executePlan(e, planFromText("Crée une animation de particules.", e));
    expect(r.ok).toBe(true);
    expect(e.comp().layers[0].type).toBe("particles");
  });

  it("« Optimise les animations de ce projet. »", async () => {
    const e = new EditorEngine();
    const s = e.createShape("rectangle");
    e.addKeyframe(s.id, "rotation", 0, 5);
    e.addKeyframe(s.id, "rotation", 1, 5);
    const r = await executePlan(e, planFromText("Optimise les animations de ce projet.", e));
    expect(r.ok).toBe(true);
    expect((r.steps[0].outcome.result as any).propertiesSimplified).toBe(1);
  });

  it("combine création de texte + animation + effet + durée", async () => {
    const e = new EditorEngine();
    const plan = planFromText('Écris le titre "Hello World" en jaune qui apparaît avec un rebond en 2 secondes et ajoute une lueur', e);
    expect(plan.steps.map((s) => s.tool)).toEqual(["create_text", "create_animation", "apply_effect"]);
    const r = await executePlan(e, plan);
    expect(r.ok).toBe(true);
    const l = e.comp().layers[0];
    expect(l.props.text).toBe("Hello World");
    expect(l.props.textColor!.value).toBe("#ffd60a");
    expect(evaluate(l.transform.positionY, 2)).toBeCloseTo(540, 3);
  });

  it("échec d'une étape → tout le plan est annulé", async () => {
    const e = new EditorEngine();
    const r = await executePlan(e, {
      summary: "",
      notes: [],
      understood: true,
      steps: [
        { tool: "create_text", args: { text: "X" }, description: "" },
        { tool: "create_animation", args: { layerId: "$step:0", preset: "cameraDynamic" }, description: "" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(e.comp().layers).toHaveLength(0);
  });

  it("demande incomprise", () => {
    const e = new EditorEngine();
    expect(planFromText("quelle heure est-il ?", e).understood).toBe(false);
  });
});

describe("Claude agent (serveur API simulé)", () => {
  it("exécute la boucle d'outils et regroupe les modifications", async () => {
    const requests: any[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const json = JSON.parse(body);
        requests.push({ json, headers: req.headers });
        const n = requests.length;
        const content =
          n === 1
            ? [
                { type: "text", text: "Je crée le texte." },
                { type: "tool_use", id: "tu_1", name: "create_text", input: { text: "Salut", animation: "popIn" } },
              ]
            : [{ type: "text", text: "C'est fait." }];
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: `msg_${n}`,
            type: "message",
            role: "assistant",
            model: json.model,
            content,
            stop_reason: n === 1 ? "tool_use" : "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 10 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;
    const e = new EditorEngine();
    const agent = new ClaudeAgent(e, { apiKey: "test-key", baseURL: `http://127.0.0.1:${port}`, browser: false });
    const events: AgentEvent[] = [];
    await agent.send("Écris Salut", (ev) => events.push(ev));
    server.close();

    expect(requests[0].json.model).toBe("claude-opus-5-5");
    expect(requests[0].json.fallbacks).toBe("default");
    expect(requests[0].json.tools.length).toBeGreaterThan(30);
    expect(String(requests[0].headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(requests[1].json.messages[2].content[0].type).toBe("tool_result");
    expect(e.comp().layers[0].props.text).toBe("Salut");
    const done = events.find((x) => x.type === "done") as any;
    expect(done.historyEntry.source).toBe("ai");
    expect(e.store.history().undo).toHaveLength(1);
    e.undo();
    expect(e.comp().layers).toHaveLength(0);
  });
});
