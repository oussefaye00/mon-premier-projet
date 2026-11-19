import type { Project } from "@amai/core";

/**
 * Stockage local (IndexedDB) :
 *  - projects  : dernière version enregistrée de chaque projet
 *  - snapshots : sauvegardes automatiques (anneau de N versions par projet) pour la récupération
 *  - media     : fichiers importés (Blob), référencés par les assets "idb:<id>"
 *  - kv        : réglages et marqueurs de session
 */
const DB_NAME = "after-motion-ai";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("projects")) db.createObjectStore("projects", { keyPath: "id" });
      if (!db.objectStoreNames.contains("snapshots")) {
        const s = db.createObjectStore("snapshots", { keyPath: "key" });
        s.createIndex("projectId", "projectId");
      }
      if (!db.objectStoreNames.contains("media")) db.createObjectStore("media");
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const r = fn(s);
        t.oncomplete = () => resolve(r ? (r.result as T) : (undefined as T));
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export interface StoredProject {
  id: string;
  name: string;
  updatedAt: string;
  project: Project;
}

export interface Snapshot {
  key: string;
  projectId: string;
  savedAt: number;
  project: Project;
}

export const db = {
  saveProject: (p: Project) => tx("projects", "readwrite", (s) => s.put({ id: p.id, name: p.name, updatedAt: new Date().toISOString(), project: p } satisfies StoredProject)),
  getProject: (id: string) => tx<StoredProject | undefined>("projects", "readonly", (s) => s.get(id)),
  listProjects: () => tx<StoredProject[]>("projects", "readonly", (s) => s.getAll()),
  deleteProject: async (id: string) => {
    await tx("projects", "readwrite", (s) => s.delete(id));
    const snaps = await db.listSnapshots(id);
    await Promise.all(snaps.map((x) => tx("snapshots", "readwrite", (s) => s.delete(x.key))));
  },

  async addSnapshot(p: Project, keep = 10) {
    const snap: Snapshot = { key: `${p.id}:${Date.now()}`, projectId: p.id, savedAt: Date.now(), project: p };
    await tx("snapshots", "readwrite", (s) => s.put(snap));
    const all = await db.listSnapshots(p.id);
    const old = all.sort((a, b) => b.savedAt - a.savedAt).slice(keep);
    await Promise.all(old.map((x) => tx("snapshots", "readwrite", (s) => s.delete(x.key))));
  },
  listSnapshots: (projectId: string) =>
    open().then(
      (d) =>
        new Promise<Snapshot[]>((resolve, reject) => {
          const r = d.transaction("snapshots").objectStore("snapshots").index("projectId").getAll(projectId);
          r.onsuccess = () => resolve(r.result as Snapshot[]);
          r.onerror = () => reject(r.error);
        }),
    ),

  putMedia: (id: string, blob: Blob) => tx("media", "readwrite", (s) => s.put(blob, id)),
  getMedia: (id: string) => tx<Blob | undefined>("media", "readonly", (s) => s.get(id)),
  deleteMedia: (id: string) => tx("media", "readwrite", (s) => s.delete(id)),

  setKV: (k: string, v: unknown) => tx("kv", "readwrite", (s) => s.put(v, k)),
  getKV: <T>(k: string) => tx<T | undefined>("kv", "readonly", (s) => s.get(k)),
};

/** Estimation de l'espace disque disponible (affiché dans les paramètres). */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  try {
    const e = await navigator.storage?.estimate?.();
    return e ? { usage: e.usage ?? 0, quota: e.quota ?? 0 } : null;
  } catch {
    return null;
  }
}
