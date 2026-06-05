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

  const [injectedAddress, setInjectedAddress] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any

    // Only target known Solana wallets — never window.solana alone which
    // MetaMask can hijack. Prefer explicit namespaces.
    const provider =
      win.phantom?.solana ||
      win.backpack?.solana ||
      win.solflare

    if (!provider) return

    // Silently reconnect if the user has previously approved this site.
    // onlyIfTrusted: true means no popup — it just resolves or rejects quietly.
    if (!provider.publicKey) {
      provider.connect({ onlyIfTrusted: true }).catch(() => {})
    }

    if (!provider.on) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleAccountChanged = (newKey: any) => {
      setInjectedAddress(newKey ? newKey.toString() : null)
    }

    provider.on("accountChanged", handleAccountChanged)

    if (provider.publicKey) {
      setInjectedAddress(provider.publicKey.toString())
    }

    return () => {
      provider.off?.("accountChanged", handleAccountChanged)
    }
  }, [])

  const activeAddress = injectedAddress ?? wallets[0]?.address ?? null

  // Find the wallet object whose address matches the active address so that
  // sendTransaction is called on the correct wallet (injected vs embedded).
  const activeWallet =
    wallets.find((w) => w.address?.toLowerCase() === activeAddress?.toLowerCase()) ??
    wallets[0]

  return {
    activeAddress,
    privyWallet: activeWallet, // still needed for sendTransaction
  }
}
