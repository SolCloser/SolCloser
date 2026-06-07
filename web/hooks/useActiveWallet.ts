"use client"

import { useEffect, useState, useCallback } from "react"
import { useSolanaWallets } from "@privy-io/react-auth"
import { Transaction, VersionedTransaction } from "@solana/web3.js"

type SignableTx = Transaction | VersionedTransaction | { serialize(): Uint8Array }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getInjectedProvider(): any {
  if (typeof window === "undefined") return null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any
  // Only target known Solana wallets — skip window.solana (MetaMask hijacks it)
  return win.phantom?.solana || win.backpack?.solana || win.solflare || null
}

export function useActiveWallet() {
  const { wallets } = useSolanaWallets()
  const [injectedAddress, setInjectedAddress] = useState<string | null>(null)

  useEffect(() => {
    const provider = getInjectedProvider()
    if (!provider) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleAccountChanged = (newKey: any) => {
      setInjectedAddress(newKey ? newKey.toString() : null)
    }

    if (provider.on) provider.on("accountChanged", handleAccountChanged)

    if (provider.publicKey) {
      // Hard refresh — provider already has a key
      setInjectedAddress(provider.publicKey.toString())
    } else {
      // Soft refresh — silently restore session, no popup
      provider
        .connect({ onlyIfTrusted: true })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((result: any) => {
          const key = result?.publicKey ?? provider.publicKey
          if (key) setInjectedAddress(key.toString())
        })
        .catch(() => {
          // Not previously approved — stay unauthenticated
        })
    }

    return () => { provider.off?.("accountChanged", handleAccountChanged) }
  }, [])

  const activeAddress = injectedAddress ?? wallets[0]?.address ?? null

  const activeWallet =
    wallets.find((w) => w.address?.toLowerCase() === activeAddress?.toLowerCase()) ??
    wallets[0]

  /**
   * Unified signTransaction — works in all states:
   *  - Normal flow: delegates to Privy wallet
   *  - After refresh before Privy re-populates wallets[]: falls back to raw provider
   *
   * Without this fallback, buttons silently do nothing on soft refresh because
   * activeAddress is set but privyWallet is undefined.
   */
  const signTransaction = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async <T extends SignableTx>(tx: T): Promise<T> => {
      if (activeWallet?.signTransaction) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return activeWallet.signTransaction(tx as any) as Promise<T>
      }
      // Fallback: raw provider (refresh before Privy wallets array is populated)
      const provider = getInjectedProvider()
      if (provider?.signTransaction) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return provider.signTransaction(tx as any) as Promise<T>
      }
      throw new Error("No wallet connected. Please reconnect and try again.")
    },
    [activeWallet],
  )

  return {
    activeAddress,
    privyWallet: activeWallet,
    signTransaction,
  }
}
