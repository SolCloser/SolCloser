import { NextRequest, NextResponse } from "next/server"
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  AddressLookupTableProgram,
} from "@solana/web3.js"
import bs58 from "bs58"
import { attempt } from "@/lib/altRateLimit"

const RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com"

// Each create+extend tx can safely hold up to 25 addresses within 1232-byte limit
const ADDRESSES_PER_TX = 25
// Max total addresses per ALT (close-only: 90 accounts; burn+close: 35 accounts + 35 mints = 70)
const MAX_ADDRESSES = 90

function getClientIp(req: NextRequest): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ??
    req.headers.get("x-real-ip") ??
    "unknown"
  )
}

function loadServerKeypair(): Keypair {
  const key = process.env.SERVER_WALLET_PRIVATE_KEY
  if (!key) throw new Error("SERVER_WALLET_PRIVATE_KEY is not set")
  return Keypair.fromSecretKey(bs58.decode(key))
}

export async function POST(req: NextRequest) {
  try {
    // ── Rate limit check ──────────────────────────────────────────────────────
    const ip = getClientIp(req)
    if (!attempt(ip)) {
      return NextResponse.json(
        { error: "Too many requests — please wait a few minutes before trying again" },
        { status: 429 },
      )
    }

    const { tokenAccounts, mints } = (await req.json()) as {
      tokenAccounts: string[]
      mints?: string[]
    }

    if (!Array.isArray(tokenAccounts) || tokenAccounts.length === 0) {
      return NextResponse.json({ error: "tokenAccounts required" }, { status: 400 })
    }
    // Total addresses = token accounts + optional mints (for burn+close)
    const allAddressStrs = [...tokenAccounts, ...(mints ?? [])]
    if (allAddressStrs.length > MAX_ADDRESSES) {
      return NextResponse.json({ error: `Max ${MAX_ADDRESSES} addresses per ALT` }, { status: 400 })
    }

    // ── Validate all addresses are well-formed public keys ────────────────────
    let allPubkeys: PublicKey[]
    try {
      allPubkeys = allAddressStrs.map((a) => new PublicKey(a))
    } catch {
      return NextResponse.json({ error: "Invalid public key in address list" }, { status: 400 })
    }

    const connection = new Connection(RPC_URL, "confirmed")

    // ── Verify token accounts exist on-chain before spending server SOL ───────
    // Rejects requests with fake/nonexistent addresses immediately.
    const tokenPubkeys = tokenAccounts.map((a) => new PublicKey(a))
    const accountInfos = await connection.getMultipleAccountsInfo(tokenPubkeys)
    const missingCount = accountInfos.filter((info) => info === null).length
    if (missingCount > 0) {
      return NextResponse.json(
        { error: `${missingCount} token account(s) not found on-chain` },
        { status: 400 },
      )
    }

    const payer = loadServerKeypair()

    const [slot, { blockhash }] = await Promise.all([
      connection.getSlot("finalized"),
      connection.getLatestBlockhash("finalized"),
    ])

    const accountPubkeys = allPubkeys

    // Derive ALT address deterministically
    const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
      authority: payer.publicKey,
      payer: payer.publicKey,
      recentSlot: slot,
    })

    // Chunk addresses into groups that fit in one transaction
    const chunks: PublicKey[][] = []
    for (let i = 0; i < accountPubkeys.length; i += ADDRESSES_PER_TX) {
      chunks.push(accountPubkeys.slice(i, i + ADDRESSES_PER_TX))
    }

    const signedTxs: string[] = []

    // Tx 0: create + extend first chunk
    const createTx = new Transaction()
    createTx.add(createIx)
    createTx.add(
      AddressLookupTableProgram.extendLookupTable({
        payer: payer.publicKey,
        authority: payer.publicKey,
        lookupTable: altAddress,
        addresses: chunks[0],
      }),
    )
    createTx.recentBlockhash = blockhash
    createTx.feePayer = payer.publicKey
    createTx.sign(payer)
    signedTxs.push(bs58.encode(createTx.serialize()))

    // Tx 1+: extend-only for remaining chunks
    for (let i = 1; i < chunks.length; i++) {
      const extendTx = new Transaction()
      extendTx.add(
        AddressLookupTableProgram.extendLookupTable({
          payer: payer.publicKey,
          authority: payer.publicKey,
          lookupTable: altAddress,
          addresses: chunks[i],
        }),
      )
      extendTx.recentBlockhash = blockhash
      extendTx.feePayer = payer.publicKey
      extendTx.sign(payer)
      signedTxs.push(bs58.encode(extendTx.serialize()))
    }

    return NextResponse.json({
      altAddress: altAddress.toBase58(),
      signedAltTxs: signedTxs,
    })
  } catch (e: unknown) {
    console.error("[create-alt]", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Internal error" },
      { status: 500 },
    )
  }
}
