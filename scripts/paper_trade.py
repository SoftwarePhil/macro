#!/usr/bin/env python3
"""Paper trading engine for 3-tier regime strategy — SQLite backend."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
ET = ZoneInfo("America/New_York")

ASSETS = ["QQQ", "USO", "GLD"]
TAB_ID = "paper"

import sys
sys.path.insert(0, str(ROOT / "scripts"))
import db as _db


# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def load_config() -> dict:
    conn = _db.get_conn()
    tabs = _db.load_tab_config(conn)
    paper = next((t for t in tabs if t.get("tab_id") == "paper"), None)
    if paper is None:
        return {"enabled": False}
    return {
        "id": paper["tab_id"],
        "tab_id": paper["tab_id"],
        "label": paper.get("label", "Paper"),
        "type": paper.get("type", "paper"),
        "enabled": bool(paper.get("enabled")),
        "real_trading_enabled": bool(paper.get("real_trading_enabled")),
        "starting_capital": float(paper.get("starting_capital", 0)),
        "max_step_pct": float(paper.get("max_step_pct", 5)),
        "use_real_prices": bool(paper.get("use_real_prices")),
        "started_at": paper.get("started_at"),
    }


def is_enabled() -> bool:
    return bool(load_config().get("enabled"))


# ---------------------------------------------------------------------------
# Portfolio helpers
# ---------------------------------------------------------------------------

def default_portfolio(starting_capital: float = 100_000.0) -> dict:
    return {
        "account_name": "Paper Trading (Mock)",
        "source": "paper",
        "mode": "paper",
        "starting_capital": starting_capital,
        "started_at": datetime.now(ET).strftime("%Y-%m-%d"),
        "cash": starting_capital,
        "holdings": [
            {"symbol": sym, "shares": 0.0, "avg_cost": 0.0} for sym in ASSETS
        ],
    }


def load_portfolio() -> dict:
    raw = _db.load_portfolio(TAB_ID)
    # If no portfolio exists yet, return a fresh default
    if not raw.get("holdings"):
        cfg = load_config()
        return default_portfolio(cfg.get("starting_capital", 100_000))
    return raw


def save_portfolio(portfolio: dict) -> None:
    _db.save_portfolio(portfolio, TAB_ID)


# ---------------------------------------------------------------------------
# Init
# ---------------------------------------------------------------------------

def init_paper(starting_capital: float = 100_000.0,
               started_at: str | None = None) -> dict:
    start_date = started_at or datetime.now(ET).strftime("%Y-%m-%d")
    conn = _db.get_conn()

    # Snapshot real-tab settings before we rewrite paper defaults
    existing_real = next(
        (t for t in _db.load_tab_config(conn) if t.get("tab_id") == "real"),
        None,
    )

    # Write tab configs
    _db.upsert_tab_config({
        "tab_id": "paper",
        "label": "Paper",
        "type": "paper",
        "enabled": True,
        "real_trading_enabled": False,
        "starting_capital": starting_capital,
        "max_step_pct": 5,
        "use_real_prices": False,
        "started_at": start_date,
    }, conn)

    if existing_real and existing_real.get("real_trading_enabled"):
        # Keep MCP-assisted real trading config intact across paper resets
        _db.upsert_tab_config({
            "tab_id": "real",
            "label": existing_real.get("label") or "Real (Robinhood)",
            "type": "robinhood",
            "enabled": bool(existing_real.get("enabled")),
            "real_trading_enabled": True,
            "starting_capital": float(existing_real.get("starting_capital") or 0),
            "max_step_pct": float(existing_real.get("max_step_pct") or 5),
            "use_real_prices": bool(existing_real.get("use_real_prices")),
            "started_at": existing_real.get("started_at"),
        }, conn)
    else:
        _db.upsert_tab_config({
            "tab_id": "real",
            "label": "Real (Robinhood)",
            "type": "robinhood",
            "enabled": False,
            "real_trading_enabled": False,
            "starting_capital": 0,
            "max_step_pct": 5,
            "use_real_prices": False,
            "started_at": None,
        }, conn)

    portfolio = default_portfolio(starting_capital)
    portfolio["started_at"] = start_date
    _db.save_portfolio(portfolio, TAB_ID, conn)

    return portfolio


# ---------------------------------------------------------------------------
# Portfolio math (pure — no I/O)
# ---------------------------------------------------------------------------

def _holding_map(portfolio: dict) -> dict[str, dict]:
    return {h["symbol"]: h for h in portfolio.get("holdings", [])}


def portfolio_value(portfolio: dict, quotes: dict[str, dict]) -> float:
    total = float(portfolio.get("cash") or 0)
    for sym in ASSETS:
        h = _holding_map(portfolio).get(sym, {})
        shares = float(h.get("shares") or 0)
        price = quotes.get(sym, {}).get("price", 0)
        total += shares * price
    return round(total, 2)


def portfolio_weights(portfolio: dict, quotes: dict[str, dict]) -> dict[str, float]:
    values = {}
    for sym in ASSETS:
        h = _holding_map(portfolio).get(sym, {})
        shares = float(h.get("shares") or 0)
        price = quotes.get(sym, {}).get("price", 0)
        values[sym] = shares * price
    total = sum(values.values()) + float(portfolio.get("cash") or 0)
    if total <= 0:
        return {sym: 0.0 for sym in ASSETS}
    return {sym: round(values[sym] / total * 100, 1) for sym in ASSETS}


# ---------------------------------------------------------------------------
# Plan rebalance (pure — no I/O). Shared by paper fill + real pending intents.
# ---------------------------------------------------------------------------

def plan_rebalance(
    portfolio: dict,
    quotes: dict[str, dict],
    targets: dict[str, int],
    session: str,
    tier: int,
    action: str,
    max_step_pct: float = 5.0,
    mutate: bool = True,
) -> tuple[dict, list[dict]]:
    """Plan capped trades toward target allocation.

    When mutate=True, updates portfolio cash/holdings in place (paper path).
    When mutate=False, returns the planned trades without changing portfolio
    (real pending-intent path).

    targets may include a 'CASH' key. The CASH target is not traded — it
    simply reduces the investable budget so that remaining cash stays parked.
    """
    if action == "Hold":
        return portfolio, []

    import copy
    work = portfolio if mutate else copy.deepcopy(portfolio)

    now = datetime.now(ET)
    today = now.strftime("%Y-%m-%d")
    stamp = now.isoformat()
    holdings = _holding_map(work)
    # Ensure all ASSETS exist as holding stubs
    for sym in ASSETS:
        if sym not in holdings:
            holdings[sym] = {"symbol": sym, "shares": 0.0, "avg_cost": 0.0}
            work.setdefault("holdings", []).append(holdings[sym])

    cash = float(work.get("cash") or 0)
    total = portfolio_value(work, quotes)
    if total <= 0:
        return portfolio if not mutate else work, []

    max_step = total * max_step_pct / 100
    cash_target_pct = float(targets.get("CASH", 0))
    investable_pct = max(0.0, 100.0 - cash_target_pct)
    asset_sum = sum(targets.get(s, 0) for s in ASSETS)
    if asset_sum > 0 and abs(asset_sum - investable_pct) > 2:
        scale = investable_pct / asset_sum
        effective_targets = {s: round(targets.get(s, 0) * scale) for s in ASSETS}
    else:
        effective_targets = {s: targets.get(s, 0) for s in ASSETS}

    trades: list[dict] = []

    # 1) Sells first (overweight assets)
    for sym in ASSETS:
        price = float(quotes.get(sym, {}).get("price") or 0)
        if price <= 0:
            continue
        h = holdings[sym]
        shares = float(h.get("shares") or 0)
        current_val = shares * price
        target_val = total * effective_targets[sym] / 100
        diff = target_val - current_val
        if diff >= -0.01:
            continue
        sell_val = min(-diff, max_step, current_val)
        if sell_val < 1:
            continue
        sell_shares = round(sell_val / price, 4)
        sell_shares = min(sell_shares, shares)
        notional = round(sell_shares * price, 2)
        h["shares"] = round(shares - sell_shares, 4)
        cash += notional
        label = f"{targets.get(sym, 0)}%" + (
            f" [CASH target: {cash_target_pct:.0f}%]" if cash_target_pct else ""
        )
        trades.append({
            "Timestamp": stamp,
            "Date": today,
            "Session": session,
            "Symbol": sym,
            "Side": "SELL",
            "Shares": sell_shares,
            "Price": price,
            "Notional": notional,
            "Reason": f"{action} toward Tier {tier} ({label})",
        })

    work["cash"] = round(cash, 2)

    # Recompute after sells
    total = portfolio_value(work, quotes)
    max_step = total * max_step_pct / 100
    cash = float(work.get("cash") or 0)

    # 2) Buys (underweight assets)
    cash_to_keep = total * cash_target_pct / 100
    deployable_cash = max(0.0, cash - cash_to_keep)

    for sym in ASSETS:
        price = float(quotes.get(sym, {}).get("price") or 0)
        if price <= 0 or deployable_cash < 1:
            continue
        h = holdings[sym]
        shares = float(h.get("shares") or 0)
        current_val = shares * price
        target_val = total * effective_targets[sym] / 100
        diff = target_val - current_val
        if diff <= 0.01:
            continue
        buy_val = min(diff, max_step, deployable_cash)
        if buy_val < 1:
            continue
        buy_shares = round(buy_val / price, 4)
        notional = round(buy_shares * price, 2)
        if notional > deployable_cash:
            buy_shares = round(deployable_cash / price, 4)
            notional = round(buy_shares * price, 2)
        if buy_shares <= 0:
            continue
        old_cost = float(h.get("avg_cost") or 0) * shares
        new_shares = shares + buy_shares
        h["avg_cost"] = round((old_cost + notional) / new_shares, 2) if new_shares else 0
        h["shares"] = round(new_shares, 4)
        cash -= notional
        deployable_cash -= notional
        label = f"{targets.get(sym, 0)}%" + (
            f" [CASH target: {cash_target_pct:.0f}%]" if cash_target_pct else ""
        )
        trades.append({
            "Timestamp": stamp,
            "Date": today,
            "Session": session,
            "Symbol": sym,
            "Side": "BUY",
            "Shares": buy_shares,
            "Price": price,
            "Notional": notional,
            "Reason": f"{action} toward Tier {tier} ({label})",
        })

    work["cash"] = round(cash, 2)
    work["last_synced"] = stamp
    return work, trades


# ---------------------------------------------------------------------------
# Execute rebalance (paper — applies plan + writes)
# ---------------------------------------------------------------------------

def execute_rebalance(
    portfolio: dict,
    quotes: dict[str, dict],
    targets: dict[str, int],
    session: str,
    tier: int,
    action: str,
) -> tuple[dict, list[dict]]:
    """Execute capped paper trades toward target allocation. All writes are atomic."""
    if action == "Hold":
        return portfolio, []

    cfg = load_config()
    max_step_pct = float(cfg.get("max_step_pct", 5))
    portfolio, trades = plan_rebalance(
        portfolio, quotes, targets, session, tier, action,
        max_step_pct=max_step_pct, mutate=True,
    )
    if not trades:
        return portfolio, []

    now = datetime.now(ET)
    today = now.strftime("%Y-%m-%d")

    conn = _db.get_conn()
    with conn:
        _db.save_portfolio(portfolio, TAB_ID, conn)
        _db.insert_trades_batch(trades, TAB_ID, conn)

        total_after = portfolio_value(portfolio, quotes)
        weights = portfolio_weights(portfolio, quotes)
        starting = float(portfolio.get("starting_capital") or
                         cfg.get("starting_capital", 100_000))
        ret = round((total_after / starting - 1) * 100, 2) if starting else 0
        conn.execute("""
            INSERT INTO equity_snapshots
                (tab_id, date, session, total_value, cash,
                 qqq_pct, uso_pct, gld_pct, return_pct, tier)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (TAB_ID, today, session,
              total_after, portfolio["cash"],
              weights["QQQ"], weights["USO"], weights["GLD"],
              ret, tier))

    return portfolio, trades


