import { NextRequest, NextResponse } from "next/server"
import { JITO_BUNDLE_URL } from "@/lib/jito"

export async function POST(req: NextRequest) {
  try {
    const { transactions } = (await req.json()) as { transactions: string[] }

    if (!Array.isArray(transactions) || transactions.length === 0) {
      return NextResponse.json({ error: "transactions required" }, { status: 400 })
    }
    if (transactions.length > 5) {
      return NextResponse.json({ error: "Jito bundles support max 5 transactions" }, { status: 400 })
    }

    const res = await fetch(JITO_BUNDLE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [transactions],
      }),
    })

    const data = await res.json()

    if (data.error) {
      console.error("[send-bundle] Jito error:", data.error)
      return NextResponse.json({ error: data.error.message ?? "Jito error" }, { status: 502 })
    }

    return NextResponse.json({ bundleId: data.result })
  } catch (e: unknown) {
    console.error("[send-bundle]", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Internal error" },
      { status: 500 },
    )
  }
}
