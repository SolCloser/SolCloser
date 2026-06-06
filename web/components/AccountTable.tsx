"use client"

import { useState, useMemo, useEffect, useRef } from "react"
import { TokenAccount } from "@/lib/rpc"
import { RENT_PER_ACCOUNT_LAMPORTS } from "@/lib/constants"

const MAX_LIST_VALUE = 100   // accounts worth more than this are hidden
const DEFAULT_THRESHOLD = 0  // auto-select threshold (USD)
const RENT_SOL = RENT_PER_ACCOUNT_LAMPORTS / 1e9

// ── Price fetching (proxied via /api/prices to avoid CORS) ───────────────────

async function fetchPrices(mints: string[]): Promise<Record<string, number>> {
  if (mints.length === 0) return {}
  const unique = [...new Set(mints)]
  const out: Record<string, number> = {}

  // Proxy through our own API route to avoid CORS — chunks of 100
  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100))

  await Promise.allSettled(
    chunks.map(async (c) => {
      try {
        const r = await fetch("/api/prices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mints: c }),
        })
        if (!r.ok) return
        const data: Record<string, number> = await r.json()
        for (const [mint, price] of Object.entries(data)) {
          if (price > 0) out[mint] = price
        }
      } catch { /* ignore */ }
    }),
  )

  return out
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtUsd(v: number): string {
  if (v === 0) return "$0.00"
  if (v < 0.0001) return "< $0.0001"
  if (v < 1) return `$${v.toFixed(4)}`
  if (v < 1000) return `$${v.toFixed(2)}`
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
}