# ---------------------------------------------------------------------------
# Read helpers (used by server.js via JSON API, not directly)
# ---------------------------------------------------------------------------

def load_trades(limit: int = 50) -> list[dict]:
    return _db.load_trades(TAB_ID, limit)


def load_equity(limit: int = 60) -> list[dict]:
    return _db.load_equity_snapshots(TAB_ID, limit)


def paper_summary(portfolio: dict, quotes: dict[str, dict]) -> dict:
    total = portfolio_value(portfolio, quotes)
    starting = float(portfolio.get("starting_capital") or
                     load_config().get("starting_capital", 100_000))
    ret = round((total / starting - 1) * 100, 2) if starting else 0
    ret_dollar = round(total - starting, 2)
    return {
        "enabled": True,
        "starting_capital": starting,
        "started_at": portfolio.get("started_at") or load_config().get("started_at"),
        "total_value": total,
        "return_pct": ret,
        "return_dollar": ret_dollar,
        "trade_count": _db.count_trades(TAB_ID),
    }


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Paper trading utilities")
    parser.add_argument("--init", action="store_true", help="Reset paper portfolio")
    parser.add_argument("--capital", type=float, default=100_000)
    parser.add_argument("--start-date", type=str, default=None,
                        help="Official start date YYYY-MM-DD")
    args = parser.parse_args()
    if args.init:
        p = init_paper(args.capital, started_at=args.start_date)
        print(f"Paper portfolio reset: ${p['cash']:,.0f} cash · starts {p['started_at']}")
    else:
        parser.print_help()
