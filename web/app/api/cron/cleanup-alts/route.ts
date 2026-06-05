import { NextRequest, NextResponse } from "next/server"
import {
  AddressLookupTableProgram,
  Connection,
  Keypair,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js"
import bs58 from "bs58"

const RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com"

// Solana requires 512 slots after deactivation before an ALT can be closed
const DEACTIVATION_COOLDOWN_SLOTS = 512n

function loadServerKeypair(): Keypair {
  const key = process.env.SERVER_WALLET_PRIVATE_KEY
  if (!key) throw new Error("SERVER_WALLET_PRIVATE_KEY is not set")
  return Keypair.fromSecretKey(bs58.decode(key))
}

export async function GET(req: NextRequest) {
  // Vercel automatically sets the Authorization header with CRON_SECRET
  const authHeader = req.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const payer = loadServerKeypair()
  const connection = new Connection(RPC_URL, "confirmed")

  // Find all lookup table accounts where authority == server wallet.
  // ALT account layout: 4 (type) + 8 (deactivation_slot) + 8 (last_extended_slot)
  //                   + 1 (last_extended_slot_start_index) + 1 (option tag) + 32 (authority)
  // Authority starts at byte 22 if the option tag (byte 21) == 1.
  const accounts = await connection.getProgramAccounts(
    AddressLookupTableProgram.programId,
    {
      filters: [
        { memcmp: { offset: 21, bytes: bs58.encode(Buffer.from([1])) } }, // authority is Some
        { memcmp: { offset: 22, bytes: payer.publicKey.toBase58() } },    // authority == server
      ],
    },
  )

  if (accounts.length === 0) {
    return NextResponse.json({ message: "No ALTs found", closed: 0 })
  }

  const currentSlot = BigInt(await connection.getSlot("finalized"))
  let closed = 0
  const errors: string[] = []

  for (const { pubkey, account } of accounts) {
    try {
      // Bytes 4–11: deactivation_slot (u64 LE). u64::MAX means still active.
      const deactivationSlot = account.data.readBigUInt64LE(4)
      const isActive = deactivationSlot === BigInt("18446744073709551615")

      if (isActive) {
        // Shouldn't happen (we deactivate immediately after use), but clean up
        // any stale active ALTs that are more than 1 hour old (estimated by
        // last_extended_slot being far behind currentSlot).
        const lastExtended = account.data.readBigUInt64LE(12)
        const ageSlots = currentSlot - lastExtended
        if (ageSlots > 9000n) { // ~1 hour at ~400ms/slot
          const deactivateTx = new Transaction().add(
            AddressLookupTableProgram.deactivateLookupTable({
              lookupTable: pubkey,
              authority: payer.publicKey,
            }),
          )
          await sendAndConfirmTransaction(connection, deactivateTx, [payer])
        }
        continue
      }

      // Check cooldown has passed
      if (currentSlot < deactivationSlot + DEACTIVATION_COOLDOWN_SLOTS) continue

      // Close the ALT and reclaim rent
      const closeTx = new Transaction().add(
        AddressLookupTableProgram.closeLookupTable({
          lookupTable: pubkey,
          authority: payer.publicKey,
          recipient: payer.publicKey,
        }),
      )
      await sendAndConfirmTransaction(connection, closeTx, [payer], { commitment: "confirmed" })
      closed++
    } catch (e) {
      errors.push(`${pubkey.toBase58()}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return NextResponse.json({
    scanned: accounts.length,
    closed,
    errors: errors.length > 0 ? errors : undefined,
  })
}
