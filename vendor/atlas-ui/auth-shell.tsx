import type { ReactNode } from "react";
import { ThemeToggle } from "./theme-toggle";

export function AtlasAuthShell({ product, tagline, highlights, description, children }: {
  product: string; tagline: string; highlights: string[]; description: string; children: ReactNode;
}) {
  return <main className="atlas-auth">
    <aside className="atlas-auth-brand">
      <div><div className="atlas-brand">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/atlas-logo.png" alt="" width={40} height={40} /><strong>Atlas {product}</strong>
      </div><p className="atlas-auth-tagline">{tagline}</p><ul>{highlights.map(text => <li key={text}>{text}</li>)}</ul></div>
      <footer>Atlas {product} · Acceso por usuario autorizado</footer>
    </aside>
    <div className="atlas-auth-content"><ThemeToggle /><section className="atlas-auth-form">
      <h1>Iniciar sesión</h1><p className="atlas-auth-description">{description}</p>{children}
      <p className="atlas-auth-note">Acceso restringido · Plataforma interna</p>
    </section></div>
  </main>;
}
