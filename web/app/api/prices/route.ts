import { NextRequest, NextResponse } from "next/server"
import { PublicKey } from "@solana/web3.js"

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)) }

// ── SOL price ─────────────────────────────────────────────────────────────────
async function fetchSolPrice(): Promise<number> {
  try {
    const r = await fetch(
      "https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112",
      { next: { revalidate: 30 } },
    )
    if (!r.ok) return 0
    const data = await r.json()
    const pairs: Array<{ priceUsd?: string; liquidity?: { usd?: number } }> = data?.pairs ?? []
    pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
    return parseFloat(pairs[0]?.priceUsd ?? "0")
  } catch (e) {
    console.error("[prices] Failed to fetch SOL price:", e)
    return 0
  }
}

// ── Pump.fun bonding curve ────────────────────────────────────────────────────
// Layout (after 8-byte discriminator):
//   virtualTokenReserves : u64 @ 8
//   virtualSolReserves   : u64 @ 16
//   complete             : bool@ 48  (true = graduated)

const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
const PUMP_SEED    = Buffer.from("bonding-curve")

function bondingCurvePDA(mint: string): string | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [PUMP_SEED, new PublicKey(mint).toBuffer()],
      PUMP_PROGRAM,
    )
    return pda.toBase58()
  } catch { return null }
}

async function fetchPumpFunPrices(
  mints: string[],
  solPrice: number,
): Promise<Record<string, number>> {
  if (solPrice === 0 || mints.length === 0) return {}

  const rpcUrl =
    process.env.HELIUS_RPC_URL ??
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ??
    "https://api.mainnet-beta.solana.com"

  // Build PDA → mint mapping
  const pdaToMint: Record<string, string> = {}
  for (const mint of mints) {
    const pda = bondingCurvePDA(mint)
    if (pda) pdaToMint[pda] = mint
  }
  const pdas = Object.keys(pdaToMint)
  if (pdas.length === 0) return {}

  const out: Record<string, number> = {}

  // Batch getMultipleAccounts — 100 per call
  const chunks: string[][] = []
  for (let i = 0; i < pdas.length; i += 100) chunks.push(pdas.slice(i, i + 100))

  await Promise.allSettled(
    chunks.map(async (c) => {
      try {
        const res = await fetch(rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getMultipleAccounts",
            params: [c, { encoding: "base64" }],
          }),
        })

        if (!res.ok) {
          console.error(`[bonding-curve] RPC HTTP ${res.status}`)
          return
        }

        const json = await res.json()

        if (json.error) {
          console.error("[bonding-curve] RPC error:", json.error.message)
          return
        }

        const accounts: Array<{ data: [string, string] } | null> = json?.result?.value ?? []

        for (let i = 0; i < accounts.length; i++) {
          const account = accounts[i]
          if (!account) continue // not a pump.fun token

          const raw = Buffer.from(account.data[0], "base64")
          if (raw.length < 49) continue // not a bonding curve account

          if (raw[48] === 1) continue // complete = graduated, skip

          const virtualTokenReserves = raw.readBigUInt64LE(8)
          const virtualSolReserves   = raw.readBigUInt64LE(16)

          if (virtualTokenReserves === 0n) continue

          // price(SOL) = (lamports / 1e9) / (raw_tokens / 1e6) = lamports / (raw_tokens * 1000)
          const priceUsd = (Number(virtualSolReserves) / (Number(virtualTokenReserves) * 1_000)) * solPrice
          if (priceUsd > 0) out[pdaToMint[c[i]]] = priceUsd
        }
      } catch (e) {
        console.error("[bonding-curve] Fetch failed:", e)
      }
    }),
  )

  return out
}

// ── GeckoTerminal ─────────────────────────────────────────────────────────────
async function fetchGeckoTerminal(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const chunks: string[][] = []
  for (let i = 0; i < mints.length; i += 15) chunks.push(mints.slice(i, i + 15))

  for (const c of chunks) {
    try {
      const r = await fetch(
        `https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${c.join(",")}`,
        { headers: { Accept: "application/json" }, next: { revalidate: 60 } },
      )
      if (r.status === 429) { await sleep(1500); continue }
      if (!r.ok) continue
      const data = await r.json()
      const prices: Record<string, string> = data?.data?.attributes?.token_prices ?? {}
      for (const [addr, priceStr] of Object.entries(prices)) {
        const p = parseFloat(priceStr)
        if (!isNaN(p) && p > 0) out[addr] = p
      }
      await sleep(200)
    } catch (e) {
      console.error("[gecko] Fetch failed:", e)
    }
  }
  return out
}

// ── DexScreener ───────────────────────────────────────────────────────────────
async function fetchDexScreener(mints: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const chunks: string[][] = []
  for (let i = 0; i < mints.length; i += 30) chunks.push(mints.slice(i, i + 30))

  await Promise.allSettled(
    chunks.map(async (c) => {
      try {
        const r = await fetch(
          `https://api.dexscreener.com/latest/dex/tokens/${c.join(",")}`,
          { next: { revalidate: 60 } },
        )
        if (!r.ok) return
        const data = await r.json()
        const pairs: Array<{
          baseToken?: { address?: string }
          priceUsd?: string
          liquidity?: { usd?: number }
        }> = data?.pairs ?? []
        pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
        for (const pair of pairs) {
          const addr = pair.baseToken?.address
          const p = parseFloat(pair.priceUsd ?? "0")
          if (addr && p > 0 && !out[addr]) out[addr] = p
        }
      } catch (e) {
        console.error("[dexscreener] Fetch failed:", e)
      }
    }),
  )
  return out
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const { mints: rawMints } = await req.json().catch(() => ({ mints: [] }))
  const mints: string[] = Array.isArray(rawMints)
    ? rawMints.map((s: string) => s.trim()).filter(Boolean)
    : []
  if (mints.length === 0) return NextResponse.json({})

  const solPrice   = await fetchSolPrice()
  const pumpPrices = await fetchPumpFunPrices(mints, solPrice)

  const afterPump  = mints.filter((m) => pumpPrices[m] === undefined)
  const geckoPrices = afterPump.length > 0 ? await fetchGeckoTerminal(afterPump) : {}

  const afterGecko = afterPump.filter((m) => geckoPrices[m] === undefined)
  const dexPrices  = afterGecko.length > 0 ? await fetchDexScreener(afterGecko) : {}

  const result = { ...dexPrices, ...geckoPrices, ...pumpPrices }

  const found = Object.keys(result).length
  console.log(
    `[prices] ${mints.length} tokens → ${found} priced` +
    ` | pump ${Object.keys(pumpPrices).length}` +
    ` gecko ${Object.keys(geckoPrices).length}` +
    ` dex ${Object.keys(dexPrices).length}` +
    ` | SOL $${solPrice.toFixed(2)}`,
  )

  return NextResponse.json(result)
}
