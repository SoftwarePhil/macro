#!/usr/bin/env python3
"""Real Robinhood trading helpers — MCP-assisted, confirm-before-place.

Architecture
------------
1. Daily job scores regime and plans rebalance trades against the *real* tab
   portfolio (synced from Robinhood MCP).
2. Instead of placing orders, it writes rows to ``pending_orders``.
3. You review pending intents (dashboard or CLI), then tell Grok to place them
   via Robinhood MCP on the agentic account.
4. After fills, Grok (or you) marks intents placed and re-syncs portfolio.

Nothing in this module places broker orders. Order placement only happens
through Robinhood MCP with explicit human confirmation.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import db as _db  # noqa: E402
from paper_trade import (  # noqa: E402
    ASSETS,
    plan_rebalance,
    portfolio_value,
    portfolio_weights,
)

ET = ZoneInfo("America/New_York")
TAB_ID = "real"

# Default agentic account (masked as ••••5404 in UI). Override via env.
DEFAULT_ACCOUNT = os.environ.get("ROBINHOOD_ACCOUNT", "951185404")


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_real_config() -> dict:
    tabs = _db.load_tab_config()
    real = next((t for t in tabs if t.get("tab_id") == "real"), None)
    if real is None:
        return {
            "enabled": False,
            "real_trading_enabled": False,
            "max_step_pct": 5.0,
            "account_number": DEFAULT_ACCOUNT,
        }
    port = _db.load_portfolio(TAB_ID)
    return {
        "tab_id": "real",
        "label": real.get("label", "Real (Robinhood)"),
        "type": real.get("type", "robinhood"),
        "enabled": bool(real.get("enabled")),
        "real_trading_enabled": bool(real.get("real_trading_enabled")),
        "max_step_pct": float(real.get("max_step_pct", 5)),
        "starting_capital": float(real.get("starting_capital", 0)),
        "started_at": real.get("started_at"),
        "account_number": port.get("broker_account") or DEFAULT_ACCOUNT,
    }


def is_real_trading_enabled() -> bool:
    return bool(load_real_config().get("real_trading_enabled"))


def enable_real_trading(
    account_number: str | None = None,
    max_step_pct: float = 5.0,
    starting_capital: float | None = None,
) -> dict:
    """Turn on the real tab for intent generation (does NOT place orders)."""
    acct = account_number or DEFAULT_ACCOUNT
    start = datetime.now(ET).strftime("%Y-%m-%d")
    port = _db.load_portfolio(TAB_ID)
    capital = starting_capital
    if capital is None:
        capital = float(port.get("starting_capital") or port.get("cash") or 0)

    _db.upsert_tab_config({
        "tab_id": "real",
        "label": "Real (Robinhood)",
        "type": "robinhood",
        "enabled": True,
        "real_trading_enabled": True,
        "starting_capital": capital,
        "max_step_pct": max_step_pct,
        "use_real_prices": True,
        "started_at": port.get("started_at") or start,
    })

    # Ensure portfolio meta exists with broker account
    if not port.get("holdings") and not port.get("cash"):
        _db.save_portfolio({
            "account_name": "Robinhood Agentic",
            "source": "robinhood_mcp",
            "mode": "real",
            "starting_capital": capital,
            "started_at": start,
            "cash": capital,
            "broker_account": acct,
            "holdings": [{"symbol": s, "shares": 0.0, "avg_cost": 0.0} for s in ASSETS],
            "replace_positions": True,
        }, TAB_ID)
    else:
        port["account_name"] = port.get("account_name") or "Robinhood Agentic"
        port["source"] = "robinhood_mcp"
        port["mode"] = "real"
        port["broker_account"] = acct
        if capital and not port.get("starting_capital"):
            port["starting_capital"] = capital
        _db.save_portfolio(port, TAB_ID)

    return load_real_config()


def disable_real_trading() -> dict:
    cfg = load_real_config()
    tabs = _db.load_tab_config()
    real = next((t for t in tabs if t.get("tab_id") == "real"), {})
    _db.upsert_tab_config({
        "tab_id": "real",
        "label": real.get("label") or "Real (Robinhood)",
        "type": "robinhood",
        "enabled": bool(real.get("enabled")),
        "real_trading_enabled": False,
        "starting_capital": float(real.get("starting_capital") or 0),
        "max_step_pct": float(real.get("max_step_pct") or 5),
        "use_real_prices": bool(real.get("use_real_prices")),
        "started_at": real.get("started_at"),
    })
    # Cancel open intents so nothing is left dangling
    _db.cancel_pending_orders(TAB_ID)
    return load_real_config()


# ---------------------------------------------------------------------------
# Portfolio sync (from MCP push payload)
# ---------------------------------------------------------------------------

def sync_portfolio_from_mcp(payload: dict) -> dict:
    """
    Persist a Robinhood portfolio snapshot.

    Expected shape::

        {
          "account_number": "951185404",
          "account_name": "Agentic",
          "cash": 1234.56,
          "holdings": [
            {"symbol": "QQQ", "shares": 10.5, "avg_cost": 480.0},
            ...
          ],
          "starting_capital": 10000   # optional
        }
    """
    acct = payload.get("account_number") or payload.get("broker_account") or DEFAULT_ACCOUNT
    cash = float(payload.get("cash") or 0)
    holdings_in = payload.get("holdings") or payload.get("positions") or []

    # Normalize + ensure strategy assets present
    by_sym: dict[str, dict] = {}
    for h in holdings_in:
        sym = (h.get("symbol") or "").upper()
        if not sym:
            continue
        by_sym[sym] = {
            "symbol": sym,
            "shares": float(h.get("shares") or h.get("quantity") or 0),
            "avg_cost": float(h.get("avg_cost") or h.get("average_cost") or h.get("average_buy_price") or 0),
        }
    holdings = []
    for sym in ASSETS:
        holdings.append(by_sym.get(sym, {"symbol": sym, "shares": 0.0, "avg_cost": 0.0}))
    # Keep any extra equity symbols for display (optional)
    for sym, h in by_sym.items():
        if sym not in ASSETS:
            holdings.append(h)

    existing = _db.load_portfolio(TAB_ID)
    start = payload.get("starting_capital")
    if start is None:
        start = existing.get("starting_capital") or cash

    portfolio = {
        "account_name": payload.get("account_name") or existing.get("account_name") or "Robinhood Agentic",
        "source": "robinhood_mcp",
        "mode": "real",
        "starting_capital": float(start or 0),
        "started_at": existing.get("started_at") or datetime.now(ET).strftime("%Y-%m-%d"),
        "cash": cash,
        "broker_account": acct,
        "holdings": holdings,
        "replace_positions": True,
    }
    _db.save_portfolio(portfolio, TAB_ID)
    return _db.load_portfolio(TAB_ID)


# ---------------------------------------------------------------------------
# Intent queue
# ---------------------------------------------------------------------------

def queue_rebalance_intents(
    portfolio: dict,
    quotes: dict[str, dict],
    targets: dict[str, int],
    session: str,
    tier: int,
    action: str,
    account_number: str | None = None,
) -> list[dict]:
    """Plan rebalance and write pending_orders. Does not place broker orders."""
    if action == "Hold":
        return []

    cfg = load_real_config()
    max_step = float(cfg.get("max_step_pct", 5))
    acct = account_number or cfg.get("account_number") or DEFAULT_ACCOUNT

    _, trades = plan_rebalance(
        portfolio, quotes, targets, session, tier, action,
        max_step_pct=max_step, mutate=False,
    )
    if not trades:
        return []

    now = datetime.now(ET)
    today = now.strftime("%Y-%m-%d")
    # Replace any prior pending intents for this same session
    _db.supersede_pending_for_session(TAB_ID, today, session)

    rows = []
    for t in trades:
        rows.append({
            "tab_id": TAB_ID,
            "created_at": t["Timestamp"],
            "date": t["Date"],
            "session": t["Session"],
            "symbol": t["Symbol"],
            "side": t["Side"],
            "shares": t["Shares"],
            "price": t["Price"],
            "notional": t["Notional"],
            "reason": t["Reason"],
            "tier": tier,
            "status": "pending",
            "account_number": acct,
            "ref_id": str(uuid.uuid4()),
        })
    ids = _db.insert_pending_orders(rows)
    for i, row in enumerate(rows):
        row["id"] = ids[i]
    return rows


def list_pending(status: str | None = "pending") -> list[dict]:
    return _db.load_pending_orders(TAB_ID, status=status)


def mark_placed(order_id: int, broker_order_id: str | None = None) -> bool:
    ok = _db.update_pending_order_status(
        order_id, "placed", broker_order_id=broker_order_id
    )
    if not ok:
        return False
    # Mirror into real trade log for dashboard history
    row = _db.get_pending_order(order_id)
    if row:
        _db.insert_trade({
            "Timestamp": row.get("placed_at") or datetime.now(ET).isoformat(),
            "Date": row["date"],
            "Session": row["session"],
            "Symbol": row["symbol"],
            "Side": row["side"],
            "Shares": row["shares"],
            "Price": row["price"],
            "Notional": row["notional"],
            "Reason": row.get("reason") or f"MCP placed (order {broker_order_id or order_id})",
        }, TAB_ID)
    return True


def mark_rejected(order_id: int, error: str | None = None) -> bool:
    return _db.update_pending_order_status(
        order_id, "rejected", error_message=error
    )


def cancel_all_pending() -> int:
    return _db.cancel_pending_orders(TAB_ID)


def mcp_place_payload(order: dict) -> dict:
    """Shape a pending row as arguments for Robinhood MCP place_equity_order.

    Prefer market + dollar_amount for buys during regular hours (fractional-
    friendly). Sells use quantity of shares held intent.
    """
    side = order["side"].lower()  # buy | sell
    base = {
        "account_number": order.get("account_number") or DEFAULT_ACCOUNT,
        "symbol": order["symbol"],
        "side": side,
        "type": "market",
        "time_in_force": "gfd",
        "market_hours": "regular_hours",
        "ref_id": order.get("ref_id") or str(uuid.uuid4()),
    }
    if side == "buy":
        base["dollar_amount"] = f"{float(order['notional']):.2f}"
    else:
        # Sell by share quantity (supports fractional market sells)
        base["quantity"] = f"{float(order['shares']):.6f}".rstrip("0").rstrip(".")
    return base


def format_pending_for_confirm(orders: list[dict] | None = None) -> str:
    orders = orders if orders is not None else list_pending("pending")
    if not orders:
        return "No pending real-trade intents."
    lines = [
        f"Pending real trades ({len(orders)}) — confirm before MCP place:",
        f"Account: {orders[0].get('account_number') or DEFAULT_ACCOUNT}",
        "",
    ]
    for o in orders:
        lines.append(
            f"  #{o['id']}  {o['side']:4} {o['symbol']:4}  "
            f"{float(o['shares']):.4f} sh @ ~${float(o['price']):.2f}  "
            f"(${float(o['notional']):,.2f})  "
            f"[{o.get('session')} {o.get('date')}]  {o.get('reason', '')}"
        )
    lines.append("")
    lines.append(
        "To execute: in Grok, say "
        "\"review and place pending real trades on my Agentic account\"."
    )
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(
        description="Real Robinhood helpers (MCP-assisted, confirm-before-place)"
    )
    parser.add_argument("--enable", action="store_true",
                        help="Enable real tab intent generation")
    parser.add_argument("--disable", action="store_true",
                        help="Disable real trading + cancel pending")
    parser.add_argument("--account", type=str, default=None,
                        help="Robinhood account_number for agentic trades")
    parser.add_argument("--list-pending", action="store_true",
                        help="List open pending intents")
    parser.add_argument("--list-all", action="store_true",
                        help="List recent intents (all statuses)")
    parser.add_argument("--cancel-pending", action="store_true",
                        help="Cancel all pending intents")
    parser.add_argument("--mark-placed", type=int, metavar="ID",
                        help="Mark intent as placed after MCP success")
    parser.add_argument("--order-id", type=str, default=None,
                        help="Broker order id when marking placed")
    parser.add_argument("--mark-rejected", type=int, metavar="ID",
                        help="Mark intent rejected")
    parser.add_argument("--error", type=str, default=None,
                        help="Error message for rejected")
    parser.add_argument("--sync-portfolio", action="store_true",
                        help="Read portfolio JSON from stdin and save to real tab")
    parser.add_argument("--show-mcp-payloads", action="store_true",
                        help="Print MCP place_equity_order payloads for pending")
    parser.add_argument("--capital", type=float, default=None,
                        help="Starting capital when enabling")
    args = parser.parse_args()

    if args.enable:
        cfg = enable_real_trading(
            account_number=args.account,
            starting_capital=args.capital,
        )
        print(json.dumps(cfg, indent=2))
        print("\nReal trading ENABLED for intent generation only.")
        print("Orders still require explicit confirmation via Robinhood MCP.")
        return 0

    if args.disable:
        cfg = disable_real_trading()
        print(json.dumps(cfg, indent=2))
        print("\nReal trading DISABLED; pending intents cancelled.")
        return 0

    if args.sync_portfolio:
        payload = json.load(sys.stdin)
        port = sync_portfolio_from_mcp(payload)
        print(json.dumps({
            "ok": True,
            "cash": port.get("cash"),
            "holdings": port.get("holdings"),
            "broker_account": port.get("broker_account"),
            "last_synced": port.get("last_synced"),
        }, indent=2))
        return 0

    if args.mark_placed is not None:
        ok = mark_placed(args.mark_placed, broker_order_id=args.order_id)
        print("ok" if ok else "not found")
        return 0 if ok else 1

    if args.mark_rejected is not None:
        ok = mark_rejected(args.mark_rejected, error=args.error)
        print("ok" if ok else "not found")
        return 0 if ok else 1

    if args.cancel_pending:
        n = cancel_all_pending()
        print(f"cancelled {n} pending intents")
        return 0

    if args.show_mcp_payloads:
        for o in list_pending("pending"):
            print(json.dumps({"pending_id": o["id"], **mcp_place_payload(o)}, indent=2))
            print("---")
        return 0

    if args.list_all:
        rows = list_pending(status=None)
        print(json.dumps(rows, indent=2))
        return 0

    # Default / --list-pending: human-readable pending queue
    print(format_pending_for_confirm())
    if args.list_pending:
        print("\nJSON:")
        print(json.dumps(list_pending("pending"), indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
