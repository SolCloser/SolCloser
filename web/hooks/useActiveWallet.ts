"use client"

import { useEffect, useState } from "react"
import { useSolanaWallets } from "@privy-io/react-auth"

/**
 * Returns the most up-to-date active Solana wallet address.
 *
 * Privy's wallets[0].address can lag when the user switches accounts directly
 * in Phantom (bypassing Privy's connect flow). We listen to the injected
 * provider's `accountChanged` event so the address is always current.
 *
 * Priority: injected provider address → Privy wallet address → null
 */
export function useActiveWallet() {
  const { wallets } = useSolanaWallets()
  const privyWallet = wallets[0]

  const [injectedAddress, setInjectedAddress] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any
    const provider =
      win.phantom?.solana ||
      win.backpack?.solana ||
      win.solflare ||
      win.solana

    if (!provider?.on) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleAccountChanged = (newKey: any) => {
      setInjectedAddress(newKey ? newKey.toString() : null)
    }

    provider.on("accountChanged", handleAccountChanged)

    // Seed with current key if already connected
    if (provider.publicKey) {
      setInjectedAddress(provider.publicKey.toString())
    }

    return () => {
      provider.off?.("accountChanged", handleAccountChanged)
    }
  }, [])

  const activeAddress = injectedAddress ?? privyWallet?.address ?? null

  return {
    activeAddress,
    privyWallet, // still needed for sendTransaction
  }
}
