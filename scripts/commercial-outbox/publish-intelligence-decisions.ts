import { drainCommercialOutbox } from '@/lib/services/commercial-outbox'

drainCommercialOutbox()
  .then(result => console.log(JSON.stringify({ ok: true, ...result }, null, 2)))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
