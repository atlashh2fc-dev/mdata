import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'RUT Intelligence Platform',
  description: 'Plataforma de inteligencia de datos por RUT — Chile',
  icons: { icon: '/favicon.ico' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <head />
      <body className="bg-[#0a1024] text-slate-100 antialiased">{children}</body>
    </html>
  )
}
