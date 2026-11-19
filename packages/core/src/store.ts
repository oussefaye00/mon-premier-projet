import { applyPatches, enablePatches, produceWithPatches, setAutoFreeze, type Draft, type Patch } from "immer";
import type { ChangeSource, Project } from "./types";

enablePatches();
// Les projets sont manipulés par plusieurs couches (UI, IA, MCP) : on garde des objets gelés
// pour détecter toute mutation accidentelle hors transaction.
setAutoFreeze(true);

export interface HistoryEntry {
  id: number;
  label: string;
  source: ChangeSource;
  timestamp: number;
  patches: Patch[];
  inversePatches: Patch[];
}

export interface StoreEvent {
  kind: "change" | "undo" | "redo" | "load";
  entry?: HistoryEntry;
}

type Listener = (e: StoreEvent) => void;

/**
 * Store du projet avec historique illimité (borné par maxHistory) basé sur des patches.
 * Chaque appel à `transact` produit UNE entrée d'historique, quel que soit le nombre de
 * modifications : une action IA ou MCP complexe s'annule donc en un seul « undo ».
 */
export class ProjectStore {
  private state: Project;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;
  private group: { label: string; source: ChangeSource; patches: Patch[]; inverse: Patch[] } | null = null;
  /** Compteur incrémenté à chaque changement — utile pour la sauvegarde automatique. */
  revision = 0;

  constructor(initial: Project, private maxHistory = 300) {
    this.state = initial;
  }

  get project(): Project {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: StoreEvent) {
    this.revision++;
    for (const l of this.listeners) l(e);
  }

  /** Remplace entièrement le projet (ouverture / nouveau projet). Vide l'historique. */
  load(project: Project) {
    this.state = project;
    this.undoStack = [];
    this.redoStack = [];
    this.emit({ kind: "load" });
  }

  /**
   * Applique une modification. `recipe` reçoit un brouillon mutable du projet.
   * Si la recette lève une exception, rien n'est modifié.
   */
  transact<R = void>(label: string, recipe: (draft: Draft<Project>) => R, source: ChangeSource = "user"): R {
    let result: R = undefined as R;
    const [next, patches, inverse] = produceWithPatches(this.state, (d) => {
      result = recipe(d);
    });
    if (patches.length === 0) return result;
    this.state = next;
    // Seules les modifications de la même source rejoignent le groupe en cours : une
    // retouche manuelle faite pendant que l'IA travaille reste une entrée séparée.
    if (this.group && this.group.source === source) {
      this.group.patches.push(...patches);
      this.group.inverse.unshift(...inverse);
      this.revision++;
      for (const l of this.listeners) l({ kind: "change" });
      return result;
    }
    const entry: HistoryEntry = {
      id: this.nextId++,
      label,
      source,
      timestamp: Date.now(),
      patches,
      inversePatches: inverse,
    };
    this.pushHistory(entry);
    this.emit({ kind: "change", entry });
    return result;
  }

  /**
   * Regroupe plusieurs transactions en une seule entrée d'historique
   * (ex. : toutes les actions d'une réponse de l'assistant IA).
   */
  async batch<R>(label: string, source: ChangeSource, fn: () => Promise<R> | R): Promise<{ result: R; entry: HistoryEntry | null }> {
    if (this.group) {
      // Groupes imbriqués : on fusionne dans le groupe parent.
      return { result: await fn(), entry: null };
    }
    this.group = { label, source, patches: [], inverse: [] };
    let result: R;
    try {
      result = await fn();
    } catch (err) {
      // En cas d'erreur, on annule ce qui a déjà été appliqué dans le groupe.
      const g = this.group;
      this.group = null;
      if (g.patches.length) {
        this.state = applyPatches(this.state, g.inverse);
        this.emit({ kind: "undo" });
      }
      throw err;
    }
    const g = this.group;
    this.group = null;
    if (g.patches.length === 0) return { result, entry: null };
    const entry: HistoryEntry = {
      id: this.nextId++,
      label: g.label,
      source: g.source,
      timestamp: Date.now(),
      patches: g.patches,
      inversePatches: g.inverse,
    };
    this.pushHistory(entry);
    this.emit({ kind: "change", entry });
    return { result, entry };
  }

  private pushHistory(entry: HistoryEntry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo() {
    return this.undoStack.length > 0;
  }
  canRedo() {
    return this.redoStack.length > 0;
  }

  undo(): HistoryEntry | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    this.state = applyPatches(this.state, e.inversePatches);
    this.redoStack.push(e);
    this.emit({ kind: "undo", entry: e });
    return e;
  }

  redo(): HistoryEntry | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    this.state = applyPatches(this.state, e.patches);
    this.undoStack.push(e);
    this.emit({ kind: "redo", entry: e });
    return e;
  }

  /** Annule une entrée précise si elle est au sommet de la pile (ex. bouton « Annuler » d'une action IA). */
  undoEntry(id: number): boolean {
    const top = this.undoStack[this.undoStack.length - 1];
    if (!top || top.id !== id) return false;
    this.undo();
    return true;
  }

  /** Annule toutes les entrées jusqu'à (et y compris) celle indiquée. */
  undoUntil(id: number): number {
    if (!this.undoStack.some((e) => e.id === id)) return 0;
    let n = 0;
    while (this.undoStack.length) {
      const e = this.undo();
      n++;
      if (!e || e.id === id) break;
    }
    return n;
  }

  history(): { undo: readonly HistoryEntry[]; redo: readonly HistoryEntry[] } {
    return { undo: this.undoStack, redo: this.redoStack };
  }
}
