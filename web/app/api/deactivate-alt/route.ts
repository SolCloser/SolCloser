import { NextRequest, NextResponse } from "next/server"
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
  AddressLookupTableProgram,
} from "@solana/web3.js"
import bs58 from "bs58"

const RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com"

function loadServerKeypair(): Keypair {
  const key = process.env.SERVER_WALLET_PRIVATE_KEY
  if (!key) throw new Error("SERVER_WALLET_PRIVATE_KEY is not set")
  return Keypair.fromSecretKey(bs58.decode(key))
}

export async function POST(req: NextRequest) {
  try {
    const { altAddress } = (await req.json()) as { altAddress: string }
    if (!altAddress) return NextResponse.json({ error: "altAddress required" }, { status: 400 })

    const payer = loadServerKeypair()
    const connection = new Connection(RPC_URL, "confirmed")
    const alt = new PublicKey(altAddress)

    const deactivateIx = AddressLookupTableProgram.deactivateLookupTable({
      lookupTable: alt,
      authority: payer.publicKey,
    })

    const tx = new Transaction().add(deactivateIx)
    const sig = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" })

    return NextResponse.json({ signature: sig })
  } catch (e: unknown) {
    // Non-fatal — log and move on. The cron job will retry.
    console.error("[deactivate-alt]", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Internal error" },
      { status: 500 },
    )
  }
}
