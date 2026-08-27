"use client";

import { useEffect, useState } from "react";

type Mode = "light" | "dark";
const KEY = "atlas-ui-theme";

export function ThemeToggle() {
  const [mode, setMode] = useState<Mode>("light");
  useEffect(() => {
    let initial: Mode = "light";
    try {
      const saved = localStorage.getItem(KEY) ?? localStorage.getItem("atlas-lead-mode");
      if (saved === "dark") initial = "dark";
    } catch { /* Storage may be disabled; the control still works for this visit. */ }
    document.documentElement.dataset.mode = initial;
    const frame = requestAnimationFrame(() => setMode(initial));
    const sync = (event: StorageEvent) => {
      if (event.key === KEY) {
        const next = event.newValue === "dark" ? "dark" : "light";
        document.documentElement.dataset.mode = next;
        setMode(next);
      }
    };
    window.addEventListener("storage", sync);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("storage", sync); };
  }, []);
  function toggle() {
    const next = mode === "dark" ? "light" : "dark";
    document.documentElement.dataset.mode = next;
    try { localStorage.setItem(KEY, next); } catch { /* Optional persistence. */ }
    setMode(next);
  }
  const label = mode === "dark" ? "Usar tema claro" : "Usar tema oscuro";
  return <button type="button" className="atlas-icon-button" onClick={toggle} aria-label={label} title={label}>
    <svg aria-hidden="true" viewBox="0 0 20 20">
      {mode === "dark" ? <><circle cx="10" cy="10" r="3.2" /><path d="M10 1.5v2M10 16.5v2M1.5 10h2M16.5 10h2M4 4l1.4 1.4M14.6 14.6 16 16M16 4l-1.4 1.4M5.4 14.6 4 16" /></> : <path d="M16.8 12.6A7 7 0 0 1 7.4 3.2 7 7 0 1 0 16.8 12.6Z" />}
    </svg>
  </button>;
}
