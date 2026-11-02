"use client";

import { useEffect, useId, useState } from "react";
import { TIME_MARKERS, formatTime, type TimeMarker } from "@/lib/editTimeCell";

const HOURS = Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0"));
const MINUTES = Array.from({ length: 60 }, (_, minute) => String(minute).padStart(2, "0"));

type TimeModalProps = {
  hour: string;
  minute: string;
  marker: TimeMarker;
  onCancel: () => void;
  onConfirm: (text: string) => Promise<void>;
};

export function TimeModal({ hour, minute, marker, onCancel, onConfirm }: TimeModalProps) {
  const titleId = useId();
  const [nextHour, setNextHour] = useState(hour);
  const [nextMinute, setNextMinute] = useState(minute);
  const [nextMarker, setNextMarker] = useState<TimeMarker>(marker);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = formatTime(nextHour, nextMinute, nextMarker);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, saving]);

  async function confirm() {
    setSaving(true);
    setError(null);
    try {
      await onConfirm(preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não consegui atualizar esse horário.");
      setSaving(false);
    }
  }

  return (
    <div className="time-modal-backdrop" onMouseDown={saving ? undefined : onCancel}>
      <div
        className="time-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId} className="time-modal-title">
          Editar horário
        </h2>
        <p className="time-modal-preview">
          Fica assim: <strong>{preview}</strong>
        </p>

        <div className="time-modal-clock">
          <label>
            Hora
            <select value={nextHour} onChange={(event) => setNextHour(event.target.value)} disabled={saving}>
              {HOURS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <span className="time-modal-colon" aria-hidden>
            :
          </span>
          <label>
            Minuto
            <select
              value={nextMinute}
              onChange={(event) => setNextMinute(event.target.value)}
              disabled={saving}
            >
              {MINUTES.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="time-modal-markers" disabled={saving}>
          <legend>Expoente</legend>
          <div className="time-modal-marker-list">
            {TIME_MARKERS.map((item) => (
              <button
                key={item.label}
                type="button"
                className={item.value === nextMarker ? "is-selected" : ""}
                aria-pressed={item.value === nextMarker}
                onClick={() => setNextMarker(item.value)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </fieldset>

        {error && (
          <p className="home-error" role="alert">
            {error}
          </p>
        )}

        <div className="time-modal-actions">
          <button type="button" className="neon-btn neon-btn-ghost" onClick={onCancel} disabled={saving}>
            Cancelar
          </button>
          <button type="button" className="neon-btn neon-btn-primary" onClick={confirm} disabled={saving}>
            {saving ? "Salvando..." : "Confirmar"}
          </button>
        </div>
      </div>
    </div>
  );
}
