/**
 * altClose.ts
 *
 * Close up to MAX_PER_BUNDLE (90) empty token accounts in a single wallet approval
 * using Address Lookup Tables (ALTs).
 *
 * Flow:
 *  1. Server creates + signs ALT setup txs (create + extend chunks)
 *  2. Client submits ALT txs to RPC and waits for on-chain confirmation
 *  3. Client fetches the real ALT from chain
 *  4. Build versioned close tx — Phantom simulation succeeds ✓
 *  5. User approves once in wallet
 *  6. Submit close tx via normal RPC (priority fee included)
 *  7. Deactivate ALT fire-and-forget
 */

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js"
import {
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID as SPL_ID,
  TOKEN_2022_PROGRAM_ID as T22_ID,
} from "@solana/spl-token"
import bs58 from "bs58"
import { TokenAccount } from "./rpc"
import { FEE_WALLET, FEE_BPS, RENT_PER_ACCOUNT_LAMPORTS } from "./constants"

const MAX_PER_BUNDLE = 90

export async function closeAccountsWithALT(
  connection: Connection,
  accounts: TokenAccount[],
  owner: PublicKey,
  signTransaction: <T extends { serialize(): Uint8Array }>(tx: T) => Promise<T>,
  onStatus: (msg: string, bundle?: number, total?: number) => void,
): Promise<void> {
  const chunks: TokenAccount[][] = []
  for (let i = 0; i < accounts.length; i += MAX_PER_BUNDLE) {
    chunks.push(accounts.slice(i, i + MAX_PER_BUNDLE))
  }

  for (let c = 0; c < chunks.length; c++) {
    await runCloseBundle(
      connection,
      chunks[c],
      owner,
      signTransaction,
      (msg) => onStatus(msg, chunks.length > 1 ? c + 1 : undefined, chunks.length > 1 ? chunks.length : undefined),
    )

    if (c < chunks.length - 1) {
      onStatus(`Bundle ${c + 1}/${chunks.length} confirmed ✓ — preparing next…`)
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
}

async function runCloseBundle(
  connection: Connection,
  accounts: TokenAccount[],
  owner: PublicKey,
  signTransaction: <T extends { serialize(): Uint8Array }>(tx: T) => Promise<T>,
  onStatus: (msg: string) => void,
): Promise<void> {
  // ── 1. Server creates + signs ALT setup txs ────────────────────────────────
  onStatus("Setting up lookup table…")
  const altRes = await fetch("/api/create-alt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenAccounts: accounts.map((a) => a.pubkey) }),
  })
  if (!altRes.ok) {
    const err = await altRes.json().catch(() => ({}))
    throw new Error(err.error ?? "Failed to create ALT")
  }
  const { altAddress: altAddressStr, signedAltTxs } = (await altRes.json()) as {
    altAddress: string
    signedAltTxs: string[]
  }
  const altAddress = new PublicKey(altAddressStr)

  // ── 2. Submit ALT txs + wait for confirmation so Phantom can simulate ──────
  onStatus("Confirming lookup table on-chain…")
  for (const encodedTx of signedAltTxs) {
    const txBytes = bs58.decode(encodedTx)
    const sig = await connection.sendRawTransaction(txBytes, { skipPreflight: true })
    const latest = await connection.getLatestBlockhash("confirmed")
    await connection.confirmTransaction(
      { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
      "confirmed",
    )
  }

  // ── 3. Fetch the real ALT now it exists on-chain ───────────────────────────
  const altAccountInfo = await connection.getAddressLookupTable(altAddress)
  if (!altAccountInfo.value) throw new Error("ALT not found on chain after setup")

  // ── 4. Build versioned close tx (simulation will pass) ────────────────────
  onStatus("Building close transaction…")

  const computeUnits = Math.max(200_000, accounts.length * 10_000)
  const computeIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
  ]

  const closeIxs = accounts.map((acc) => {
    const program = acc.programId.startsWith("TokenzQ") ? T22_ID : SPL_ID
    return createCloseAccountInstruction(new PublicKey(acc.pubkey), owner, owner, [], program)
  })

  const fee = Math.floor(accounts.length * RENT_PER_ACCOUNT_LAMPORTS * FEE_BPS / 10_000)
  if (fee > 0) {
    closeIxs.push(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(FEE_WALLET), lamports: fee }),
    )
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed")

  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [...computeIxs, ...closeIxs],
  }).compileToV0Message([altAccountInfo.value])

  const closeTx = new VersionedTransaction(message)

  // ── 5. User signs — Phantom simulation passes ✓ ───────────────────────────
  onStatus(`Approve in wallet… (${accounts.length} accounts)`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signedCloseTx = await signTransaction(closeTx as any)

  // ── 6. Submit via RPC ──────────────────────────────────────────────────────
  onStatus("Submitting transaction…")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const closeSig = await connection.sendRawTransaction((signedCloseTx as any).serialize(), {
    skipPreflight: false,
  })

  // ── 7. Confirm ─────────────────────────────────────────────────────────────
  onStatus("Confirming…")
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(closeSig)
    const conf = status.value?.confirmationStatus
    if (conf === "confirmed" || conf === "finalized") break
    await new Promise((r) => setTimeout(r, 2_000))
  }

  // ── 8. Deactivate ALT (fire-and-forget) ───────────────────────────────────
  fetch("/api/deactivate-alt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ altAddress: altAddress.toBase58() }),
  }).catch(() => { /* non-fatal — cron handles stale ALTs */ })
}
