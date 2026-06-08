"use client"

import { usePrivy } from "@privy-io/react-auth"
import { useActiveWallet } from "@/hooks/useActiveWallet"

export function Header() {
  const { ready, authenticated, login, logout } = usePrivy()
  const { activeAddress } = useActiveWallet()

  const short = activeAddress
    ? `${activeAddress.slice(0, 4)}…${activeAddress.slice(-4)}`
    : null

  return (
    <header className="border-b border-sol-border bg-sol-card/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Logo mark */}
          <img src="/icon.svg" alt="Rent is Due" className="w-7 h-7 rounded-lg" />
          <span className="font-semibold text-white text-lg tracking-tight">
            Rent is <span className="gradient-text">Due</span>
          </span>
        </div>

        {ready && (
          <div>
            {authenticated ? (
              <div className="flex items-center gap-3">
                {short && (
                  <span className="text-sm text-sol-muted font-mono hidden sm:block">
                    {short}
                  </span>
                )}
                <button
                  onClick={logout}
                  className="text-sm px-3 py-1.5 rounded-lg border border-sol-border text-sol-muted hover:text-white hover:border-white/30 transition-colors"
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button
                onClick={login}
                className="text-sm px-4 py-2 rounded-lg bg-gradient-to-r from-sol-purple to-sol-green text-black font-semibold hover:opacity-90 transition-opacity"
              >
                Connect Wallet
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  )
}
