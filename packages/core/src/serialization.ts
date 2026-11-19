import { PROJECT_VERSION } from "./factory";
import type { Project } from "./types";

export class ProjectFormatError extends Error {}

/** Format de fichier projet AFTER MOTION AI (.amai.json). */
export interface ProjectFile {
  format: "after-motion-ai";
  version: number;
  project: Project;
  /** Médias embarqués (base64) indexés par assetId — optionnel. */
  media?: Record<string, { mimeType: string; data: string }>;
}

export function serializeProject(project: Project, media?: ProjectFile["media"]): string {
  const file: ProjectFile = { format: "after-motion-ai", version: PROJECT_VERSION, project, media };
  return JSON.stringify(file);
}

/** Vérifie la structure d'un projet chargé (fichier, sauvegarde, récupération). */
export function validateProject(p: unknown): Project {
  const fail = (m: string): never => {
    throw new ProjectFormatError(`Projet invalide : ${m}`);
  };
  if (!p || typeof p !== "object") fail("objet attendu");
  const proj = p as Project;
  if (typeof proj.id !== "string") fail("id manquant");
  if (!Array.isArray(proj.compositions) || proj.compositions.length === 0) fail("aucune composition");
  if (!Array.isArray(proj.assets)) fail("liste de médias manquante");
  for (const c of proj.compositions) {
    if (typeof c.id !== "string" || !(c.width > 0) || !(c.height > 0) || !(c.fps > 0) || !(c.duration > 0)) fail(`composition ${c?.id} incomplète`);
    if (!Array.isArray(c.layers)) fail(`composition ${c.id} sans calques`);
    for (const l of c.layers) {
      if (typeof l.id !== "string" || typeof l.type !== "string" || !l.transform || !l.props) fail(`calque ${l?.id} incomplet`);
      if (!Array.isArray(l.effects)) l.effects = [];
      if (!Array.isArray(l.masks)) l.masks = [];
    }
  }
  if (!proj.compositions.some((c) => c.id === proj.activeCompositionId)) proj.activeCompositionId = proj.compositions[0].id;
  return migrateProject(proj);
}

/** Point d'entrée des migrations de format (versions futures). */
export function migrateProject(p: Project): Project {
  if (!p.version) p.version = 1;
  if (p.version > PROJECT_VERSION) throw new ProjectFormatError(`Ce projet a été créé avec une version plus récente (v${p.version}).`);
  return p;
}

export function parseProjectFile(text: string): ProjectFile {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProjectFormatError("Fichier JSON illisible.");
  }
  if (json?.format === "after-motion-ai") return { ...json, project: validateProject(json.project) };
  // Tolère un projet brut.
  return { format: "after-motion-ai", version: PROJECT_VERSION, project: validateProject(json) };
}
