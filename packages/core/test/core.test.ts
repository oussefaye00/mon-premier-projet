import { describe, expect, it } from "vitest";
import {
  EditorEngine,
  cubicBezier,
  evaluate,
  executeTool,
  TOOLS,
  toolJsonSchema,
  parseProjectFile,
  serializeProject,
  applyEasing,
} from "@amai/core";

describe("easing & interpolation", () => {
  it("cubic-bezier matches known values", () => {
    expect(cubicBezier(0, 0, 1, 1, 0.5)).toBeCloseTo(0.5, 5);
    // ease-in-out is symmetric
    expect(cubicBezier(0.42, 0, 0.58, 1, 0.5)).toBeCloseTo(0.5, 4);
    expect(cubicBezier(0.42, 0, 1, 1, 0.25)).toBeLessThan(0.25);
    expect(applyEasing({ type: "bounce" }, 1)).toBeCloseTo(1);
    expect(applyEasing({ type: "hold" }, 0.99)).toBe(0);
  });

  it("evaluates keyframes with easing, before/after range and colors", () => {
    const p = {
      value: 0,
      keyframes: [
        { id: "a", time: 1, value: 0, easing: { type: "linear" as const } },
        { id: "b", time: 3, value: 100, easing: { type: "linear" as const } },
      ],
    };
    expect(evaluate(p, 0)).toBe(0);
    expect(evaluate(p, 2)).toBe(50);
    expect(evaluate(p, 10)).toBe(100);
    const c = {
      value: "#000000",
      keyframes: [
        { id: "a", time: 0, value: "#000000", easing: { type: "linear" as const } },
        { id: "b", time: 1, value: "#ffffff", easing: { type: "linear" as const } },
      ],
    };
    expect(evaluate(c, 0.5)).toBe("#808080");
  });
});

