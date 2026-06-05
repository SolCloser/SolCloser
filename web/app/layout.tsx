import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "@/components/Providers"
import { Header } from "@/components/Header"

export const metadata: Metadata = {
  title: "SolCloser — Reclaim SOL from empty accounts",
  description: "Bulk scan and close empty Solana token accounts to reclaim rent.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  )
}
