import type { Metadata } from "next"
import "./globals.css"
import { Providers } from "@/components/Providers"
import { Header } from "@/components/Header"

const BASE_URL = "https://solcloser.app"

export const metadata: Metadata = {
  metadataBase: new URL(BASE_URL),
  title: {
    default: "Close 90 Solana Token Accounts in One Click | SolCloser",
    template: "%s | SolCloser",
  },
  description:
    "Reclaim locked SOL from up to 90 empty token accounts in a single wallet approval. Jito-powered, non-custodial Solana wallet cleaner — 2.5% fee, only on what you recover.",
  keywords: [
    // Core intent
    "reclaim SOL",
    "claim SOL",
    "close token accounts Solana",
    "close empty accounts Solana",
    "Solana wallet cleaner",
    "Solana wallet cleanup",
    "recover locked SOL",
    "recover SOL",
    "SOL rent recovery",
    "rent refund Solana",
    "SOL refund",
    "empty SPL token accounts",
    "unused token accounts",
    "vacant token accounts",
    "close SPL token accounts",
    "SPL token account",
    "Token-2022",
    // Unique angle — nobody else ranks for these
    "bulk close Solana accounts",
    "batch close token accounts",
    "close 90 token accounts",
    "bulk scan Solana wallets",
    "multiple wallet scanner Solana",
    "Jito bundle Solana wallet cleaner",
    "Jito powered wallet cleaner",
    "90 accounts one transaction",
    "close token accounts one click",
    "close token accounts one signature",
    "fastest Solana wallet cleaner",
    // Brand + wallet
    "SolCloser",
    "Phantom wallet cleaner",
    "Backpack wallet cleaner",
    "Solflare wallet cleaner",
    "non-custodial wallet cleaner",
    "Solana cleaner",
    "SOL cleaner",
    // Long tail
    "how to close Solana token accounts",
    "how to reclaim SOL from empty accounts",
    "Solana rent deposit refund",
    "reclaim rent Solana",
    "close unused Solana accounts",
    "Solana account rent",
    "burn tokens Solana",
    "burn dust tokens",
  ],
  authors: [{ name: "SolCloser" }],
  creator: "SolCloser",
  publisher: "SolCloser",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: BASE_URL,
    siteName: "SolCloser",
    title: "Close 90 Solana Token Accounts in One Click | SolCloser",
    description:
      "Reclaim locked SOL from up to 90 empty token accounts in a single wallet approval. Jito-powered, non-custodial — 2.5% fee only on what you recover.",
    images: [
      {
        url: "/og-image.png",
        width: 1200,
        height: 630,
        alt: "SolCloser — Close 90 Solana Token Accounts in One Click",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Close 90 Solana Token Accounts in One Click | SolCloser",
    description:
      "Reclaim locked SOL from up to 90 empty token accounts in a single wallet approval. Jito-powered, non-custodial — 2.5% fee only on what you recover.",
    images: ["/og-image.png"],
  },
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon.png", type: "image/png" },
    ],
    apple: "/favicon.png",
  },
  alternates: {
    canonical: BASE_URL,
  },
}

// JSON-LD structured data
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: "SolCloser",
      url: BASE_URL,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      description:
        "Non-custodial Solana wallet cleaner that closes up to 90 empty SPL token accounts in a single wallet approval using Jito bundles and Address Lookup Tables. Reclaim locked SOL rent deposits instantly.",
      offers: {
        "@type": "Offer",
        price: "0",
        priceCurrency: "USD",
        description: "2.5% fee taken only from recovered SOL — no upfront cost",
      },
      featureList: [
        "Close up to 90 empty token accounts in one wallet signature",
        "Jito bundle powered for atomic, reliable transactions",
        "Bulk scan multiple wallets simultaneously",
        "Non-custodial — private keys never leave your wallet",
        "Supports SPL Token and Token-2022 accounts",
        "2.5% fee only on successfully recovered SOL",
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: [
        {
          "@type": "Question",
          name: "Is SolCloser safe to use?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Yes. SolCloser is fully non-custodial. Your private keys never leave your wallet. Every transaction is reviewed and signed by you — we can only close accounts you explicitly select. No funds are ever held by SolCloser.",
          },
        },
        {
          "@type": "Question",
          name: "Can SolCloser access my funds?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "No. SolCloser never holds your funds or private keys. It only initiates transactions that you sign in your own wallet (Phantom, Backpack, or Solflare). Every action requires your explicit on-screen approval.",
          },
        },
        {
          "@type": "Question",
          name: "What are empty token accounts and why do they hold SOL?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "When you receive any Solana token, approximately 0.00204 SOL is reserved as a rent deposit for the SPL token account. After you transfer or swap the full token balance, the account becomes empty — but your SOL stays locked inside. Closing these vacant accounts refunds that locked rent back to your wallet.",
          },
        },
        {
          "@type": "Question",
          name: "What fee does SolCloser charge?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "SolCloser charges 2.5% of the SOL you recover. There is no upfront cost — the small fee is deducted only from the rent you successfully reclaim. You never pay out of pocket.",
          },
        },
        {
          "@type": "Question",
          name: "How many accounts can SolCloser close at once?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "SolCloser can close up to 90 empty token accounts in a single wallet approval using Jito bundles and Solana Address Lookup Tables (ALTs). This is significantly more than standard tools that are limited to 20 accounts per transaction and require multiple approvals.",
          },
        },
        {
          "@type": "Question",
          name: "What is a Jito bundle and why does it matter?",
          acceptedAnswer: {
            "@type": "Answer",
            text: "Jito bundles are groups of Solana transactions submitted atomically to Jito block engine validators. They either all land together or none of them do, eliminating partial failures. SolCloser uses Jito bundles by default to ensure your account closures are fast and reliable.",
          },
        },
      ],
    },
  ],
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </head>
      <body>
        <Providers>
          <Header />
          <main>{children}</main>
        </Providers>
      </body>
    </html>
  )
}
