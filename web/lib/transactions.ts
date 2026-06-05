import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
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
} from "./constants"
import { TokenAccount, PumpAccumulatorAccount } from "./rpc"

// ── Pump / PumpSwap close_user_volume_accumulator ─────────────────────────────

const PUMP_PROGRAM_ID     = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
const PUMPSWAP_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA")

// sha256("global:close_user_volume_accumulator")[0:8]
const CLOSE_UV_DISCRIMINATOR = Buffer.from([249, 69, 164, 218, 150, 103, 84, 138])

function pumpEventAuthority(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], programId)[0]
}

/**
 * Build one Transaction that closes a single UserVolumeAccumulator PDA.
 * Requires total_unclaimed_tokens == 0 && cashback_earned == 0 on-chain.
 * A small SOL fee is charged identical to the token-close fee rate.
 */
export function buildClosePumpAccumulatorTransaction(
  owner: PublicKey,
  acc: PumpAccumulatorAccount,
): Transaction {
  const programId    = acc.program === "pump" ? PUMP_PROGRAM_ID : PUMPSWAP_PROGRAM_ID
  const accPubkey    = new PublicKey(acc.pubkey)
  const eventAuth    = pumpEventAuthority(programId)

  const closeIx = new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accPubkey,               isSigner: false, isWritable: true  },
      { pubkey: owner,                   isSigner: true,  isWritable: true  },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: eventAuth,               isSigner: false, isWritable: false },
      { pubkey: programId,               isSigner: false, isWritable: false },
    ],
    data: CLOSE_UV_DISCRIMINATOR,
  })

  const tx = new Transaction()
  tx.add(closeIx)

  // Take the same % fee as token closes (charged as a SOL transfer)
  const fee = Math.floor(acc.lamports * FEE_BPS / 10_000)
  if (fee > 0) {
    tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: new PublicKey(FEE_WALLET), lamports: fee }))
  }

  return tx
}

export function buildClosePumpAccumulatorTransactions(
  owner: PublicKey,
  accounts: PumpAccumulatorAccount[],
): Transaction[] {
  return accounts.map((acc) => buildClosePumpAccumulatorTransaction(owner, acc))
}

const FEE_PUBKEY = new PublicKey(FEE_WALLET)

function pid(acc: TokenAccount): PublicKey {
  return acc.programId.startsWith("TokenzQ") ? T22_ID : SPL_ID
}

function feeForCount(n: number): number {
  return Math.floor(n * RENT_PER_ACCOUNT_LAMPORTS * FEE_BPS / 10_000)
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
function buildCloseTx(owner: PublicKey, batch: TokenAccount[]): Transaction {
  const tx = new Transaction()
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
  const fee = feeForCount(batch.length)
  if (fee > 0) {
    tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: FEE_PUBKEY, lamports: fee }))
  }
  return tx
}

function buildBurnCloseTx(owner: PublicKey, batch: TokenAccount[]): Transaction {
  const tx = new Transaction()
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
  const fee = feeForCount(batch.length)
  if (fee > 0) {
    tx.add(SystemProgram.transfer({ fromPubkey: owner, toPubkey: FEE_PUBKEY, lamports: fee }))
  }
  return tx
}

/** Returns batched, unsigned transactions ready for blockhash + send. */
export function buildCloseTransactions(owner: PublicKey, accounts: TokenAccount[]): Transaction[] {
  return chunk(accounts, ACCOUNTS_PER_TX).map((batch) => buildCloseTx(owner, batch))
}

export function buildBurnAndCloseTransactions(owner: PublicKey, accounts: TokenAccount[]): Transaction[] {
  return chunk(accounts, ACCOUNTS_PER_TX).map((batch) => buildBurnCloseTx(owner, batch))
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
