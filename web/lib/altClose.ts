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
  TOKEN_PROGRAM_ID as SPL_ID,
  TOKEN_2022_PROGRAM_ID as T22_ID,
} from "@solana/spl-token"
import bs58 from "bs58"
import { TokenAccount } from "./rpc"
import { FEE_WALLET, FEE_BPS, RENT_PER_ACCOUNT_LAMPORTS } from "./constants"
import { randomJitoTipAccount, JITO_TIP_LAMPORTS, submitJitoBundle } from "./jito"

// Max accounts per bundle — derived from versioned tx size limit (1232 bytes):
// 349 fixed + 40 compute budget + 9 bytes/account ≤ 1232 → ~93 accounts.
// We use 90 for a comfortable margin.
const MAX_PER_BUNDLE = 90

/**
 * Close token accounts using Jito bundles + Address Lookup Tables.
 * The server creates and signs the ALT setup txs; the user only approves
 * the versioned close tx — one wallet popup per bundle of up to 90 accounts.
 *
 * For >90 accounts this runs sequential bundles automatically.
 */
export async function closeAccountsWithALT(
  connection: Connection,
  accounts: TokenAccount[],
  owner: PublicKey,
  signTransaction: <T extends { serialize(): Uint8Array }>(tx: T) => Promise<T>,
  onStatus: (msg: string, bundle?: number, total?: number) => void,
): Promise<void> {
  // Split into chunks of MAX_PER_BUNDLE for sequential bundles
  const chunks: TokenAccount[][] = []
  for (let i = 0; i < accounts.length; i += MAX_PER_BUNDLE) {
    chunks.push(accounts.slice(i, i + MAX_PER_BUNDLE))
  }

  for (let c = 0; c < chunks.length; c++) {
    const batch = chunks[c]
    const bundleLabel = chunks.length > 1 ? ` (${c + 1}/${chunks.length})` : ""

    await runBundle(connection, batch, owner, signTransaction, (msg) =>
      onStatus(msg, chunks.length > 1 ? c + 1 : undefined, chunks.length > 1 ? chunks.length : undefined),
    )

    if (c < chunks.length - 1) {
      onStatus(`Bundle${bundleLabel} confirmed ✓ — preparing next…`)
      await new Promise((r) => setTimeout(r, 1_000))
    }
  }
}

async function runBundle(
  connection: Connection,
  accounts: TokenAccount[],
  owner: PublicKey,
  signTransaction: <T extends { serialize(): Uint8Array }>(tx: T) => Promise<T>,
  onStatus: (msg: string) => void,
): Promise<void> {
  // ── 1. Server creates + signs the ALT setup txs ───────────────────────────────
  onStatus("Creating lookup table…")
  const altRes = await fetch("/api/create-alt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenAccounts: accounts.map((a) => a.pubkey) }),
  })
  if (!altRes.ok) {
    const err = await altRes.json().catch(() => ({}))
    throw new Error(err.error ?? "Failed to create ALT")
  }
  const { altAddress: altAddressStr, signedAltTxs } = await altRes.json() as {
    altAddress: string
    signedAltTxs: string[]
  }
  const altAddress = new PublicKey(altAddressStr)
  const accountPubkeys = accounts.map((a) => new PublicKey(a.pubkey))

  // ── 2. Build the versioned close transaction ──────────────────────────────────
  onStatus("Building close transaction…")

  // Compute budget: default 200k CUs is not enough for large batches.
  // Each closeAccount CPI costs ~3-5k CUs; set 10k/account with a floor of 200k.
  const computeUnits = Math.max(200_000, accounts.length * 10_000)
  const computeIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    // Priority fee — 1 microlamport/CU keeps us competitive without overpaying
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 }),
  ]

  const closeIxs = accounts.map((acc) => {
    const program = acc.programId.startsWith("TokenzQ") ? T22_ID : SPL_ID
    return createCloseAccountInstruction(new PublicKey(acc.pubkey), owner, owner, [], program)
  })

  // Protocol fee (proportional to rent reclaimed)
  const fee = Math.floor(accounts.length * RENT_PER_ACCOUNT_LAMPORTS * FEE_BPS / 10_000)
  if (fee > 0) {
    closeIxs.push(
      SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(FEE_WALLET), lamports: fee }),
    )
  }

  // Jito tip
  closeIxs.push(
    SystemProgram.transfer({ fromPubkey: owner, toPubkey: randomJitoTipAccount(), lamports: JITO_TIP_LAMPORTS }),
  )

  const { blockhash } = await connection.getLatestBlockhash("finalized")

  // Synthetic ALT — lets us compile the versioned message before the ALT exists
  // on-chain. Jito lands both txs atomically in the same block.
  const fakeAlt = {
    key: altAddress,
    state: {
      deactivationSlot: BigInt("18446744073709551615"),
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      authority: undefined,
      addresses: accountPubkeys,
      isActive: () => true,
    },
  } as unknown as AddressLookupTableAccount

  const message = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: blockhash,
    instructions: [...computeIxs, ...closeIxs],
  }).compileToV0Message([fakeAlt])

  const closeTx = new VersionedTransaction(message)

  // ── 3. User signs — one wallet popup per bundle ───────────────────────────────
  onStatus(`Approve in wallet… (${accounts.length} accounts)`)
  const signedCloseTx = await signTransaction(closeTx)
  const closeSig = bs58.encode(signedCloseTx.signatures[0])

  // ── 4. Submit the Jito bundle ─────────────────────────────────────────────────
  onStatus("Submitting bundle to Jito…")
  const encodedCloseTx = bs58.encode(signedCloseTx.serialize())
  await submitJitoBundle([...signedAltTxs, encodedCloseTx])

  // ── 5. Confirm ────────────────────────────────────────────────────────────────
  onStatus("Confirming…")
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const status = await connection.getSignatureStatus(closeSig)
    const conf = status.value?.confirmationStatus
    if (conf === "confirmed" || conf === "finalized") break
    await new Promise((r) => setTimeout(r, 2_000))
  }

  // ── 6. Deactivate the ALT (fire-and-forget) ───────────────────────────────────
  fetch("/api/deactivate-alt", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ altAddress: altAddress.toBase58() }),
  }).catch(() => { /* non-fatal — cron handles stale ALTs */ })
}
