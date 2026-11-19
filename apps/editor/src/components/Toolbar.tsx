import { app, type Tool } from "../app/EditorApp";
import { useApp } from "../app/hooks";
import { safely } from "./controls";
import { Icon } from "./Icon";

const TOOLS: { t: Tool; icon: string; label: string; key: string }[] = [
  { t: "select", icon: "select", label: "Sélection", key: "V" },
  { t: "hand", icon: "hand", label: "Main (déplacer la vue)", key: "H" },
  { t: "text", icon: "text", label: "Texte", key: "T" },
  { t: "rectangle", icon: "rect", label: "Rectangle", key: "R" },
  { t: "ellipse", icon: "ellipse", label: "Ellipse", key: "E" },
  { t: "star", icon: "star", label: "Étoile", key: "" },
];

function addLayer(kind: "solid" | "particles" | "camera" | "null") {
  safely(() => {
    const t = app.engine.session.currentTime;
    const l = app.engine.createLayer(kind, { inPoint: kind === "camera" ? 0 : t, name: kind === "particles" ? "Particules" : undefined });
    if (kind === "camera") app.toast("Calque caméra ajouté : animez sa position, sa rotation et son zoom pour filmer toute la scène.");
    app.engine.select([l.id]);
  });
}

export function Toolbar() {
  const a = useApp();
  return (
    <div className="toolbar" data-testid="toolbar">
      {TOOLS.map((x) => (
        <button key={x.t} className={`tool ${a.tool === x.t ? "on" : ""}`} onClick={() => app.set("tool", x.t)} title={`${x.label}${x.key ? ` (${x.key})` : ""}`} data-testid={`tool-${x.t}`}>
          <Icon name={x.icon} size={18} />
        </button>
      ))}
      <span className="tool-sep" />
      <button className="tool" onClick={() => addLayer("solid")} title="Ajouter un solide">
        <Icon name="solid" size={18} />
      </button>
      <button className="tool" onClick={() => addLayer("particles")} title="Ajouter des particules" data-testid="add-particles">
        <Icon name="particles" size={18} />
      </button>
      <button className="tool" onClick={() => addLayer("camera")} title="Ajouter une caméra">
        <Icon name="camera" size={18} />
      </button>
      <button className="tool" onClick={() => addLayer("null")} title="Ajouter un objet nul (parentage)">
        <Icon name="null" size={18} />
      </button>
    </div>
  );
}
