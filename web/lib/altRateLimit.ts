/**
 * altRateLimit.ts
 *
 * Tracks "pending" ALT creations per IP — creations that haven't yet been
 * forgiven by a confirmed on-chain transaction. Legitimate users who complete
 * their transactions accumulate zero net cost against the limit.
 *
 * Caveat: Vercel serverless may run multiple Lambda instances so forgiveness
 * may occasionally not reach the same instance that incremented the counter.
 * This is a good-faith deterrent. Swap the Map for Vercel KV for strict guarantees.
 */

interface RateEntry {
  pending: number
  resetAt: number
}

const store = new Map<string, RateEntry>()

const MAX_PENDING = 5
const WINDOW_MS = 5 * 60 * 1000 // 5 minutes

/** Called when a new ALT creation is requested. Returns false if rate limited. */
export function attempt(ip: string): boolean {
  const now = Date.now()
  const entry = store.get(ip)
  if (!entry || now > entry.resetAt) {
    store.set(ip, { pending: 1, resetAt: now + WINDOW_MS })
    return true
  }
  if (entry.pending >= MAX_PENDING) return false
  entry.pending++
  return true
}

/** Called after a transaction is confirmed on-chain. Removes one pending count. */
export function forgive(ip: string): void {
  const entry = store.get(ip)
  if (!entry || Date.now() > entry.resetAt) return
  entry.pending = Math.max(0, entry.pending - 1)
}
