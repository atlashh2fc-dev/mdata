'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { hasSupabasePublicEnv, supabaseBrowser } from '@/lib/db/client'
import { Zap, Eye, EyeOff, AlertCircle } from 'lucide-react'

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

    const { error: authError } = await supabaseBrowser.auth.signInWithPassword({
      email: email.trim(),
      password,
    })

    if (authError) {
      // Log the real error for debugging
      console.error('[login] Auth error:', authError.message, authError.status)
      setError(
        authError.status === 400
          ? 'Credenciales inválidas. Verifica tu email y contraseña.'
          : `Error de autenticación: ${authError.message}`
      )
      setLoading(false)
      return
    }

    // refresh() first so the middleware sees the session cookie, then navigate
    router.refresh()
    router.push('/dashboard')
  }

  return (
    <div className="min-h-screen bg-[#0a1024] flex items-center justify-center p-4">
      {/* Background gradient */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-80 h-80 bg-brand-600/20 rounded-full blur-3xl" />
        <div className="absolute -bottom-40 -left-40 w-80 h-80 bg-blue-600/10 rounded-full blur-3xl" />
      </div>

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-brand-600 flex items-center justify-center glow-brand mb-4">
            <Zap className="w-7 h-7 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">RUT Intelligence</h1>
          <p className="text-sm text-slate-500 mt-1">Plataforma de datos — Chile</p>
        </div>

        {/* Form */}
        <div className="card p-8 shadow-elevation-4">
          <h2 className="text-lg font-semibold text-white mb-6">Iniciar sesión</h2>

          {error && (
            <div className="flex items-center gap-2.5 p-3 rounded-lg bg-red-500/10 border border-red-500/20 mb-5">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {!hasSupabasePublicEnv && (
            <div className="flex items-center gap-2.5 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-5">
              <AlertCircle className="w-4 h-4 text-amber-400 flex-shrink-0" />
              <p className="text-sm text-amber-300">
                La app esta desplegada, pero faltan variables publicas de Supabase en Vercel.
              </p>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Email
              </label>
              <input
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
              <label className="block text-xs font-medium text-slate-400 mb-1.5">
                Contraseña
              </label>
              <div className="relative">
                <input
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
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-white transition-colors"
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
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                  Autenticando...
                </>
              ) : (
                'Iniciar sesión'
              )}
            </button>
          </form>

          <p className="text-center text-xs text-slate-600 mt-6">
            Acceso restringido — plataforma interna
          </p>
        </div>
      </div>
    </div>
  )
}
