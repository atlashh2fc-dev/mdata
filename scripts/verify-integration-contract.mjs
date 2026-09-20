import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

/**
 * Comprueba que nuestra copia del contrato v2 sea la misma que publica Atlas.
 *
 * El guardián pedía antes la versión exacta 2.0.0, escrita a mano aquí. Cuando
 * Atlas publicó la 2.1.0, esto falló todos los días durante semanas: primero por
 * el hash, y si alguien copiaba el archivo nuevo, otra vez por el literal — con
 * un mensaje que culpaba al contrato cuando el desactualizado era el script.
 * Un candado con la fecha escrita encima no es un verificador.
 *
 * Ahora sólo exigimos seguir dentro de la major 2; la deriva real la detecta la
 * comparación contra el canónico, que es la que sabe la verdad.
 */

const CONTRACT_MAJOR = '2'

const localPath = new URL('../contracts/integration-event-v2.schema.json', import.meta.url)
const local = JSON.parse(await readFile(localPath, 'utf8'))

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    ).join(',')}}`
  }
  return JSON.stringify(value)
}

const localSha = createHash('sha256').update(stableJson(local)).digest('hex')
const localVersion = local['x-contract-version']

if (typeof localVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(localVersion)) {
  throw new Error(`El contrato local no declara un x-contract-version semver válido (leído: ${localVersion ?? 'nada'}).`)
}

if (localVersion.split('.')[0] !== CONTRACT_MAJOR) {
  throw new Error(
    `El contrato local es ${localVersion} y este verificador es de la major ${CONTRACT_MAJOR}. ` +
    'Un cambio de major sí rompe compatibilidad: hay que revisar el puente antes de actualizar.',
  )
}

if (process.env.CONTRACT_VERIFY_LOCAL_ONLY !== '1') {
  const url = process.env.INTEGRATION_CONTRACT_URL
    ?? 'https://atlascrm.geimser.cl/api/integrations/v2/contract'
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`No se pudo leer el contrato canónico (${response.status}).`)
  const remote = await response.json()
  if (remote.contract_version !== localVersion || remote.sha256 !== localSha) {
    throw new Error(
      `Drift de contrato v2.\n` +
      `  local:    ${localVersion} ${localSha}\n` +
      `  canónico: ${remote.contract_version ?? 'sin versión'} ${remote.sha256 ?? 'sin digest'}\n` +
      `  Para resolver: copiar contracts/integration-event-v2.schema.json desde Atlas 2.0 y revisar que ` +
      `lib/services/atlas-lead-bridge.ts entienda los event_type nuevos.`,
    )
  }
}

console.log(`Contrato de integración ${localVersion} verificado: ${localSha}`)
