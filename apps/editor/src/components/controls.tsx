import { useEffect, useRef, useState, type ReactNode } from "react";
import { canonicalPath, evaluate, getPropertyAtPath, isAnimated, normalizeColor, type AnimatableProperty, type Layer } from "@amai/core";
import { app } from "../app/EditorApp";
import { Icon } from "./Icon";

/**
 * Regroupe toutes les modifications d'un geste (glisser, scrub…) en UNE entrée
 * d'historique. Renvoie la fonction de fin de geste.
 */
export function beginGesture(label: string): () => void {
  let end!: () => void;
  const done = new Promise<void>((r) => (end = r));
  void app.engine.store.batch(label, "user", () => done);
  return end;
}

export function safely(fn: () => void) {
  try {
    fn();
  } catch (e) {
    app.toast((e as Error).message, "error");
  }
}

interface NumberFieldProps {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  label?: string;
  width?: number;
  precision?: number;
  testId?: string;
}

/** Champ numérique avec « scrub » : glisser l'étiquette horizontalement modifie la valeur. */
export function NumberField({ value, onChange, step = 1, min, max, unit, label, width = 64, precision = 2, testId }: NumberFieldProps) {
  const [text, setText] = useState<string | null>(null);
  const clamp = (v: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
  const display = Number.isFinite(value) ? +value.toFixed(precision) : 0;
  const onScrubStart = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = value;
    let moved = false;
    let end: (() => void) | null = null;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!moved && Math.abs(dx) < 3) return;
      if (!moved) end = beginGesture(`Modifier ${label ?? "valeur"}`);
      moved = true;
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      safely(() => onChange(clamp(+(start + dx * step * mult).toFixed(4))));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      end?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const commit = () => {
    if (text === null) return;
    const v = parseFloat(text.replace(",", "."));
    setText(null);
    if (Number.isFinite(v) && v !== value) safely(() => onChange(clamp(v)));
  };
  return (
    <span className="numfield">
      {label && (
        <span className="numfield-label" onPointerDown={onScrubStart} title="Glisser pour modifier (Maj ×10, Alt ×0.1)">
          {label}
        </span>
      )}
      <input
        data-testid={testId}
        style={{ width }}
        value={text ?? String(display)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setText(null);
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const d = (e.key === "ArrowUp" ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            safely(() => onChange(clamp(+(value + d).toFixed(4))));
          }
          e.stopPropagation();
        }}
        inputMode="decimal"
      />
      {unit && <span className="numfield-unit">{unit}</span>}
    </span>
  );
}

export function ColorField({ value, onChange, testId }: { value: string; onChange: (v: string) => void; testId?: string }) {
  const hex = (() => {
    try {
      return normalizeColor(value).slice(0, 7);
    } catch {
      return "#000000";
    }
  })();
  const alpha = value.length === 9 ? value.slice(7) : "";
  return (
    <span className="colorfield">
      <input data-testid={testId} type="color" value={hex} onChange={(e) => safely(() => onChange(e.target.value + alpha))} />
      <input className="colorhex" value={value} onChange={(e) => /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(e.target.value) && safely(() => onChange(e.target.value))} onKeyDown={(e) => e.stopPropagation()} />
    </span>
  );
}

export function Section({ title, children, defaultOpen = true, actions }: { title: string; children: ReactNode; defaultOpen?: boolean; actions?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`section ${open ? "open" : ""}`}>
      <div className="section-head" onClick={() => setOpen(!open)}>
        <span className="chev">
          <Icon name="chevron" size={14} />
        </span>
        <span className="section-title">{title}</span>
        <span className="section-actions" onClick={(e) => e.stopPropagation()}>
          {actions}
        </span>
      </div>
      {open && <div className="section-body">{children}</div>}
    </div>
  );
}

interface AnimRowProps {
  layer: Layer;
  path: string;
  label: string;
  time: number;
  kind?: "number" | "color";
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  precision?: number;
}

/**
 * Ligne de propriété animable : chronomètre (activer l'animation), valeur au temps
 * courant, navigation et ajout de keyframes.
 */
export function AnimRow({ layer, path, label, time, kind = "number", step = 1, min, max, unit, precision }: AnimRowProps) {
  const full = canonicalPath(layer, path);
  const p = getPropertyAtPath(layer, full) as AnimatableProperty | undefined;
  if (!p) return null;
  const animated = isAnimated(p);
  const v = evaluate(p, time);
  const kfs = p.keyframes ?? [];
  const onKf = kfs.find((k) => Math.abs(k.time - time) < 1e-3);
  const prev = [...kfs].reverse().find((k) => k.time < time - 1e-3);
  const next = kfs.find((k) => k.time > time + 1e-3);
  const set = (nv: number | string) => app.engine.setProperty(layer.id, full, nv, time);
  return (
    <div className={`prop-row ${animated ? "animated" : ""}`} data-prop={full}>
      <button className={`stopwatch ${animated ? "on" : ""}`} title={animated ? "Supprimer l'animation" : "Animer cette propriété (keyframe au temps courant)"} onClick={() => safely(() => app.engine.toggleAnimation(layer.id, full, time))}>
        <Icon name="stopwatch" size={13} />
      </button>
      <span className="prop-label">{label}</span>
      <span className="prop-value">
        {kind === "color" ? (
          <ColorField value={String(v)} onChange={set} />
        ) : (
          <NumberField value={Number(v)} onChange={set} step={step} min={min} max={max} unit={unit} precision={precision} label="↔" width={62} testId={`prop-${full}`} />
        )}
      </span>
      {animated && (
        <span className="kf-nav">
          <button disabled={!prev} onClick={() => prev && app.seek(prev.time)} title="Keyframe précédente">
            ◀
          </button>
          <button
            className={`kf-add ${onKf ? "on" : ""}`}
            title={onKf ? "Supprimer la keyframe" : "Ajouter une keyframe"}
            onClick={() => safely(() => (onKf ? app.engine.removeKeyframe(layer.id, full, onKf.id) : app.engine.addKeyframe(layer.id, full, time, undefined)))}
          >
            <Icon name="diamond" size={11} />
          </button>
          <button disabled={!next} onClick={() => next && app.seek(next.time)} title="Keyframe suivante">
            ▶
          </button>
        </span>
      )}
    </div>
  );
}

export function Modal({ title, onClose, children, wide, testId }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? "wide" : ""}`} ref={ref} role="dialog" aria-label={title} data-testid={testId}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
