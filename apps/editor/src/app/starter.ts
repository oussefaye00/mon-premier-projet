import { EditorEngine, type Project } from "@amai/core";

/** Projet de démonstration affiché au premier lancement (entièrement modifiable). */
export function createStarterProject(): Project {
  const e = new EditorEngine();
  e.newProject({ projectName: "Mon premier projet", width: 1920, height: 1080, fps: 30, duration: 6, background: "#0d0d14" });
  e.renameProject("Mon premier projet");
  const bg = e.createShape("ellipse", { name: "Halo", width: 1100, height: 1100, fill: "#5b3cff", y: 540 });
  e.updateLayer(bg.id, { transform: { opacity: 35 } });
  e.addEffect(bg.id, "gaussianBlur", { radius: 120 });
  e.applyPreset(bg.id, "pulse", 0, 6, 0.6);
  const ring = e.createShape("ellipse", { name: "Anneau", width: 620, height: 620, props: { fillEnabled: false, strokeEnabled: true, strokeWidth: 10, stroke: "#9b87ff" } });
  e.addKeyframe(ring.id, "props.trimEnd", 0, 0, "expoInOut");
  e.addKeyframe(ring.id, "props.trimEnd", 1.4, 100, "expoInOut");
  e.addKeyframe(ring.id, "rotation", 0, -90, "expoOut");
  e.addKeyframe(ring.id, "rotation", 2, 90, "expoOut");
  const title = e.createText("AFTER MOTION AI", { fontSize: 140, y: 500 });
  e.applyPreset(title.id, "textReveal-slide-up", 0.6, 1.2);
  e.addEffect(title.id, "glow", { radius: 30, intensity: 0.6, color: "#9b87ff" });
  const sub = e.createText("Montage vidéo · Motion design · IA", { fontSize: 52, y: 665, color: "#b8b8c8", fontWeight: 500 });
  e.applyPreset(sub.id, "slideInDown", 1.4, 0.8);
  const p = e.createLayer("particles", { name: "Étincelles", y: 1120, props: { emitterShape: "line", emitterSize: 1920, direction: -90, spread: 25, speed: 220, gravity: -40, rate: 25, lifetime: 5, particleSize: 7, particleSizeEnd: 1, colorStart: "#c4b5ff", colorEnd: "#5b3cff00", seed: 42 } });
  e.reorderLayer(p.id, 1);
  return e.project;
}
