import { Connection, PublicKey } from "@solana/web3.js"
import { SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM } from "./constants"

export interface TokenAccount {
  pubkey: string
  mint: string
  balance: bigint
  decimals: number
  uiAmount: string
  programId: string
}

export interface WalletScanResult {
  wallet: string
  closeable: TokenAccount[]   // zero balance — just close
  nonEmpty: TokenAccount[]    // has tokens — need to burn first
  error?: string
}

export async function scanWallet(
  connection: Connection,
  wallet: string,
): Promise<WalletScanResult> {
  let pubkey: PublicKey
  try {
    pubkey = new PublicKey(wallet)
  } catch {
    return { wallet, closeable: [], nonEmpty: [], error: "Invalid address" }
  }

  try {
    const [spl, t22] = await Promise.allSettled([
      connection.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey(SPL_TOKEN_PROGRAM),
      }),
      connection.getParsedTokenAccountsByOwner(pubkey, {
        programId: new PublicKey(TOKEN_2022_PROGRAM),
      }),
    ])

    const closeable: TokenAccount[] = []
    const nonEmpty: TokenAccount[] = []

    const sources = [
      { result: spl, programId: SPL_TOKEN_PROGRAM },
      { result: t22, programId: TOKEN_2022_PROGRAM },
    ]

    for (const { result, programId } of sources) {
      if (result.status === "rejected") continue
      for (const acc of result.value.value) {
        const info = acc.account.data.parsed.info
        const balance = BigInt(info.tokenAmount.amount)
        const entry: TokenAccount = {
          pubkey: acc.pubkey.toString(),
          mint: info.mint,
          balance,
          decimals: info.tokenAmount.decimals,
          uiAmount: info.tokenAmount.uiAmountString ?? "0",
          programId,
        }
        if (balance === 0n) closeable.push(entry)
        else nonEmpty.push(entry)
      }
    }

    return { wallet, closeable, nonEmpty }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "RPC error"
    return { wallet, closeable: [], nonEmpty: [], error: msg }
  }
}

export async function scanWallets(
  connection: Connection,
  wallets: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<WalletScanResult[]> {
  const results: WalletScanResult[] = []
  for (let i = 0; i < wallets.length; i++) {
    results.push(await scanWallet(connection, wallets[i]))
    onProgress?.(i + 1, wallets.length)
    if (i < wallets.length - 1) await sleep(150)
  }
  return results
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
