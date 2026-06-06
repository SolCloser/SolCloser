"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { usePrivy, useSolanaWallets } from "@privy-io/react-auth"
import { Connection, PublicKey } from "@solana/web3.js"
import { useActiveWallet } from "@/hooks/useActiveWallet"
import { scanWallets, WalletScanResult } from "@/lib/rpc"
import {
  buildCloseTransactions,
  buildBurnAndCloseTransactions,
  prepareTransaction,
  estimateReclaim,
} from "@/lib/transactions"
import { closeAccountsWithALT } from "@/lib/altClose"
import { MAX_WALLETS, SCAN_COOLDOWN_MS, ACCOUNTS_PER_TX, BURN_ACCOUNTS_PER_TX } from "@/lib/constants"
import { AccountTable } from "./AccountTable"

function makeConnection() {
  return new Connection(
    process.env.NEXT_PUBLIC_HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com",
    "confirmed",
  )
}

type Mode = "single" | "bulk"
type TxStatus = "idle" | "sending" | "success" | "error"

interface WalletState {
  result: WalletScanResult
  selectedClose: Set<string>
  selectedBurn: Set<string>
  txStatus: TxStatus
  txMessage: string
}

function short(s: string) {
  return `${s.slice(0, 6)}…${s.slice(-4)}`
}

function fmtSol(sol: number) {
  return sol.toFixed(6)
}

