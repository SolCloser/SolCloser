import { PublicKey } from "@solana/web3.js"

// Jito block engine — mainnet
const JITO_BUNDLE_URL = "https://mainnet.block-engine.jito.labs.io/api/v1/bundles"

// Rotate randomly so tip pressure is spread across Jito accounts
const TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvB6pzJVfAGb15Nz6c3rnhtyQnrUFMJz3E",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1UM6nYZoAgK4",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]

// 5 000 lamports (~$0.001) — enough to get included without overpaying
export const JITO_TIP_LAMPORTS = 5_000

export function randomJitoTipAccount(): PublicKey {
  return new PublicKey(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)])
}

/**
 * Submit a Jito bundle via the Next.js proxy route (avoids browser CORS).
 * `encodedTxs` are base58-encoded signed transactions, in order.
 * Returns the bundle ID on success, throws on failure.
 */
export async function submitJitoBundle(encodedTxs: string[]): Promise<string> {
  const res = await fetch("/api/send-bundle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transactions: encodedTxs }),
  })
  const data = await res.json()
  if (!res.ok || data.error) throw new Error(data.error ?? "Bundle submission failed")
  return data.bundleId
}

export { JITO_BUNDLE_URL }
