import { NextRequest, NextResponse } from "next/server"
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  AddressLookupTableProgram,
} from "@solana/web3.js"
import bs58 from "bs58"

const RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com"

// Each create+extend tx can safely hold up to 25 addresses within 1232-byte limit
const ADDRESSES_PER_TX = 25
// Max accounts per bundle: 90 fits in one versioned close tx with compute budget overhead
// For >90, altClose.ts splits into sequential bundles (multiple user approvals)
const MAX_ACCOUNTS = 90

function loadServerKeypair(): Keypair {
  const key = process.env.SERVER_WALLET_PRIVATE_KEY
  if (!key) throw new Error("SERVER_WALLET_PRIVATE_KEY is not set")
  return Keypair.fromSecretKey(bs58.decode(key))
}

export async function POST(req: NextRequest) {
  try {
    const { tokenAccounts } = (await req.json()) as { tokenAccounts: string[] }

    if (!Array.isArray(tokenAccounts) || tokenAccounts.length === 0) {
      return NextResponse.json({ error: "tokenAccounts required" }, { status: 400 })
    }
    if (tokenAccounts.length > MAX_ACCOUNTS) {
      return NextResponse.json({ error: `Max ${MAX_ACCOUNTS} accounts per bundle` }, { status: 400 })
    }

    const payer = loadServerKeypair()
    const connection = new Connection(RPC_URL, "confirmed")

    const [slot, { blockhash }] = await Promise.all([
      connection.getSlot("finalized"),
      connection.getLatestBlockhash("finalized"),
    ])

    const accountPubkeys = tokenAccounts.map((a) => new PublicKey(a))

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
