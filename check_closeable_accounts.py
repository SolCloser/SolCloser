#!/usr/bin/env python3
"""
Solana Closeable Accounts Checker
Reads wallet addresses from wallets.txt and reports token accounts
that can be closed to reclaim SOL rent (~0.00203928 SOL each).
"""

import json
import sys
import time
import urllib.request
import urllib.error

# ── Config ────────────────────────────────────────────────────────────────────
# Swap this for a private RPC to avoid rate limits.
# Free options: https://helius.dev  |  https://quicknode.com
RPC_URL = "https://api.mainnet-beta.solana.com"

WALLETS_FILE = "wallets.txt"
RENT_PER_ACCOUNT = 0.00203928  # SOL — standard token account rent exemption
DELAY_BETWEEN_WALLETS = 1.2    # seconds — increase if still rate-limited
MAX_RETRIES = 5
RETRY_BACKOFF = 2.0            # seconds, doubles on each retry

# ── RPC helper ────────────────────────────────────────────────────────────────

def rpc(method: str, params: list) -> dict:
    payload = json.dumps({
        "jsonrpc": "2.0",
        "id": 1,
        "method": method,
        "params": params,
    }).encode()

    for attempt in range(1, MAX_RETRIES + 1):
        req = urllib.request.Request(
            RPC_URL,
            data=payload,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                # RPC-level rate limit comes back as an error object
                if "error" in data:
                    code = data["error"].get("code", 0)
                    msg  = data["error"].get("message", "")
                    if code == 429 or "too many" in msg.lower():
                        raise urllib.error.URLError(f"RPC 429: {msg}")
                return data
        except urllib.error.URLError as e:
            wait = RETRY_BACKOFF * (2 ** (attempt - 1))
            if attempt < MAX_RETRIES:
                print(f"\n  [rate-limited, retry {attempt}/{MAX_RETRIES} in {wait:.0f}s]", end="", flush=True)
                time.sleep(wait)
            else:
                print(f"\n  [failed after {MAX_RETRIES} retries: {e}]")
                return {}
    return {}


def get_token_accounts(wallet: str) -> list[dict]:
    """Return all SPL token accounts for a wallet."""
    resp = rpc("getTokenAccountsByOwner", [
        wallet,
        {"programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},
        {"encoding": "jsonParsed"},
    ])
    return resp.get("result", {}).get("value", [])


def check_wallet(wallet: str) -> dict:
    """Return stats about closeable accounts for one wallet."""
    accounts = get_token_accounts(wallet)

    closeable = []
    non_empty = []

    for acc in accounts:
        info = acc.get("account", {}).get("data", {}).get("parsed", {}).get("info", {})
        token_amount = info.get("tokenAmount", {})
        amount = int(token_amount.get("amount", "0"))
        mint = info.get("mint", "unknown")
        pubkey = acc.get("pubkey", "")

        if amount == 0:
            closeable.append({"pubkey": pubkey, "mint": mint})
        else:
            non_empty.append({"pubkey": pubkey, "mint": mint, "amount": amount})

    return {
        "wallet": wallet,
        "total_accounts": len(accounts),
        "closeable": closeable,
        "non_empty": non_empty,
        "reclaimable_sol": round(len(closeable) * RENT_PER_ACCOUNT, 8),
    }


# ── Main ──────────────────────────────────────────────────────────────────────

def load_wallets(path: str) -> list[str]:
    try:
        with open(path) as f:
            return [line.strip() for line in f if line.strip() and not line.startswith("#")]
    except FileNotFoundError:
        print(f"Error: '{path}' not found. Create it with one wallet address per line.")
        sys.exit(1)


def main():
    wallets = load_wallets(WALLETS_FILE)
    if not wallets:
        print("No wallet addresses found in wallets.txt")
        sys.exit(1)

    print(f"\n{'═'*60}")
    print(f"  Solana Closeable Accounts Checker")
    print(f"  Checking {len(wallets)} wallet(s)...")
    print(f"{'═'*60}\n")

    grand_closeable = 0
    grand_sol = 0.0

    results = []
    for i, wallet in enumerate(wallets, 1):
        print(f"[{i}/{len(wallets)}] {wallet[:8]}...{wallet[-4:]}", end="  ", flush=True)
        result = check_wallet(wallet)
        results.append(result)
        if i < len(wallets):
            time.sleep(DELAY_BETWEEN_WALLETS)

        n = len(result["closeable"])
        sol = result["reclaimable_sol"]
        grand_closeable += n
        grand_sol += sol

        if n == 0:
            print("✓  No closeable accounts")
        else:
            print(f"⚠  {n} closeable  →  +{sol:.8f} SOL")

    # ── Summary ───────────────────────────────────────────────────────────────
    print(f"\n{'═'*60}")
    print(f"  SUMMARY")
    print(f"{'─'*60}")
    print(f"  Wallets scanned       : {len(wallets)}")
    print(f"  Total closeable accs  : {grand_closeable}")
    print(f"  Total reclaimable SOL : {grand_sol:.8f}")
    print(f"{'═'*60}\n")

    # ── Detail view ───────────────────────────────────────────────────────────
    has_closeable = [r for r in results if r["closeable"]]
    if has_closeable:
        print("Closeable accounts detail:")
        for r in has_closeable:
            w = r["wallet"]
            print(f"\n  Wallet: {w}")
            for acc in r["closeable"]:
                print(f"    Account : {acc['pubkey']}")
                print(f"    Mint    : {acc['mint']}")
                print()
        print("Tip: Use your wallet UI (Phantom, Backpack, etc.) or a tool like")
        print("     https://sol-incinerator.com  /  https://emptymy.wallet  to close them.\n")
    else:
        print("All wallets are clean — no closeable accounts found.\n")


if __name__ == "__main__":
    main()