function fmtCooldown(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

function makeWalletState(result: WalletScanResult): WalletState {
  return {
    result,
    selectedClose: new Set(result.closeable.map((a) => a.pubkey)),
    selectedBurn: new Set(result.nonEmpty.map((a) => a.pubkey)),
    txStatus: "idle",
    txMessage: "",
  }
}

// ── Hook: core scan ──────────────────────────────────────────────────────────

function useScan() {
  const [scanning, setScanning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [lastScan, setLastScan] = useState<number | null>(null)
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (!lastScan) return
    const tick = () =>
      setCooldown(Math.ceil(Math.max(0, SCAN_COOLDOWN_MS - (Date.now() - lastScan)) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [lastScan])

  const run = useCallback(
    async (
      addresses: string[],
      onResults: (states: WalletState[]) => void,
    ) => {
      if (scanning) return
      setScanning(true)
      setProgress({ done: 0, total: addresses.length })

      const conn = makeConnection()
      const results = await scanWallets(conn, addresses, (done, total) =>
        setProgress({ done, total }),
      )
      onResults(results.map(makeWalletState))
      setLastScan(Date.now())
      setScanning(false)
    },
    [scanning],
  )

  return { scanning, progress, cooldown, run }
}

// ── Hook: close / burn logic ─────────────────────────────────────────────────

function useCloseAccounts(
  connectedWallet: ReturnType<typeof useSolanaWallets>["wallets"][number] | undefined,
  updateState: (addr: string, patch: Partial<WalletState>) => void,
) {
  return useCallback(
    async (ws: WalletState, mode: "close" | "burn") => {
      if (!connectedWallet) return

      const owner = new PublicKey(connectedWallet.address)
      const conn = makeConnection()
      const accounts =
        mode === "close"
          ? ws.result.closeable.filter((a) => ws.selectedClose.has(a.pubkey))
          : ws.result.nonEmpty.filter((a) => ws.selectedBurn.has(a.pubkey))

      if (accounts.length === 0) return

      const walletAddr = ws.result.wallet
      const closedPubkeys = new Set(accounts.map((a) => a.pubkey))

      const onSuccess = () =>
        updateState(walletAddr, {
          txStatus: "success",
          txMessage: `${accounts.length} account${accounts.length > 1 ? "s" : ""} closed — SOL reclaimed! 🎉`,
          result: {
            ...ws.result,
            closeable: mode === "close"
              ? ws.result.closeable.filter((a) => !closedPubkeys.has(a.pubkey))
              : ws.result.closeable,
            nonEmpty: mode === "burn"
              ? ws.result.nonEmpty.filter((a) => !closedPubkeys.has(a.pubkey))
              : ws.result.nonEmpty,
          },
          selectedClose: mode === "close" ? new Set() : ws.selectedClose,
          selectedBurn: mode === "burn" ? new Set() : ws.selectedBurn,
        })

      const onError = (e: unknown) => {
        const raw = e instanceof Error ? e.message : String(e)
        const msg =
          raw.toLowerCase().includes("reject") || raw.toLowerCase().includes("cancel")
            ? "Transaction cancelled."
            : raw.slice(0, 140)
        updateState(walletAddr, { txStatus: "error", txMessage: msg })
      }

      // ── ALT + Jito path: large close-only batches (1 user approval) ─────────
      if (mode === "close" && accounts.length > ACCOUNTS_PER_TX) {
        updateState(walletAddr, { txStatus: "sending", txMessage: "Preparing Jito bundle…" })
        try {
          await closeAccountsWithALT(
            conn,
            accounts,
            owner,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (tx: any) => connectedWallet.signTransaction(tx),
            (msg, bundle, total) => {
              const prefix = bundle && total ? `[${bundle}/${total}] ` : ""
              updateState(walletAddr, { txMessage: prefix + msg })
            },
          )
          onSuccess()
        } catch (e) {
          onError(e)
        }
        return
      }

      // ── Legacy path: small batches or burn+close ─────────────────────────────
      updateState(walletAddr, { txStatus: "sending", txMessage: "Building transactions…" })
      try {
        const rawTxs =
          mode === "close"
            ? buildCloseTransactions(owner, accounts)
            : buildBurnAndCloseTransactions(owner, accounts)

        for (let i = 0; i < rawTxs.length; i++) {
          updateState(walletAddr, {
            txMessage: `Batch ${i + 1}/${rawTxs.length} — approve in wallet…`,
          })
          const tx = await prepareTransaction(rawTxs[i], conn, owner)
          const sig = await connectedWallet.sendTransaction(tx, conn)
          await conn.confirmTransaction(sig, "confirmed")
          updateState(walletAddr, { txMessage: `Batch ${i + 1}/${rawTxs.length} confirmed ✓` })
        }

        onSuccess()
      } catch (e) {
        onError(e)
      }
    },
    [connectedWallet, updateState],
  )
}

// ── Switch wallet banner ─────────────────────────────────────────────────────

// Attempt to open the injected wallet's account picker.
// Works with Phantom, Backpack, Solflare, and any wallet that follows the
// standard Solana injected provider spec.
async function requestWalletSwitch() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const win = window as any
  const candidates = [
    win.phantom?.solana,
    win.backpack?.solana,
    win.solflare,
    win.solana,
  ].filter(Boolean)

  for (const provider of candidates) {
    try {
      // onlyIfTrusted: false forces the account picker to open
      await provider.connect({ onlyIfTrusted: false })
      return
    } catch {
      // user rejected or provider doesn't support — try next
    }
  }
}

function SwitchWalletBanner({ address }: { address: string }) {
  const [switching, setSwitching] = useState(false)

  const handleSwitch = async () => {
    setSwitching(true)
    try {
      await requestWalletSwitch()
      // Privy picks up accountChanged automatically — no action needed here
    } finally {
      setSwitching(false)
    }
  }

  return (
    <div className="rounded-xl border border-sol-purple/30 bg-sol-purple/5 p-4 space-y-3">
      <p className="text-xs text-sol-muted">
        This wallet is not connected. Switch to{" "}
        <span className="font-mono text-white/70">
          {address.slice(0, 6)}…{address.slice(-4)}
        </span>{" "}
        in your wallet app to close these accounts.
      </p>
      <button
        onClick={handleSwitch}
        disabled={switching}
        className="w-full py-2.5 rounded-xl bg-sol-purple text-white text-sm font-semibold hover:bg-sol-purple/80 disabled:opacity-50 transition-colors"
      >
        {switching ? "Opening wallet…" : "Switch Wallet"}
      </button>
      <p className="text-[11px] text-sol-muted/60 text-center">
        Select the correct account in the popup — this page updates automatically.
      </p>
    </div>
  )
}

// ── Pump accumulator section (collapsed by default) ──────────────────────────

function PumpAccumulatorSection({ accounts }: { accounts: { pubkey: string; programLabel: string; lamports: number }[] }) {
  const [open, setOpen] = useState(false)
  const totalSol = accounts.reduce((s, a) => s + a.lamports, 0) / 1e9

  return (
    <div className="rounded-xl border border-amber-500/20 overflow-hidden">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 bg-amber-500/5 hover:bg-amber-500/10 transition-colors"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-amber-400/70">
            Pump Accumulator Accounts
          </span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400/70">
            {accounts.length}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-amber-400/50">{totalSol.toFixed(6)} SOL locked</span>
          <span className="text-amber-400/50 text-xs">{open ? "▲" : "▼"}</span>
        </div>
      </button>

      {open && (
        <div className="border-t border-amber-500/20">
          <div className="px-4 py-2.5 text-xs text-amber-400/80 bg-amber-500/5 leading-relaxed">
            ⚠️ Do not close these accounts. Pump.fun has not clarified whether accumulator accounts affect $PUMP airdrop eligibility. Hold until further notice.
          </div>
          <div className="divide-y divide-sol-border/30">
            <div className="grid grid-cols-[1fr_auto_auto] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-sol-muted gap-x-4 bg-sol-dark/60">
              <div>Account</div>
              <div className="text-right">Program</div>
              <div className="text-right w-24">Rent (SOL)</div>
            </div>
            {accounts.map((acc) => (
              <div key={acc.pubkey} className="grid grid-cols-[1fr_auto_auto] items-center px-4 py-2 gap-x-4">
                <a
                  href={`https://solscan.io/account/${acc.pubkey}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-[11px] text-white/40 hover:text-white/70 transition-colors truncate"
                >
                  {acc.pubkey.slice(0, 6)}…{acc.pubkey.slice(-4)}
                </a>
                <span className="text-[11px] text-sol-muted/60 text-right whitespace-nowrap">{acc.programLabel}</span>
                <span className="text-[11px] text-sol-muted/60 text-right whitespace-nowrap w-24">
                  {(acc.lamports / 1e9).toFixed(6)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Burn confirm dialog ──────────────────────────────────────────────────────

function BurnConfirmDialog({
  count,
  txCount,
  onConfirm,
  onCancel,
}: {
  count: number
  txCount: number
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm px-4">
      <div className="bg-sol-card border border-orange-500/40 rounded-2xl p-6 max-w-sm w-full space-y-4 shadow-xl">
        <div className="text-center space-y-1">
          <div className="text-3xl">🔥</div>
          <h2 className="text-white font-bold text-lg">Burn & Close</h2>
          <p className="text-sol-muted text-sm">This action is irreversible.</p>
        </div>
        <div className="bg-sol-dark rounded-xl p-4 space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-sol-muted">Accounts to burn</span>
            <span className="text-white font-semibold">{count}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sol-muted">Wallet approvals needed</span>
            <span className="text-orange-400 font-semibold">{txCount} transaction{txCount > 1 ? "s" : ""}</span>
          </div>
        </div>
        <p className="text-xs text-sol-muted text-center">
          Token balances will be burned to zero, then accounts closed. SOL rent is returned to your wallet.
        </p>
        <div className="flex gap-3">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl border border-sol-border text-sol-muted text-sm font-semibold hover:text-white hover:border-white/30 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 text-white text-sm font-semibold hover:opacity-80 transition-opacity"
          >
            Yes, burn & close
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Shared: wallet result card ───────────────────────────────────────────────

interface WalletCardProps {
  ws: WalletState
  isOwner: boolean
  authenticated: boolean
  onLogin: () => void
  onClose: (ws: WalletState, mode: "close" | "burn") => void
  onToggleClose: (pubkey: string) => void
  onToggleBurn: (pubkey: string) => void
  onSelectAllClose: () => void
  onSelectAllBurn: () => void
  onSelectCloseByValue: (pubkeys: string[]) => void
  onSelectBurnByValue: (pubkeys: string[]) => void
}

function WalletCard({
  ws,
  isOwner,
  authenticated,
  onLogin,
  onClose,
  onToggleClose,
  onToggleBurn,
  onSelectAllClose,
  onSelectAllBurn,
  onSelectCloseByValue,
  onSelectBurnByValue,
}: WalletCardProps) {
  const [showBurnConfirm, setShowBurnConfirm] = useState(false)
  const { result, selectedClose, selectedBurn, txStatus, txMessage } = ws
  const total = result.closeable.length + result.nonEmpty.length
  const selClose = result.closeable.filter((a) => selectedClose.has(a.pubkey))
  const selBurn = result.nonEmpty.filter((a) => selectedBurn.has(a.pubkey))
  const reclaim = estimateReclaim(selClose.length + selBurn.length)
  const burnTxCount = Math.ceil(selBurn.length / BURN_ACCOUNTS_PER_TX)

  return (
    <div
      className={`bg-sol-card border rounded-2xl p-5 space-y-4 ${
        result.error
          ? "border-red-500/30"
          : total > 0
          ? "border-sol-purple/30"
          : "border-sol-border"
      }`}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-mono text-sm text-white">{short(result.wallet)}</div>
          <div className="text-xs text-sol-muted mt-0.5">
            {result.error ? (
              <span className="text-red-400">{result.error}</span>
            ) : total === 0 ? (
              <span className="text-sol-green">✓ Clean — nothing to close</span>
            ) : (
              <span>
                {result.closeable.length} empty · {result.nonEmpty.length} low value
              </span>
            )}
          </div>
        </div>
        <a
          href={`https://solscan.io/account/${result.wallet}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-sol-muted hover:text-white transition-colors shrink-0"
        >
          Solscan ↗
        </a>
      </div>

      {result.closeable.length > 0 && (
        <AccountTable
          accounts={result.closeable}
          type="closeable"
          selected={selectedClose}
          onToggle={onToggleClose}
          onSelectAll={onSelectAllClose}
          onSelectByValue={onSelectCloseByValue}
        />
      )}
      {result.nonEmpty.length > 0 && (
        <AccountTable
          accounts={result.nonEmpty}
          type="nonEmpty"
          selected={selectedBurn}
          onToggle={onToggleBurn}
          onSelectAll={onSelectAllBurn}
          onSelectByValue={onSelectBurnByValue}
        />
      )}

      {/* ── Pump accumulator PDAs — display only, collapsed by default ──── */}
      {result.pumpAccumulators.length > 0 && (
        <PumpAccumulatorSection accounts={result.pumpAccumulators} />
      )}


      {total > 0 && (
        <div className="pt-2 border-t border-sol-border space-y-3">
          {(selClose.length > 0 || selBurn.length > 0) && (
            <div className="flex justify-between text-xs text-sol-muted">
              <span>{selClose.length + selBurn.length} selected</span>
              <span>
                Reclaim:{" "}
                <span className="text-sol-green font-semibold">
                  ~{fmtSol(reclaim.gross)} SOL
                </span>
              </span>
            </div>
          )}

          {!authenticated ? (
            <button
              onClick={onLogin}
              className="w-full py-2.5 rounded-xl border border-sol-purple/50 text-sol-purple text-sm font-semibold hover:bg-sol-purple/10 transition-colors"
            >
              Connect wallet to close accounts
            </button>
          ) : !isOwner ? (
            <SwitchWalletBanner address={result.wallet} />
          ) : (
            <div className="flex gap-2">
              {selClose.length > 0 && (
                <button
                  disabled={txStatus === "sending"}
                  onClick={() => onClose(ws, "close")}
                  className="flex-1 py-2.5 rounded-xl bg-sol-purple text-white text-sm font-semibold hover:bg-sol-purple/80 disabled:opacity-40 transition-colors"
                >
                  {txStatus === "sending" ? "Closing…" : `Close ${selClose.length} empty`}
                </button>
              )}
              {selBurn.length > 0 && (
                <button
                  disabled={txStatus === "sending"}
                  onClick={() => setShowBurnConfirm(true)}
                  className="flex-1 py-2.5 rounded-xl bg-gradient-to-r from-orange-500 to-red-500 text-white text-sm font-semibold hover:opacity-80 disabled:opacity-40 transition-opacity"
                >
                  {txStatus === "sending" ? "Burning…" : `Burn & close ${selBurn.length}`}
                </button>
              )}
              {showBurnConfirm && (
                <BurnConfirmDialog
                  count={selBurn.length}
                  txCount={burnTxCount}
                  onConfirm={() => { setShowBurnConfirm(false); onClose(ws, "burn") }}
                  onCancel={() => setShowBurnConfirm(false)}
                />
              )}
            </div>
          )}

          {txMessage && (
            <div
              className={`text-xs px-3 py-2 rounded-lg ${
                txStatus === "success"
                  ? "bg-sol-green/10 text-sol-green"
                  : txStatus === "error"
                  ? "bg-red-500/10 text-red-400"
                  : "bg-sol-purple/10 text-sol-purple"
              }`}
            >
              {txMessage}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Main Scanner ──────────────────────────────────────────────────────────────

export function Scanner() {
  const { ready, authenticated, login, logout } = usePrivy()
  const { activeAddress, privyWallet } = useActiveWallet()
  const connectedWallet = privyWallet // needed for sendTransaction

  const [mode, setMode] = useState<Mode>("single")

  // ── Single mode state ────────────────────────────────────────────────────
  const [singleState, setSingleState] = useState<WalletState | null>(null)
  const singleScan = useScan()

  // ── Bulk mode state ──────────────────────────────────────────────────────
  const [bulkInput, setBulkInput] = useState("")
  const [bulkStates, setBulkStates] = useState<WalletState[]>([])
  const [activeWalletIdx, setActiveWalletIdx] = useState(0)
  const bulkScan = useScan()

  // ── Auto-scan when wallet connects (single mode) ───────────────────────────
  const singleRunRef = useRef(singleScan.run)
  useEffect(() => { singleRunRef.current = singleScan.run }, [singleScan.run])

  const modeRef = useRef(mode)
  useEffect(() => { modeRef.current = mode }, [mode])

  const bulkStatesRef = useRef(bulkStates)
  useEffect(() => { bulkStatesRef.current = bulkStates }, [bulkStates])

  useEffect(() => {
    // Wait for Privy to finish initialising before we act
    if (!ready) return
    const addr = activeAddress
    if (!addr) return
    // In bulk mode with results loaded, don't hijack the view
    if (modeRef.current === "bulk" && bulkStatesRef.current.length > 0) return
    setMode("single")
    setSingleState(null)
    singleRunRef.current([addr], ([ws]) => setSingleState(ws))
  }, [ready, activeAddress]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Single mode update helper ─────────────────────────────────────────────
  const updateSingle = useCallback((_addr: string, patch: Partial<WalletState>) => {
    setSingleState((prev) => (prev ? { ...prev, ...patch } : prev))
  }, [])

  // ── Bulk mode update helper ───────────────────────────────────────────────
  const updateBulk = useCallback((addr: string, patch: Partial<WalletState>) => {
    setBulkStates((prev) =>
      prev.map((ws) => (ws.result.wallet === addr ? { ...ws, ...patch } : ws)),
    )
  }, [])

  const toggleField = (
    setter: React.Dispatch<React.SetStateAction<WalletState[]>>,
    addr: string,
    field: "selectedClose" | "selectedBurn",
    pubkey: string,
  ) => {
    setter((prev) =>
      prev.map((ws) => {
        if (ws.result.wallet !== addr) return ws
        const next = new Set(ws[field])
        next.has(pubkey) ? next.delete(pubkey) : next.add(pubkey)
        return { ...ws, [field]: next }
      }),
    )
  }

  const selectAll = (
    setter: React.Dispatch<React.SetStateAction<WalletState[]>>,
    addr: string,
    field: "selectedClose" | "selectedBurn",
    sourceField: "closeable" | "nonEmpty",
  ) => {
    setter((prev) =>
      prev.map((ws) => {
        if (ws.result.wallet !== addr) return ws
        const all = ws.result[sourceField].every((a) => ws[field].has(a.pubkey))
        return {
          ...ws,
          [field]: all ? new Set() : new Set(ws.result[sourceField].map((a) => a.pubkey)),
        }
      }),
    )
  }

  // ── Close hooks ───────────────────────────────────────────────────────────
  const closeSingle = useCloseAccounts(connectedWallet, updateSingle)
  const closeBulk   = useCloseAccounts(connectedWallet, updateBulk)

  // ── Bulk scan ─────────────────────────────────────────────────────────────
  const handleBulkScan = useCallback(() => {
    const lines = bulkInput.split("\n").map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0 || lines.length > MAX_WALLETS || bulkScan.cooldown > 0) return
    setActiveWalletIdx(0)
    bulkScan.run(lines, (states) => {
      // Sort highest account count first (left → right)
      const sorted = [...states].sort(
        (a, b) =>
          (b.result.closeable.length + b.result.nonEmpty.length) -
          (a.result.closeable.length + a.result.nonEmpty.length),
      )
      setBulkStates(sorted)
      setActiveWalletIdx(0)
    })
  }, [bulkInput, bulkScan])

  // ── Render ────────────────────────────────────────────────────────────────
  const bulkLines = bulkInput.split("\n").map((l) => l.trim()).filter(Boolean)
  const bulkCanScan =
    !bulkScan.scanning && bulkLines.length > 0 && bulkLines.length <= MAX_WALLETS && bulkScan.cooldown === 0

  const activeWalletState = bulkStates[activeWalletIdx] ?? null

  const isOwner = (addr: string) =>
    !!activeAddress && activeAddress.toLowerCase() === addr.toLowerCase()

  return (
    <div className="max-w-5xl mx-auto px-4 py-10 space-y-6">
      {/* Hero */}
      <div className="text-center space-y-2">
        <h1 className="text-4xl font-bold">
          <span className="gradient-text">Reclaim Your SOL</span>
        </h1>
        <p className="text-sol-muted">
          Close up to <strong className="text-white">90 empty token accounts in one wallet approval</strong> — the fastest non-custodial Solana wallet cleaner, powered by Jito bundles.
        </p>
        <p className="text-xs text-sol-muted/60">
          Recover locked SOL rent from unused SPL token accounts · 2.5% fee · only on what you reclaim
        </p>
      </div>

      {/* Mode tabs */}
      <div className="flex bg-sol-card border border-sol-border rounded-xl p-1 gap-1">
        {(["single", "bulk"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 py-2 rounded-lg text-sm font-semibold transition-all ${
              mode === m
                ? "bg-gradient-to-r from-sol-purple to-sol-green text-black"
                : "text-sol-muted hover:text-white"
            }`}
          >
            {m === "single" ? "🔗 Connected Wallet" : "📋 Bulk Scan"}
          </button>
        ))}
      </div>

      {/* ── SINGLE MODE ──────────────────────────────────────────────────── */}
      {mode === "single" && (
        <div className="space-y-4">
          {!authenticated ? (
            <div className="bg-sol-card border border-sol-border rounded-2xl p-10 text-center space-y-4">
              <div className="text-5xl">👛</div>
              <p className="text-white font-semibold text-lg">Connect your wallet</p>
              <p className="text-sol-muted text-sm">
                We&apos;ll automatically scan for closeable accounts.
              </p>
              <button
                onClick={login}
                className="px-8 py-3 rounded-xl bg-gradient-to-r from-sol-purple to-sol-green text-black font-semibold hover:opacity-90 transition-opacity"
              >
                Connect Wallet
              </button>
            </div>
          ) : singleScan.scanning ? (
            <div className="bg-sol-card border border-sol-border rounded-xl p-6 space-y-3">
              <p className="text-sm text-sol-muted text-center">
                Scanning {connectedWallet?.address ? short(connectedWallet.address) : "wallet"}…
              </p>
              <div className="w-full bg-sol-dark rounded-full h-1.5">
                <div className="bg-gradient-to-r from-sol-purple to-sol-green h-1.5 rounded-full animate-pulse w-full" />
              </div>
            </div>
          ) : singleState ? (
            <>
              {/* Summary bar */}
              {(() => {
                const count = singleState.result.closeable.length + singleState.result.nonEmpty.length
                if (count === 0) return null
                const gross = estimateReclaim(count).gross
                return (
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Closeable accounts", value: String(count) },
                      { label: "Reclaimable SOL", value: `~${fmtSol(gross)} SOL` },
                    ].map(({ label, value }) => (
                      <div key={label} className="bg-sol-card border border-sol-border rounded-xl p-4 text-center">
                        <div className="text-xl font-bold text-white">{value}</div>
                        <div className="text-xs text-sol-muted mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                )
              })()}

              <WalletCard
                ws={singleState}
                isOwner={true}
                authenticated={authenticated}
                onLogin={login}
                onClose={(ws, mode) => { closeSingle(ws, mode) }}
                onToggleClose={(pubkey) =>
                  setSingleState((prev) => {
                    if (!prev) return prev
                    const next = new Set(prev.selectedClose)
                    next.has(pubkey) ? next.delete(pubkey) : next.add(pubkey)
                    return { ...prev, selectedClose: next }
                  })
                }
                onToggleBurn={(pubkey) =>
                  setSingleState((prev) => {
                    if (!prev) return prev
                    const next = new Set(prev.selectedBurn)
                    next.has(pubkey) ? next.delete(pubkey) : next.add(pubkey)
                    return { ...prev, selectedBurn: next }
                  })
                }
                onSelectAllClose={() =>
                  setSingleState((prev) => {
                    if (!prev) return prev
                    const all = prev.result.closeable.every((a) => prev.selectedClose.has(a.pubkey))
                    return {
                      ...prev,
                      selectedClose: all
                        ? new Set()
                        : new Set(prev.result.closeable.map((a) => a.pubkey)),
                    }
                  })
                }
                onSelectAllBurn={() =>
                  setSingleState((prev) => {
                    if (!prev) return prev
                    const all = prev.result.nonEmpty.every((a) => prev.selectedBurn.has(a.pubkey))
                    return {
                      ...prev,
                      selectedBurn: all
                        ? new Set()
                        : new Set(prev.result.nonEmpty.map((a) => a.pubkey)),
                    }
                  })
                }
                onSelectCloseByValue={(pubkeys) =>
                  setSingleState((prev) => prev ? { ...prev, selectedClose: new Set(pubkeys) } : prev)
                }
                onSelectBurnByValue={(pubkeys) =>
                  setSingleState((prev) => prev ? { ...prev, selectedBurn: new Set(pubkeys) } : prev)
                }
              />

              <button
                onClick={async () => {
                  if (authenticated) await logout()
                  login()
                }}
                disabled={singleScan.scanning}
                className="w-full py-2.5 rounded-xl border border-sol-border text-sol-muted text-sm hover:text-white hover:border-white/30 disabled:opacity-40 transition-colors"
              >
                {singleScan.scanning ? "Scanning…" : "🔄 I have switched wallets"}
              </button>
            </>
          ) : null}
        </div>
      )}

      {/* ── BULK MODE ────────────────────────────────────────────────────── */}
      {mode === "bulk" && (
        <div className="space-y-4">
          {/* Input */}
          <div className="bg-sol-card border border-sol-border rounded-2xl p-6 space-y-4 sol-glow">
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-white">Wallet addresses</label>
              <span
                className={`text-xs font-mono px-2 py-0.5 rounded-full border ${
                  bulkLines.length > MAX_WALLETS
                    ? "border-red-500/50 text-red-400"
                    : "border-sol-border text-sol-muted"
                }`}
              >
                {bulkLines.length} / {MAX_WALLETS}
              </span>
            </div>

            <textarea
              value={bulkInput}
              onChange={(e) => setBulkInput(e.target.value)}
              placeholder={`Paste wallet addresses, one per line\n(up to ${MAX_WALLETS} wallets)`}
              rows={6}
              className="w-full bg-sol-dark border border-sol-border rounded-xl px-4 py-3 text-sm font-mono text-white placeholder-sol-muted focus:outline-none focus:border-sol-purple/60 transition-colors resize-none"
            />

            <button
              onClick={handleBulkScan}
              disabled={!bulkCanScan}
              className={`w-full py-3 rounded-xl font-semibold text-sm transition-all ${
                bulkCanScan
                  ? "bg-gradient-to-r from-sol-purple to-sol-green text-black hover:opacity-90"
                  : "bg-sol-border text-sol-muted cursor-not-allowed"
              }`}
            >
              {bulkScan.scanning
                ? `Scanning… ${bulkScan.progress.done}/${bulkScan.progress.total}`
                : bulkScan.cooldown > 0
                ? `Next scan in ${fmtCooldown(bulkScan.cooldown)}`
                : "Scan Wallets"}
            </button>

            {bulkLines.length > MAX_WALLETS && (
              <p className="text-red-400 text-xs">Too many wallets — max {MAX_WALLETS}.</p>
            )}
          </div>

          {/* Scanning progress */}
          {bulkScan.scanning && (
            <div className="bg-sol-card border border-sol-border rounded-xl p-4 space-y-2">
              <div className="flex justify-between text-xs text-sol-muted">
                <span>Scanning wallets…</span>
                <span>{bulkScan.progress.done}/{bulkScan.progress.total}</span>
              </div>
              <div className="w-full bg-sol-dark rounded-full h-1.5">
                <div
                  className="bg-gradient-to-r from-sol-purple to-sol-green h-1.5 rounded-full transition-all duration-300"
                  style={{
                    width: `${bulkScan.progress.total
                      ? (bulkScan.progress.done / bulkScan.progress.total) * 100
                      : 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          {/* Results */}
          {bulkStates.length > 0 && !bulkScan.scanning && (
            <div className="space-y-4">
              {/* Wallet selector tabs */}
              <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-thin">
                {bulkStates.map((ws, idx) => {
                  const count = ws.result.closeable.length + ws.result.nonEmpty.length
                  return (
                    <button
                      key={ws.result.wallet}
                      onClick={() => setActiveWalletIdx(idx)}
                      className={`shrink-0 px-3 py-1.5 rounded-lg text-xs font-mono transition-all border ${
                        idx === activeWalletIdx
                          ? "bg-sol-purple text-white border-sol-purple"
                          : "border-sol-border text-sol-muted hover:text-white hover:border-white/30"
                      }`}
                    >
                      {short(ws.result.wallet)}
                      {count > 0 && (
                        <span
                          className={`ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] ${
                            idx === activeWalletIdx
                              ? "bg-white/20"
                              : "bg-sol-purple/20 text-sol-purple"
                          }`}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>

              {/* Active wallet card */}
              {activeWalletState && (
                <WalletCard
                  ws={activeWalletState}
                  isOwner={isOwner(activeWalletState.result.wallet)}
                  authenticated={authenticated}
                  onLogin={login}
                  onClose={closeBulk}
                  onToggleClose={(pubkey) =>
                    toggleField(setBulkStates, activeWalletState.result.wallet, "selectedClose", pubkey)
                  }
                  onToggleBurn={(pubkey) =>
                    toggleField(setBulkStates, activeWalletState.result.wallet, "selectedBurn", pubkey)
                  }
                  onSelectAllClose={() =>
                    selectAll(setBulkStates, activeWalletState.result.wallet, "selectedClose", "closeable")
                  }
                  onSelectAllBurn={() =>
                    selectAll(setBulkStates, activeWalletState.result.wallet, "selectedBurn", "nonEmpty")
                  }
                  onSelectCloseByValue={(pubkeys) =>
                    setBulkStates((prev) =>
                      prev.map((ws) =>
                        ws.result.wallet === activeWalletState.result.wallet
                          ? { ...ws, selectedClose: new Set(pubkeys) }
                          : ws,
                      ),
                    )
                  }
                  onSelectBurnByValue={(pubkeys) =>
                    setBulkStates((prev) =>
                      prev.map((ws) =>
                        ws.result.wallet === activeWalletState.result.wallet
                          ? { ...ws, selectedBurn: new Set(pubkeys) }
                          : ws,
                      ),
                    )
                  }
                />
              )}

              {/* Summary across all wallets */}
              {(() => {
                const total = bulkStates.reduce(
                  (s, ws) => s + ws.result.closeable.length + ws.result.nonEmpty.length,
                  0,
                )
                if (total === 0) return null
                const gross = estimateReclaim(total).gross
                return (
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Total closeable", value: String(total) },
                      { label: "Total reclaimable", value: `~${fmtSol(gross)} SOL` },
                    ].map(({ label, value }) => (
                      <div key={label} className="bg-sol-card border border-sol-border rounded-xl p-4 text-center">
                        <div className="text-xl font-bold text-white">{value}</div>
                        <div className="text-xs text-sol-muted mt-1">{label}</div>
                      </div>
                    ))}
                  </div>
                )
              })()}
            </div>
          )}

          {bulkStates.length > 0 &&
            !bulkScan.scanning &&
            bulkStates.every((ws) => ws.result.closeable.length + ws.result.nonEmpty.length === 0) && (
              <div className="text-center py-10 text-sol-muted">
                <div className="text-4xl mb-3">✓</div>
                <p className="font-semibold text-white">All wallets are clean!</p>
                <p className="text-sm mt-1">No accounts to close.</p>
              </div>
            )}
        </div>
      )}

      {/* ── FAQ ─────────────────────────────────────────────────────────── */}
      <FAQ />
    </div>
  )
}

// ── FAQ ───────────────────────────────────────────────────────────────────────

const FAQ_ITEMS = [
  {
    q: "Is it safe to use SolCloser?",
    a: "Yes. SolCloser never asks for your private key. All transactions are signed directly in your wallet (Phantom, Backpack, Solflare etc.) — we only request your approval for the close transactions, just like any other Solana app.",
  },
  {
    q: "Does SolCloser have access to my funds?",
    a: "No. We can only close empty token accounts that belong to you, and only when you approve each transaction. We have no ability to move SOL or tokens without your explicit signature.",
  },
  {
    q: "What is an empty token account?",
    a: "When you receive or trade a token on Solana, a token account is created on-chain. This account requires a small SOL deposit (~0.002 SOL) called rent. When you sell or transfer all tokens, the account stays open but empty — SolCloser lets you close it and reclaim that SOL.",
  },
  {
    q: "What is the fee?",
    a: "SolCloser charges 2.5% of the SOL reclaimed. For example, closing 10 empty accounts returns ~0.02039 SOL, and our fee is ~0.00051 SOL. You keep the rest.",
  },
  {
    q: "What happens to my tokens when I use Burn & Close?",
    a: "Burn & Close permanently destroys any remaining token balance before closing the account. Only use this on tokens you are certain have no value. The SOL rent is returned to you after burning.",
  },
  {
    q: "Why do large closures use a Jito bundle?",
    a: "For batches over 20 accounts, we use Jito — a Solana transaction bundling service. This lets you close up to 90 accounts in a single wallet approval instead of many separate ones. The transactions are submitted atomically, meaning they all succeed or none do.",
  },
]

function FAQ() {
  const [open, setOpen] = useState<number | null>(null)

  return (
    <div className="mt-8 space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-sol-muted text-center">
        Frequently Asked Questions
      </h2>
      <div className="space-y-2">
        {FAQ_ITEMS.map((item, i) => (
          <div key={i} className="bg-sol-card border border-sol-border rounded-xl overflow-hidden">
            <button
              onClick={() => setOpen(open === i ? null : i)}
              className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
            >
              <span className="text-sm text-white font-medium pr-4">{item.q}</span>
              <span className="text-sol-muted shrink-0">{open === i ? "▲" : "▼"}</span>
            </button>
            {open === i && (
              <div className="px-4 pb-4 text-sm text-sol-muted leading-relaxed border-t border-sol-border/50 pt-3">
                {item.a}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
