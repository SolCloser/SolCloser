"use client"

import { useEffect, useState } from "react"
import { useSolanaWallets } from "@privy-io/react-auth"

export function useActiveWallet() {
  const { wallets } = useSolanaWallets()
  const [injectedAddress, setInjectedAddress] = useState<string | null>(null)

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const win = window as any

    // Only target known Solana wallets — skip window.solana (MetaMask hijacks it)
    const provider =
      win.phantom?.solana ||
      win.backpack?.solana ||
      win.solflare

    if (!provider) return

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleAccountChanged = (newKey: any) => {
      setInjectedAddress(newKey ? newKey.toString() : null)
    }

    if (provider.on) {
      provider.on("accountChanged", handleAccountChanged)
    }

    if (provider.publicKey) {
      // Already connected (hard refresh or previously connected this session)
      setInjectedAddress(provider.publicKey.toString())
    } else {
      // Soft refresh — wallet may need a moment to restore its session.
      // onlyIfTrusted: true = no popup, silently resolves if previously approved.
      provider
        .connect({ onlyIfTrusted: true })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((result: any) => {
          const key = result?.publicKey ?? provider.publicKey
          if (key) setInjectedAddress(key.toString())
        })
        .catch(() => {
          // Not previously approved or wallet not ready — stay unauthenticated
        })
    }

    return () => {
      provider.off?.("accountChanged", handleAccountChanged)
    }
  }, [])

  const activeAddress = injectedAddress ?? wallets[0]?.address ?? null

  const activeWallet =
    wallets.find((w) => w.address?.toLowerCase() === activeAddress?.toLowerCase()) ??
    wallets[0]

  return {
    activeAddress,
    privyWallet: activeWallet,
  }
}
