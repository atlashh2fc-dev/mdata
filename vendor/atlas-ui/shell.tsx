"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

/** Product-specific links, authorization and session actions remain in the host app. */
export function AtlasShell({ product, subtitle, navigation, actions, footer, children }: {
  product: string; subtitle: string; navigation: ReactNode; actions?: ReactNode;
  footer?: ReactNode; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const navId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  return <div className="atlas-frame" data-menu-open={open} onKeyDown={event => {
    if (event.key === "Escape" && open) { setOpen(false); toggle.current?.focus(); }
  }}>
    <aside className="atlas-sidebar" aria-label="Navegación principal">
      <div className="atlas-brand">
        {/* Shared static brand asset; no framework-specific image dependency. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/atlas-logo.png" alt="" width={34} height={34} />
        <div><strong>Atlas {product}</strong><small>{subtitle}</small></div>
        <button ref={toggle} type="button" className="atlas-icon-button atlas-mobile-toggle" aria-label={open ? "Cerrar menú" : "Abrir menú"} aria-expanded={open} aria-controls={navId} onClick={() => setOpen(!open)}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d={open ? "m5 5 10 10M15 5 5 15" : "M3 5h14M3 10h14M3 15h14"} /></svg>
        </button>
      </div>
      <div id={navId} className="atlas-navigation" onClick={event => {
        if (event.target instanceof Element && event.target.closest("a")) setOpen(false);
      }}>{navigation}</div>
      {footer && <div className="atlas-sidebar-footer">{footer}</div>}
    </aside>
    <div className="atlas-workspace">
      <header className="atlas-topbar"><span className="atlas-topbar-title">{subtitle}</span><div className="atlas-topbar-actions"><ThemeToggle />{actions}</div></header>
      <main className="atlas-main" id="main-content">{children}</main>
    </div>
  </div>;
}
