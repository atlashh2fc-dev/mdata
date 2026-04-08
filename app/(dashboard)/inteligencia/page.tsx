import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function InteligenciaLegacyRedirectPage() {
  redirect('/inteligencia-comercial')
}
