"use client"

import { PrivyProvider } from "@privy-io/react-auth"
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana"

const solanaConnectors = toSolanaWalletConnectors({ shouldAutoConnect: true })

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#9945FF",
          logo: undefined,
          showWalletLoginFirst: true,
        },
        loginMethods: ["wallet"],
        externalWallets: {
          solana: { connectors: solanaConnectors },
        },
        solanaClusters: [
          {
            name: "mainnet-beta",
            rpcUrl: process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com",
          },
        ],
      }}
    >
      {children}
    </PrivyProvider>
  )
}
