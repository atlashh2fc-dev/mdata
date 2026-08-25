export function normalizeCheckpoint(timestamp, id = '') {
  const parsed = timestamp ? new Date(timestamp) : null
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new Error(`Cursor temporal inválido: ${timestamp ?? 'null'}`)
  }

  return {
    timestamp: parsed.toISOString(),
    id: String(id ?? ''),
  }
}

export function compareCheckpoints(left, right) {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp.localeCompare(right.timestamp)
  }
  return left.id.localeCompare(right.id)
}

export function maxCheckpoint(left, right) {
  return compareCheckpoints(right, left) > 0 ? right : left
}

export function buildScanStart(checkpoint, lookbackMinutes) {
  const lookbackMs = Math.max(0, Number(lookbackMinutes) || 0) * 60 * 1000
  return {
    timestamp: new Date(new Date(checkpoint.timestamp).getTime() - lookbackMs).toISOString(),
    id: '',
  }
}

export function checkpointFromRow(row, timestampColumn, idColumn) {
  const timestamp = row?.[timestampColumn]
  const id = row?.[idColumn]
  if (!timestamp || id === null || id === undefined || id === '') return null
  return normalizeCheckpoint(timestamp, id)
}

export function quotePostgrestValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function buildPostgrestKeysetFilter(timestampColumn, idColumn, checkpoint) {
  const timestamp = quotePostgrestValue(checkpoint.timestamp)
  const id = quotePostgrestValue(checkpoint.id)
  return `${timestampColumn}.gt.${timestamp},and(${timestampColumn}.eq.${timestamp},${idColumn}.gt.${id})`
}
