import { timingSafeEqual } from 'node:crypto'

export function isCronSecretValid(candidate: string | null) {
  const expected = process.env.CRON_SECRET
  if (!candidate || !expected) return false
  const left = Buffer.from(candidate)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}
