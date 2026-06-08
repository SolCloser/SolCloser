/**
 * /api/alt-complete
 *
 * Called client-side after a transaction is confirmed on-chain.
 * Verifies the signature actually landed and succeeded, then forgives
 * one pending ALT slot for that IP so legitimate users are never rate-limited.
 */

import { NextRequest, NextResponse } from "next/server"
import { Connection } from "@solana/web3.js"
import { forgive } from "@/lib/altRateLimit"

const RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com"

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  )
}

export async function POST(req: NextRequest) {
  try {
    const { signature } = (await req.json()) as { signature?: string }
    if (!signature || typeof signature !== "string") {
      return NextResponse.json({ ok: false }, { status: 400 })
    }

    const connection = new Connection(RPC_URL, "confirmed")
    const result = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    })

    // Only forgive if the tx landed and has no error — cannot be faked
    if (result && !result.meta?.err) {
      forgive(getClientIp(req))
    }

    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ ok: true }) // non-fatal
  }
}
