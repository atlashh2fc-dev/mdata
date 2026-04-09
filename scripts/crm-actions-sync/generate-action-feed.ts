import { getCommercialActionFeed } from '@/lib/services/commercial-brain'

async function main() {
  const feed = await getCommercialActionFeed()
  process.stdout.write(JSON.stringify(feed))
}

main().catch(error => {
  console.error(error)
  process.exit(1)
})
