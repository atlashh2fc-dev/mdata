import type { Metadata } from 'next'
import { Outfit } from 'next/font/google'
import './globals.css'

const outfit = Outfit({ subsets: ['latin'], variable: '--font-outfit', display: 'swap' })

export const metadata: Metadata = {
  title: 'Atlas Datos',
  description: 'Plataforma de inteligencia de datos por RUT — Chile',
  icons: { icon: '/favicon.ico' },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={outfit.variable} suppressHydrationWarning>
      <head />
      <body className="font-sans antialiased">{children}</body>
    </html>
  )
}
