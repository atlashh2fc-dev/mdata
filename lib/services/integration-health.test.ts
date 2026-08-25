import assert from 'node:assert/strict'
import test from 'node:test'
import nextConfig from '../../next.config'
import { classifyIntegrationHealth } from './integration-health'

test('Next habilita after para ejecutar el doorbell después del ACK', () => {
  assert.equal(nextConfig.experimental?.after, true)
})

test('clasifica SLO de colas y conexiones con los mismos umbrales SQL', () => {
  assert.equal(classifyIntegrationHealth({
    outbox_oldest_seconds: 10,
    customer360_oldest_seconds: 20,
    connections: 7,
    max_connections: 60,
  }), 'healthy')
  assert.equal(classifyIntegrationHealth({ outbox_oldest_seconds: 601 }), 'degraded')
  assert.equal(classifyIntegrationHealth({ customer360_oldest_seconds: 3601 }), 'critical')
  assert.equal(classifyIntegrationHealth({ connections: 55, max_connections: 60 }), 'critical')
})

test('un destino sin max_connections informado no divide por cero', () => {
  assert.equal(classifyIntegrationHealth({ connections: 0, max_connections: 0 }), 'healthy')
})
