import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

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
if (local['x-contract-version'] !== '2.0.0') {
  throw new Error('El contrato local no declara la versión 2.0.0.')
}

if (process.env.CONTRACT_VERIFY_LOCAL_ONLY !== '1') {
  const url = process.env.INTEGRATION_CONTRACT_URL
    ?? 'https://atlascrm.geimser.cl/api/integrations/v2/contract'
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!response.ok) throw new Error(`No se pudo leer el contrato canónico (${response.status}).`)
  const remote = await response.json()
  if (remote.contract_version !== local['x-contract-version'] || remote.sha256 !== localSha) {
    throw new Error(`Drift de contrato v2: local ${localSha}, canónico ${remote.sha256 ?? 'sin digest'}.`)
  }
}

console.log(`Contrato de integración ${local['x-contract-version']} verificado: ${localSha}`)
