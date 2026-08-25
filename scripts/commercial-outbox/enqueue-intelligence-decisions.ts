import { enqueueCommercialDecisions } from '@/lib/services/commercial-outbox'

enqueueCommercialDecisions()
  .then(result => console.log(JSON.stringify({ ok: true, ...result }, null, 2)))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