describe("engine: layers, keyframes, undo/redo", () => {
  it("creates, updates, animates and undoes", () => {
    const e = new EditorEngine();
    const t = e.createText("Bonjour");
    expect(e.comp().layers).toHaveLength(1);
    e.updateLayer(t.id, { transform: { rotation: 45 }, props: { textColor: "red" } });
    expect(e.findLayer(t.id).layer.transform.rotation.value).toBe(45);
    expect(e.findLayer(t.id).layer.props.textColor!.value).toBe("#ff3b30");
    e.addKeyframe(t.id, "opacity", 0, 0, "linear");
    e.addKeyframe(t.id, "opacity", 2, 100, "linear");
    expect(e.getValue(t.id, "opacity", 1)).toBe(50);
    // setting an animated property writes a keyframe at the given time
    e.setProperty(t.id, "opacity", 30, 1);
    expect(e.getValue(t.id, "opacity", 1)).toBe(30);
    expect(e.findLayer(t.id).layer.transform.opacity.keyframes).toHaveLength(3);
    e.undo();
    expect(e.getValue(t.id, "opacity", 1)).toBe(50);
    e.redo();
    expect(e.getValue(t.id, "opacity", 1)).toBe(30);
    // undo everything
    while (e.store.canUndo()) e.undo();
    expect(e.comp().layers).toHaveLength(0);
  });

  it("rejects invalid input without modifying state", () => {
    const e = new EditorEngine();
    const s = e.createShape("ellipse");
    const rev = e.store.revision;
    expect(() => e.updateLayer(s.id, { transform: { nope: 1 } as any })).toThrow(/inconnue/);
    expect(() => e.updateLayer(s.id, { props: { fill: "pas une couleur" } })).toThrow(/couleur/);
    expect(() => e.updateLayer(s.id, { inPoint: 5, outPoint: 2 })).toThrow();
    expect(e.store.revision).toBe(rev);
  });

  it("splits and merges media clips with correct media offsets", () => {
    const e = new EditorEngine();
    const a = e.addAsset({ name: "clip.mp4", kind: "video", mimeType: "video/mp4", size: 1, width: 1920, height: 1080, duration: 8, src: "x" });
    const v = e.createLayer("video", { assetId: a.id });
    expect(v.outPoint).toBe(8);
    const right = e.splitLayer(v.id, 3);
    expect(e.findLayer(v.id).layer.outPoint).toBe(3);
    expect(right.inPoint).toBe(3);
    expect(right.props.mediaOffset).toBe(3);
    const merged = e.mergeLayers(v.id, right.id);
    expect(merged.outPoint).toBe(8);
    expect(e.comp().layers).toHaveLength(1);
    expect(() => e.splitLayer(v.id, 0)).toThrow();
  });

  it("presets create keyframes and apply effects", () => {
    const e = new EditorEngine();
    const t = e.createText("Logo");
    e.applyPreset(t.id, "logoReveal", 0, 2);
    const l = e.findLayer(t.id).layer;
    expect(l.transform.scaleX.keyframes!.length).toBeGreaterThan(1);
    expect(l.effects.map((f) => f.type).sort()).toEqual(["gaussianBlur", "glow"]);
    // one undo removes the whole preset
    e.undo();
    expect(e.findLayer(t.id).layer.effects).toHaveLength(0);
    e.applyPreset(t.id, "bounceIn", 0.5, 1);
    const y = e.findLayer(t.id).layer.transform.positionY;
    expect(evaluate(y, 1.5)).toBeCloseTo(540, 3);
    expect(evaluate(y, 0.5)).toBeLessThan(540);
  });

  it("batch groups several changes into one undo entry", async () => {
    const e = new EditorEngine();
    await e.store.batch("IA", "ai", () => {
      e.createText("A", {}, "ai");
      e.createShape("star", {}, "ai");
    });
    expect(e.comp().layers).toHaveLength(2);
    expect(e.store.history().undo).toHaveLength(1);
    e.undo();
    expect(e.comp().layers).toHaveLength(0);
  });

  it("transitions between clips and precompose", () => {
    const e = new EditorEngine();
    const a = e.addAsset({ name: "a.png", kind: "image", mimeType: "image/png", size: 1, width: 100, height: 100, src: "x" });
    const l1 = e.createLayer("image", { assetId: a.id, inPoint: 0, outPoint: 3 });
    const l2 = e.createLayer("image", { assetId: a.id, inPoint: 3, outPoint: 6 });
    const r = e.addTransitionsBetweenClips({ type: "fade", duration: 0.5, overlap: true });
    expect(r.pairs).toHaveLength(1);
    expect(e.findLayer(l2.id).layer.inPoint).toBe(2.5);
    expect(e.findLayer(l2.id).layer.transitionIn).toEqual({ type: "fade", duration: 0.5 });
    const pc = e.precompose([l1.id, l2.id], "Groupe");
    expect(e.comp().layers).toHaveLength(1);
    expect(e.comp(pc.composition.id).layers).toHaveLength(2);
  });

  it("optimize removes redundant keyframes", () => {
    const e = new EditorEngine();
    const s = e.createShape("rectangle");
    for (const t of [0, 1, 2, 3]) e.addKeyframe(s.id, "rotation", t, 10);
    e.addEffect(s.id, "gaussianBlur", { radius: 0 });
    const r = e.optimizeAnimations();
    expect(r.propertiesSimplified).toBe(1);
    expect(r.neutralEffectsRemoved).toBe(1);
    expect(e.findLayer(s.id).layer.transform.rotation.keyframes).toBeUndefined();
  });

  it("serializes and parses project files", () => {
    const e = new EditorEngine();
    e.createText("Hello");
    const txt = serializeProject(e.project);
    const back = parseProjectFile(txt);
    expect(back.project.compositions[0].layers[0].props.text).toBe("Hello");
    expect(() => parseProjectFile("{}")).toThrow();
  });
});

describe("tools catalog", () => {
  it("every tool has a valid JSON schema", () => {
    const names = new Set<string>();
    for (const t of TOOLS) {
      const s = toolJsonSchema(t as any);
      expect(s.type).toBe("object");
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
    }
    for (const n of ["get_project_info", "create_project", "get_timeline", "create_layer", "delete_layer", "update_layer", "add_keyframe", "create_animation", "apply_effect", "create_text", "import_media", "export_video", "get_preview", "undo_action", "redo_action"]) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("executes tools with validation and structured errors", async () => {
    const engine = new EditorEngine();
    const ctx = { engine, source: "mcp" as const };
    const r = await executeTool(ctx, "create_text", { text: "Salut", animation: "popIn" });
    expect(r.ok).toBe(true);
    const id = (r.result as any).id;
    const bad = await executeTool(ctx, "add_keyframe", { layerId: id, property: "opacity" });
    expect(bad.ok).toBe(false);
    expect(bad.error!.code).toBe("invalid_arguments");
    const nf = await executeTool(ctx, "update_layer", { layerId: "nope" });
    expect(nf.error!.code).toBe("not_found");
    const prev = await executeTool(ctx, "get_preview", {});
    expect(prev.error!.code).toBe("unsupported");
    const h = await executeTool(ctx, "get_history", {});
    expect((h.result as any).undo[0].source).toBe("mcp");
    const u = await executeTool(ctx, "undo_action", { steps: 2 });
    expect((u.result as any).undone).toHaveLength(2);
    expect(engine.comp().layers).toHaveLength(0);
  });
});
