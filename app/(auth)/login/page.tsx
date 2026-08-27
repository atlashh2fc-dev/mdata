'use client'

import { useState } from 'react'
import { AtlasAuthShell } from '@/vendor/atlas-ui/auth-shell'
import { useRouter } from 'next/navigation'
import { hasSupabasePublicEnv } from '@/lib/db/client'
import { Eye, EyeOff, AlertCircle } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()

    if (!hasSupabasePublicEnv) {
      setError('Falta configurar Supabase en Vercel. Define NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY.')
      return
    }

    setLoading(true)
    setError(null)

    const authResponse = await fetch('/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email.trim(),
        password,
      }),
    })

    if (!authResponse.ok) {
      const payload = await authResponse.json().catch(() => null)
      const authStatus = Number(payload?.status ?? authResponse.status)
      const authMessage = String(payload?.error ?? 'No se pudo iniciar sesión.')

      console.error('[login] Auth error:', authMessage, authStatus)
      setError(
        authStatus === 400
          ? 'Credenciales inválidas. Verifica tu email y contraseña.'
          : `Error de autenticación: ${authMessage}`
      )
      setLoading(false)
      return
    }

    setLoading(false)
    router.refresh()
    router.push('/dashboard')
  }

  return (
    <AtlasAuthShell product="Datos" tagline="La información que conecta tu operación."
      highlights={["Búsqueda y perfil 360 por RUT.", "Bases, segmentos y cobertura de datos.", "Acceso por usuario autorizado."]}
      description="Ingresa para consultar y gestionar tus bases de datos.">
          {error && (
            <div className="flex items-center gap-2.5 p-3 rounded-lg bg-danger-bg border border-danger/20 mb-5">
              <AlertCircle className="w-4 h-4 text-danger flex-shrink-0" />
              <p role="alert" className="text-sm text-danger">{error}</p>
            </div>
          )}

          {!hasSupabasePublicEnv && (
            <div className="flex items-center gap-2.5 p-3 rounded-lg bg-warning-bg border border-warning/20 mb-5">
              <AlertCircle className="w-4 h-4 text-warning flex-shrink-0" />
              <p className="text-sm text-warning">
                La app esta desplegada, pero faltan variables publicas de Supabase en Vercel.
              </p>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1.5">
                Email
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="usuario@empresa.cl"
                required
                className="input-base"
                autoComplete="email"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-foreground mb-1.5">
                Contraseña
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  className="input-base pr-10"
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  aria-label={showPassword ? "Ocultar contraseña" : "Mostrar contraseña"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !email || !password || !hasSupabasePublicEnv}
              className="btn-primary w-full justify-center py-2.5 mt-2"
            >
              {loading ? (
                <>
                  <div className="w-4 h-4 border-2 border-border border-t-border rounded-full animate-spin" />
                  Autenticando...
                </>
              ) : (
                'Iniciar sesión'
              )}
            </button>
          </form>

    </AtlasAuthShell>
  )
}
