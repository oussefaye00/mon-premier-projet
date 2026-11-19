import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { app } from "./EditorApp";

/** Re-rendu à chaque changement d'état de l'application ou du projet. */
export function useApp() {
  useSyncExternalStore(app.subscribe, () => app.version);
  return app;
}

/** Projet courant (référence immuable : change à chaque modification). */
export function useProject() {
  return useSyncExternalStore(
    (fn) => app.engine.store.subscribe(fn),
    () => app.engine.project,
  );
}

/** État de session (sélection, temps). `throttleMs` limite les rendus pendant la lecture. */
export function useSession(throttleMs = 0) {
  const [, force] = useState(0);
  const last = useRef(0);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const off = app.engine.onSession(() => {
      if (!throttleMs) return force((x) => x + 1);
      const now = performance.now();
      if (now - last.current >= throttleMs) {
        last.current = now;
        force((x) => x + 1);
      } else if (!pending.current) {
        pending.current = setTimeout(() => {
          pending.current = null;
          last.current = performance.now();
          force((x) => x + 1);
        }, throttleMs);
      }
    });
    return () => {
      off();
      if (pending.current) clearTimeout(pending.current);
    };
  }, [throttleMs]);
  return app.engine.session;
}

export function fmtTime(t: number, fps: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  const f = Math.floor((t - Math.floor(t)) * fps + 1e-6);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} Ko`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} Mo`;
  return `${(n / 1024 ** 3).toFixed(2)} Go`;
}