function fmtAmount(uiAmount: string): string {
  const n = parseFloat(uiAmount)
  if (isNaN(n) || n === 0) return "0.00"
  if (n < 0.01) return "< 0.01"
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// ── Amount slider helpers (log scale) ─────────────────────────────────────────
// Slider position 0–AMOUNT_LOG_MAX (step 0.1)
// At max position → "No limit" (Infinity)
// Default position = 2 → 10^2 = 100 tokens

const AMOUNT_LOG_MAX = 8        // 10^8 = 100M; treat as "no limit"
const DEFAULT_AMOUNT_LOG = AMOUNT_LOG_MAX  // default = no limit

function logToAmount(log: number): number {
  if (log >= AMOUNT_LOG_MAX) return Infinity
  return Math.round(10 ** log)
}

function fmtAmountThreshold(log: number): string {
  if (log >= AMOUNT_LOG_MAX) return "No limit"
  const v = logToAmount(log)
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}K`
  return v.toLocaleString("en-US")
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  accounts: TokenAccount[]
  type: "closeable" | "nonEmpty"
  selected: Set<string>
  onToggle: (pubkey: string) => void
  onSelectAll: () => void
  onSelectByValue: (pubkeys: string[]) => void
}

// ── Component ─────────────────────────────────────────────────────────────────

export function AccountTable({ accounts, type, selected, onToggle, onSelectAll, onSelectByValue }: Props) {
  const [filter, setFilter] = useState("")
  const [valueThreshold, setValueThreshold] = useState(DEFAULT_THRESHOLD)  // USD
  const [amountLog, setAmountLog] = useState(DEFAULT_AMOUNT_LOG)           // log10 scale
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [pricesLoaded, setPricesLoaded] = useState(false)

  const onSelectByValueRef = useRef(onSelectByValue)
  useEffect(() => { onSelectByValueRef.current = onSelectByValue }, [onSelectByValue])

  // Fetch prices
  useEffect(() => {
    if (type === "closeable") {
      setPricesLoaded(true)
      return
    }
    setPrices({})
    setPricesLoaded(false)
    const mints = accounts.map((a) => a.mint)
    fetchPrices(mints).then((p) => {
      setPrices(p)
      setPricesLoaded(true)
    })
  }, [accounts, type])

  // USD value per account
  const accountValues = useMemo(() => {
    const out: Record<string, number> = {}
    for (const acc of accounts) {
      const price = prices[acc.mint] ?? 0
      out[acc.pubkey] = price * (parseFloat(acc.uiAmount) || 0)
    }
    return out
  }, [accounts, prices])

  // Compute auto-selection as a stable comma-separated string so the effect below
  // only fires when the actual set of pubkeys changes, not on every render.
  const autoSelectKey = useMemo(() => {
    if (!pricesLoaded) return null
    const amountLimit = logToAmount(amountLog)
    return accounts
      .filter((acc) => {
        const val = accountValues[acc.pubkey] ?? 0
        if (type === "nonEmpty" && val > MAX_LIST_VALUE) return false
        const amount = parseFloat(acc.uiAmount) || 0
        return (
          val <= valueThreshold &&
          (isFinite(amountLimit) ? amount <= amountLimit : true)
        )
      })
      .map((acc) => acc.pubkey)
      .sort()
      .join(",")
  }, [pricesLoaded, valueThreshold, amountLog, accountValues, accounts, type])

  useEffect(() => {
    if (autoSelectKey === null) return
    onSelectByValueRef.current(autoSelectKey.split(",").filter(Boolean))
  }, [autoSelectKey])

  // Visible rows (hide > $10, apply text filter)
  const visible = useMemo(() => {
    return accounts
      .filter((acc) => {
        if (type === "nonEmpty" && (accountValues[acc.pubkey] ?? 0) > MAX_LIST_VALUE) return false
        const q = filter.trim().toLowerCase()
        if (!q) return true
        return acc.pubkey.toLowerCase().includes(q)
      })
      .sort((a, b) => (accountValues[b.pubkey] ?? 0) - (accountValues[a.pubkey] ?? 0))
  }, [accounts, accountValues, filter, type])

  if (accounts.length === 0) return null

  const allSelected = visible.length > 0 && visible.every((a) => selected.has(a.pubkey))
  const selectedCount = accounts.filter((a) => selected.has(a.pubkey)).length
  const hiddenCount = accounts.length - visible.length

  return (
    <div className="mt-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-sol-muted">
            {type === "closeable" ? "Empty accounts" : "Low Value Tokens"}
          </h4>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sol-border text-sol-muted">
            {selectedCount}/{accounts.length}
            {hiddenCount > 0 && (
              <span className="opacity-60"> · {hiddenCount} hidden &gt;${MAX_LIST_VALUE}</span>
            )}
          </span>
        </div>
        <button
          onClick={onSelectAll}
          className="text-xs text-sol-purple hover:text-sol-green transition-colors shrink-0"
        >
          {allSelected ? "Deselect all" : "Select all"}
        </button>
      </div>

      {/* Dual sliders — non-empty only */}
      {type === "nonEmpty" && (
        <div className={`relative bg-sol-dark/60 border border-sol-border/60 rounded-xl px-4 py-3 space-y-4 transition-opacity ${!pricesLoaded ? "opacity-50 pointer-events-none" : ""}`}>
          {!pricesLoaded && (
            <div className="absolute inset-0 flex items-center justify-center rounded-xl z-10">
              <span className="text-[11px] font-semibold tracking-widest uppercase text-sol-purple animate-pulse">
                Loading prices…
              </span>
            </div>
          )}
          {/* Value slider */}
          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-sol-muted">Max value</span>
              <span className="font-semibold text-white">
                {valueThreshold === 0 ? "$0.00" : `$${valueThreshold.toFixed(2)}`}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={MAX_LIST_VALUE}
              step={0.1}
              value={valueThreshold}
              onChange={(e) => setValueThreshold(parseFloat(e.target.value))}
              className="w-full h-1 rounded-full cursor-pointer appearance-none accent-[#9945FF]"
              style={{
                background: `linear-gradient(to right, #9945FF 0%, #9945FF ${(valueThreshold / MAX_LIST_VALUE) * 100}%, #1e1e2e ${(valueThreshold / MAX_LIST_VALUE) * 100}%, #1e1e2e 100%)`,
              }}
            />
            <div className="flex justify-between text-[10px] text-sol-muted/60">
              <span>$0</span>
              <span>$100 max listed</span>
            </div>
          </div>

          {/* Amount slider */}
          <div className="space-y-1.5">
            <div className="flex justify-between items-center text-[11px]">
              <span className="text-sol-muted">Max token amount</span>
              <span className="font-semibold text-white">{fmtAmountThreshold(amountLog)}</span>
            </div>
            <input
              type="range"
              min={0}
              max={AMOUNT_LOG_MAX}
              step={0.05}
              value={amountLog}
              onChange={(e) => setAmountLog(parseFloat(e.target.value))}
              className="w-full h-1 rounded-full cursor-pointer appearance-none accent-[#14F195]"
              style={{
                background: `linear-gradient(to right, #14F195 0%, #14F195 ${(amountLog / AMOUNT_LOG_MAX) * 100}%, #1e1e2e ${(amountLog / AMOUNT_LOG_MAX) * 100}%, #1e1e2e 100%)`,
              }}
            />
            <div className="flex justify-between text-[10px] text-sol-muted/60">
              <span>1</span>
              <span>No limit</span>
            </div>
          </div>
        </div>
      )}

      {/* Text filter */}
      {accounts.length >= 10 && (
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by token address…"
          className="w-full bg-sol-dark border border-sol-border rounded-lg px-3 py-1.5 text-xs font-mono text-white placeholder-sol-muted focus:outline-none focus:border-sol-purple/60 transition-colors"
        />
      )}

      {/* Table */}
      <div className="rounded-xl border border-sol-border overflow-hidden">
        {/* Column headers */}
        <div className="grid grid-cols-[auto_1fr_auto_auto] bg-sol-dark/80 border-b border-sol-border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-sol-muted gap-x-4">
          <div className="w-4" />
          <div>Token Address</div>
          <div className="text-right">Amount</div>
          <div className="text-right w-20">{type === "closeable" ? "Reclaim" : "Value"}</div>
        </div>

        {/* Rows */}
        <div
          className="overflow-y-auto"
          style={{ maxHeight: visible.length > 20 ? "360px" : undefined }}
        >
          {visible.length === 0 ? (
            <div className="px-3 py-4 text-xs text-sol-muted text-center">
              {filter ? `No results for "${filter}"` : "No accounts"}
            </div>
          ) : (
            visible.map((acc) => {
              const value = accountValues[acc.pubkey] ?? 0
              const amount = parseFloat(acc.uiAmount) || 0
              const amountLimit = logToAmount(amountLog)
              const autoSelected =
                value <= valueThreshold &&
                (isFinite(amountLimit) ? amount <= amountLimit : true)
              const isChecked = selected.has(acc.pubkey)

              return (
                <label
                  key={acc.pubkey}
                  className={`grid grid-cols-[auto_1fr_auto_auto] items-center px-3 py-2 cursor-pointer border-b border-sol-border/40 last:border-0 transition-colors gap-x-4 ${
                    isChecked ? "bg-sol-purple/[0.08]" : "hover:bg-white/[0.02]"
                  }`}
                >
                  {/* Checkbox */}
                  <input
                    type="checkbox"
                    className="accent-[#9945FF] w-3.5 h-3.5 cursor-pointer"
                    checked={isChecked}
                    onChange={() => onToggle(acc.pubkey)}
                  />

                  {/* Token address */}
                  <a
                    href={`https://solscan.io/account/${acc.pubkey}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="font-mono text-[11px] text-white/70 hover:text-white transition-colors truncate"
                    title={acc.pubkey}
                  >
                    {acc.pubkey.slice(0, 6)}…{acc.pubkey.slice(-4)}
                  </a>

                  {/* Token amount */}
                  <span className="text-[11px] text-sol-muted text-right whitespace-nowrap">
                    {fmtAmount(acc.uiAmount)}
                  </span>

                  {/* Value */}
                  <span
                    className={`text-[11px] text-right whitespace-nowrap w-20 ${
                      type === "closeable"
                        ? "text-sol-green/70"
                        : !pricesLoaded
                        ? "text-sol-muted/40 animate-pulse"
                        : autoSelected && value > 0
                        ? "text-sol-muted"
                        : value > 0
                        ? "text-yellow-400"
                        : "text-sol-muted/40"
                    }`}
                  >
                    {type === "closeable"
                      ? `${RENT_SOL.toFixed(4)} SOL`
                      : pricesLoaded
                      ? fmtUsd(value)
                      : "…"}
                  </span>
                </label>
              )
            })
          )}
        </div>
      </div>

      {filter && (
        <p className="text-[10px] text-sol-muted/60 text-right">
          {visible.length} of {accounts.length} shown
        </p>
      )}
    </div>
  )
}
