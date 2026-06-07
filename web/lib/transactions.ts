import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js"
import {
  createCloseAccountInstruction,
  createBurnInstruction,
  TOKEN_PROGRAM_ID as SPL_ID,
  TOKEN_2022_PROGRAM_ID as T22_ID,
} from "@solana/spl-token"
import {
  FEE_WALLET,
  FEE_BPS,
  RENT_PER_ACCOUNT_LAMPORTS,
  ACCOUNTS_PER_TX,
  BURN_ACCOUNTS_PER_TX,
} from "./constants"
import { TokenAccount } from "./rpc"

const FEE_PUBKEY = new PublicKey(FEE_WALLET)
// Solana rent-exempt minimum for a basic system account (128 bytes)
const RENT_EXEMPT_MIN_LAMPORTS = 890_880

function pid(acc: TokenAccount): PublicKey {
  return acc.programId.startsWith("TokenzQ") ? T22_ID : SPL_ID
}

function feeForCount(n: number): number {
  return Math.floor(n * RENT_PER_ACCOUNT_LAMPORTS * FEE_BPS / 10_000)
}

/**
 * Returns the fee lamports to include in a tx, accounting for the fee wallet's
 * rent-exempt status. If the fee wallet has no balance, a small fee transfer
 * would leave it below rent-exempt and cause simulation failure.
 * In that edge case we skip the fee (fee wallet needs manual funding first).
 */
export async function safeFee(connection: Connection, n: number): Promise<number> {
  const fee = feeForCount(n)
  if (fee === 0) return 0
  try {
    const balance = await connection.getBalance(FEE_PUBKEY)
    // Skip fee if it would leave the fee wallet below rent-exempt minimum
    if (balance < RENT_EXEMPT_MIN_LAMPORTS) return 0
  } catch {
    // If we can't check, include the fee and let simulation catch it
  }
  return fee
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/**
 * Build an unsigned Transaction (no blockhash, no feePayer).
 * The caller must set recentBlockhash + feePayer before sending.
 */
function buildCloseTx(owner: PublicKey, batch: TokenAccount[], fee: number): Transaction {
  const tx = new Transaction()
  // Explicit compute budget — prevents Phantom simulation warnings on newer versions
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.max(50_000, batch.length * 15_000) }))
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }))
  for (const acc of batch) {
    tx.add(
      createCloseAccountInstruction(
        new PublicKey(acc.pubkey),
        owner,
        owner,
        [],
        pid(acc),
      ),
    )
  }
  // Fee is proportional to this batch; skip if fee wallet isn't rent-exempt yet
  const batchFee = Math.floor(fee * batch.length / Math.max(batch.length, 1))
  if (batchFee > 0) {
    tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: FEE_PUBKEY, lamports: batchFee }))
  }
  return tx
}

function buildBurnCloseTx(owner: PublicKey, batch: TokenAccount[], fee: number): Transaction {
  const tx = new Transaction()
  // Explicit compute budget — burn + close costs more CUs than close-only
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: Math.max(100_000, batch.length * 30_000) }))
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }))
  for (const acc of batch) {
    const p = pid(acc)
    if (acc.balance > 0n) {
      tx.add(
        createBurnInstruction(
          new PublicKey(acc.pubkey),
          new PublicKey(acc.mint),
          owner,
          acc.balance,
          [],
          p,
        ),
      )
    }
    tx.add(createCloseAccountInstruction(new PublicKey(acc.pubkey), owner, owner, [], p))
  }
  const batchFee = Math.floor(fee * batch.length / Math.max(batch.length, 1))
  if (batchFee > 0) {
    tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: FEE_PUBKEY, lamports: batchFee }))
  }
  return tx
}

/** Returns batched, unsigned transactions ready for blockhash + send. */
export async function buildCloseTransactions(
  connection: Connection,
  owner: PublicKey,
  accounts: TokenAccount[],
): Promise<Transaction[]> {
  const fee = await safeFee(connection, accounts.length)
  return chunk(accounts, ACCOUNTS_PER_TX).map((batch) => buildCloseTx(owner, batch, fee))
}

export async function buildBurnAndCloseTransactions(
  connection: Connection,
  owner: PublicKey,
  accounts: TokenAccount[],
): Promise<Transaction[]> {
  const fee = await safeFee(connection, accounts.length)
  return chunk(accounts, BURN_ACCOUNTS_PER_TX).map((batch) => buildBurnCloseTx(owner, batch, fee))
}

/** Stamp a fresh blockhash + feePayer onto a transaction right before sending. */
export async function prepareTransaction(
  tx: Transaction,
  connection: Connection,
  payer: PublicKey,
): Promise<Transaction> {
  const { blockhash } = await connection.getLatestBlockhash("finalized")
  tx.recentBlockhash = blockhash
  tx.feePayer = payer
  return tx
}

/** Estimate SOL user receives after 20% fee */
export function estimateReclaim(count: number): { gross: number; fee: number; net: number } {
  const gross = (count * RENT_PER_ACCOUNT_LAMPORTS) / 1e9
  const fee = (gross * FEE_BPS) / 10_000
  return { gross, fee, net: gross - fee }
}
