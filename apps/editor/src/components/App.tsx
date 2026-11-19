import { useEffect, useState } from "react";
import { app, type MobileTab } from "../app/EditorApp";
import { useApp } from "../app/hooks";
import { AIPanel } from "./AIPanel";
import { safely } from "./controls";
import { ApprovalDialog, ExportDialog, NewProjectDialog, ProjectsDialog, RecoveryBanner, SettingsDialog, Toasts } from "./Dialogs";
import { GraphEditor } from "./GraphEditor";
import { HistoryPanel } from "./HistoryPanel";
import { Icon } from "./Icon";
import { EffectsLibrary, LibraryPanel, MediaLibrary, PresetsLibrary } from "./Library";
import { MCPPanel } from "./MCPPanel";
import { PropertiesPanel } from "./PropertiesPanel";
import { Timeline } from "./Timeline";
import { Toolbar } from "./Toolbar";
import { TopBar } from "./TopBar";
import { Viewer } from "./Viewer";

function useIsMobile() {
  const q = "(max-width: 900px)";
  const [m, setM] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const mq = window.matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return m;
}

function SidePanel() {
  const a = useApp();
  const tabs = [
    ["properties", "Propriétés"],
    ["ai", "IA"],
    ["history", "Historique"],
    ["mcp", "MCP"],
  ] as const;
  return (
    <div className="panel side">
      <div className="tabs">
        {tabs.map(([k, l]) => (
          <button key={k} className={a.sideTab === k ? "on" : ""} onClick={() => app.set("sideTab", k)} data-testid={`side-${k}`}>
            {k === "ai" && <Icon name="sparkle" size={13} />} {l}
            {k === "mcp" && <span className={`dot ${a.bridgeStatus}`} />}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {a.sideTab === "properties" && <PropertiesPanel />}
        {a.sideTab === "ai" && <AIPanel />}
        {a.sideTab === "history" && <HistoryPanel />}
        {a.sideTab === "mcp" && <MCPPanel />}
      </div>
    </div>
  );
}

/** Raccourcis clavier globaux. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const eng = app.engine;
      const sel = eng.session.selectedLayerIds;
      const k = e.key.toLowerCase();
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) eng.redo();
        else eng.undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        eng.redo();
      } else if (mod && k === "d") {
        e.preventDefault();
        safely(() => eng.select(sel.map((id) => eng.duplicateLayer(id).id)));
      } else if (mod && k === "s") {
        e.preventDefault();
        void app.flushSave().then(() => app.toast("Projet enregistré.", "success"));
      } else if (mod && k === "a") {
        e.preventDefault();
        eng.select(eng.comp().layers.map((l) => l.id));
      } else if (e.key === " ") {
        e.preventDefault();
        app.togglePlay();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) app.seek(eng.session.currentTime - 1);
        else app.stepFrame(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) app.seek(eng.session.currentTime + 1);
        else app.stepFrame(1);
      } else if (e.key === "Home") app.seek(0);
      else if (e.key === "End") app.seek(eng.comp().duration);
      else if ((e.key === "Delete" || e.key === "Backspace") && sel.length) {
        e.preventDefault();
        safely(() => eng.deleteLayers(sel));
      } else if (e.key === "Escape") eng.select([]);
      else if (!mod && k === "s" && sel.length) safely(() => sel.forEach((id) => eng.splitLayer(id, eng.session.currentTime)));
      else if (!mod && k === "k" && sel.length) {
        void eng.store.batch("Keyframes de transformation", "user", () => {
          for (const id of sel) for (const p of ["positionX", "positionY", "scaleX", "scaleY", "rotation", "opacity"]) safely(() => eng.addKeyframe(id, p, eng.session.currentTime, undefined));
        });
      } else if (!mod && k === "v") app.set("tool", "select");
      else if (!mod && k === "h") app.set("tool", "hand");
      else if (!mod && k === "t") app.set("tool", "text");
      else if (!mod && k === "r") app.set("tool", "rectangle");
      else if (!mod && k === "e") app.set("tool", "ellipse");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

const MOBILE_TABS: [MobileTab, string, string][] = [
  ["timeline", "Timeline", "film"],
  ["properties", "Propriétés", "settings"],
  ["media", "Médias", "image"],
  ["effects", "Effets", "wand"],
  ["ai", "IA", "sparkle"],
];

export function App() {
  const a = useApp();
  const mobile = useIsMobile();
  useShortcuts();
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    const drop = (e: DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer?.files.length && !(e.target as HTMLElement).closest(".viewer")) void app.importFiles(e.dataTransfer.files);
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", drop);
    };
  }, []);

  if (!a.ready) {
    return (
      <div className="splash">
        <img src="/icon.svg" width={72} height={72} alt="" />
        <div>AFTER MOTION AI</div>
      </div>
    );
  }

  return (
    <div className={`app ${mobile ? "mobile" : "desktop"}`}>
      <TopBar />
      <RecoveryBanner />
      {mobile ? (
        <>
          <div className="m-viewer">
            <Toolbar />
            <Viewer />
          </div>
          <div className="m-panel">
            {a.mobileTab === "timeline" && <Timeline />}
            {a.mobileTab === "properties" && <PropertiesPanel />}
            {a.mobileTab === "media" && <MediaLibrary />}
            {a.mobileTab === "effects" && (
              <div className="m-effects">
                <EffectsLibrary />
                <PresetsLibrary />
              </div>
            )}
            {a.mobileTab === "ai" && <AIPanel />}
          </div>
          <nav className="m-tabs">
            {MOBILE_TABS.map(([k, l, i]) => (
              <button key={k} className={a.mobileTab === k ? "on" : ""} onClick={() => app.set("mobileTab", k)} data-testid={`mtab-${k}`}>
                <Icon name={i} size={18} />
                <span>{l}</span>
              </button>
            ))}
          </nav>
        </>
      ) : (
        <>
          <div className="workspace">
            <Toolbar />
            <LibraryPanel />
            <main className="center">
              <Viewer />
              {a.graphEditor.open && <GraphEditor />}
            </main>
            <SidePanel />
          </div>
          <Timeline />
        </>
      )}
      {mobile && a.graphEditor.open && (
        <div className="m-graph">
          <GraphEditor />
        </div>
      )}
      {a.dialogs.export && <ExportDialog />}
      {a.dialogs.settings && <SettingsDialog />}
      {a.dialogs.newProject && <NewProjectDialog />}
      {a.dialogs.projects && <ProjectsDialog />}
      <ApprovalDialog />
      <Toasts />
    </div>
  );
}
