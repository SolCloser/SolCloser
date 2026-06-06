/**
 * altBurnClose.ts
 *
 * Burn + close up to ALT_BURN_PER_BUNDLE (35) tokens in a single wallet approval,
 * using Jito bundles + Address Lookup Tables — same pattern as altClose.ts.
 *
 * The ALT stores both the token accounts AND their mints (70 addresses for 35 tokens),
 * enabling burn instructions to reference mints via 1-byte ALT indices rather than
 * 32-byte pubkeys, fitting ~35 burn+close pairs inside the 1232-byte tx limit.
 */

import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
  AddressLookupTableAccount,
} from "@solana/web3.js"
import {
  createCloseAccountInstruction,
  createBurnInstruction,
  TOKEN_PROGRAM_ID as SPL_ID,
  TOKEN_2022_PROGRAM_ID as T22_ID,
} from "@solana/spl-token"
import bs58 from "bs58"
import { TokenAccount } from "./rpc"
import { FEE_WALLET, FEE_BPS, RENT_PER_ACCOUNT_LAMPORTS, ALT_BURN_PER_BUNDLE } from "./constants"
import { randomJitoTipAccount, JITO_TIP_LAMPORTS, submitJitoBundle } from "./jito"

export async function burnAndCloseWithALT(
  connection: Connection,
  accounts: TokenAccount[],
  owner: PublicKey,
  signTransaction: <T extends { serialize(): Uint8Array }>(tx: T) => Promise<T>,
  onStatus: (msg: string, bundle?: number, total?: number) => void,
): Promise<void> {
  // Split into chunks of ALT_BURN_PER_BUNDLE for sequential bundles if needed
  const chunks: TokenAccount[][] = []
  for (let i = 0; i < accounts.length; i += ALT_BURN_PER_BUNDLE) {
    chunks.push(accounts.slice(i, i + ALT_BURN_PER_BUNDLE))
  }

  for (let c = 0; c < chunks.length; c++) {
    await runBurnBundle(
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

async function runBurnBundle(
  connection: Connection,
  accounts: TokenAccount[],
  owner: PublicKey,
  signTransaction: <T extends { serialize(): Uint8Array }>(tx: T) => Promise<T>,
  onStatus: (msg: string) => void,
): Promise<void> {
  // ── 1. Server creates ALT containing token accounts + mints ─────────────────
  onStatus("Creating lookup table…")

  const tokenAccountAddrs = accounts.map((a) => a.pubkey)
  const mintAddrs = accounts.map((a) => a.mint)

  const altRes = await fetch("/api/create-alt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // ALT order: token accounts first, then mints — must match fakeAlt below
    body: JSON.stringify({ tokenAccounts: tokenAccountAddrs, mints: mintAddrs }),
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

  // ── 2. Build the versioned burn+close transaction ────────────────────────────
  onStatus("Building burn transaction…")

  // Burn costs more CUs than close — ~15-20k CUs per token, floor 300k
  const computeUnits = Math.max(300_000, accounts.length * 20_000)
  const computeIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  ]

  const burnCloseIxs = accounts.flatMap((acc) => {
    const program = acc.programId.startsWith("TokenzQ") ? T22_ID : SPL_ID
    const tokenPubkey = new PublicKey(acc.pubkey)
    const mintPubkey = new PublicKey(acc.mint)
    const ixs = []
    // Burn only if there's a balance — empty-but-listed accounts skip the burn
    if (acc.balance > 0n) {
      ixs.push(createBurnInstruction(tokenPubkey, mintPubkey, owner, acc.balance, [], program))
    }
    ixs.push(createCloseAccountInstruction(tokenPubkey, owner, owner, [], program))
    return ixs
  })

  // Protocol fee on reclaimed rent
  const fee = Math.floor(accounts.length * RENT_PER_ACCOUNT_LAMPORTS * FEE_BPS / 10_000)
  if (fee > 0) {
    burnCloseIxs.push(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(FEE_WALLET), lamports: fee }),
    )
  }
  // Jito tip
  burnCloseIxs.push(
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: randomJitoTipAccount(), lamports: JITO_TIP_LAMPORTS }),
  )

  const { blockhash } = await connection.getLatestBlockhash("finalized")

  // Synthetic ALT — same address order as sent to create-alt
  // token accounts first, then mints
  const allAltPubkeys = [
    ...tokenAccountAddrs.map((a) => new PublicKey(a)),
    ...mintAddrs.map((a) => new PublicKey(a)),
  ]

  const fakeAlt = {
    key: altAddress,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: allAltPubkeys,
      isActive: () => true,
    },
  } as unknown as AddressLookupTableAccount

  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [...computeIxs, ...burnCloseIxs],
  }).compileToV0Message([fakeAlt])

  const burnTx = new VersionedTransaction(message)

  // ── 3. User signs — one wallet popup for the whole batch ────────────────────
  onStatus(`Approve in wallet… (${accounts.length} tokens)`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signedBurnTx = await signTransaction(burnTx as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const burnSig = bs58.encode((signedBurnTx as any).signatures[0])

  // ── 4. Submit Jito bundle ────────────────────────────────────────────────────
  onStatus("Submitting bundle to Jito…")
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const encodedBurnTx = bs58.encode((signedBurnTx as any).serialize())
  await submitJitoBundle([...signedAltTxs, encodedBurnTx])

  // ── 5. Confirm ───────────────────────────────────────────────────────────────
  onStatus("Confirming…")
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(burnSig)
    const conf = status.value?.confirmationStatus
    if (conf === "confirmed" || conf === "finalized") break
    await new Promise((r) => setTimeout(r, 2_000))
  }

  // ── 6. Deactivate ALT (fire-and-forget) ─────────────────────────────────────
  fetch("/api/deactivate-alt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ altAddress: altAddress.toBase58() }),
  }).catch(() => { /* non-fatal — cron handles stale ALTs */ })
}
