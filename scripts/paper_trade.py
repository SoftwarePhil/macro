#!/usr/bin/env python3
"""Paper trading engine for 3-tier regime strategy."""

from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "data" / "paper_config.json"
PORTFOLIO_PATH = ROOT / "data" / "paper_portfolio.json"
TRADES_PATH = ROOT / "data" / "paper_trades.csv"
EQUITY_PATH = ROOT / "data" / "paper_equity.csv"

ASSETS = ["QQQ", "USO", "GLD"]
ET = ZoneInfo("America/New_York")

TRADE_FIELDS = [
    "Timestamp",
    "Date",
    "Session",
    "Symbol",
    "Side",
    "Shares",
    "Price",
    "Notional",
    "Reason",
]

EQUITY_FIELDS = [
    "Date",
    "Session",
    "Total_Value",
    "Cash",
    "QQQ_pct",
    "USO_pct",
    "GLD_pct",
    "Return_pct",
    "Tier",
]


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {"enabled": False}
    data = json.loads(CONFIG_PATH.read_text())
    if isinstance(data, list):
        paper_tab = next((t for t in data if t.get("id") == "paper" or t.get("type") == "paper"), {})
        return {**paper_tab, "enabled": paper_tab.get("enabled", False)}
    return data


def is_enabled() -> bool:
    return bool(load_config().get("enabled"))


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
    if not PORTFOLIO_PATH.exists():
        cfg = load_config()
        return default_portfolio(cfg.get("starting_capital", 100_000))
    return json.loads(PORTFOLIO_PATH.read_text())


def save_portfolio(portfolio: dict) -> None:
    PORTFOLIO_PATH.parent.mkdir(parents=True, exist_ok=True)
    PORTFOLIO_PATH.write_text(json.dumps(portfolio, indent=2))


def init_paper(starting_capital: float = 100_000.0, started_at: str | None = None) -> dict:
    start_date = started_at or datetime.now(ET).strftime("%Y-%m-%d")
    cfg = [
        {
            "id": "paper",
            "label": "Paper",
            "type": "paper",
            "real_trading_enabled": False,
            "enabled": True,
            "starting_capital": starting_capital,
            "max_step_pct": 5,
            "use_real_prices": False,
            "started_at": start_date
        },
        {
            "id": "real",
            "label": "Real (Robinhood)",
            "type": "robinhood",
            "real_trading_enabled": False
        }
    ]
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
    portfolio = default_portfolio(starting_capital)
    portfolio["started_at"] = start_date
    save_portfolio(portfolio)

    for path, fields in ((TRADES_PATH, TRADE_FIELDS), (EQUITY_PATH, EQUITY_FIELDS)):
        with path.open("w", newline="") as f:
            csv.DictWriter(f, fieldnames=fields).writeheader()
    return portfolio


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


def _append_csv(path: Path, fields: list[str], row: dict) -> None:
    exists = path.exists()
    with path.open("a", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        if not exists:
            writer.writeheader()
        writer.writerow(row)


def execute_rebalance(
    portfolio: dict,
    quotes: dict[str, dict],
    targets: dict[str, int],
    session: str,
    tier: int,
    action: str,
) -> tuple[dict, list[dict]]:
    """Execute capped paper trades toward target allocation."""
    if action == "Hold":
        return portfolio, []

    cfg = load_config()
    max_step_pct = float(cfg.get("max_step_pct", 5))
    now = datetime.now(ET)
    today = now.strftime("%Y-%m-%d")
    stamp = now.isoformat()
    holdings = _holding_map(portfolio)
    cash = float(portfolio.get("cash") or 0)
    total = portfolio_value(portfolio, quotes)
    if total <= 0:
        return portfolio, []

    max_step = total * max_step_pct / 100
    trades: list[dict] = []

    # 1) Sells first (overweight assets)
    for sym in ASSETS:
        price = quotes[sym]["price"]
        if price <= 0:
            continue
        h = holdings[sym]
        shares = float(h.get("shares") or 0)
        current_val = shares * price
        target_val = total * targets[sym] / 100
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
        trade = {
            "Timestamp": stamp,
            "Date": today,
            "Session": session,
            "Symbol": sym,
            "Side": "SELL",
            "Shares": sell_shares,
            "Price": price,
            "Notional": notional,
            "Reason": f"{action} toward Tier {tier} ({targets[sym]}%)",
        }
        trades.append(trade)
        _append_csv(TRADES_PATH, TRADE_FIELDS, trade)

    portfolio["cash"] = round(cash, 2)

    # Recompute total after sells for buy sizing
    total = portfolio_value(portfolio, quotes)
    max_step = total * max_step_pct / 100
    cash = float(portfolio.get("cash") or 0)

    # 2) Buys (underweight assets)
    for sym in ASSETS:
        price = quotes[sym]["price"]
        if price <= 0 or cash < 1:
            continue
        h = holdings[sym]
        shares = float(h.get("shares") or 0)
        current_val = shares * price
        target_val = total * targets[sym] / 100
        diff = target_val - current_val
        if diff <= 0.01:
            continue
        buy_val = min(diff, max_step, cash)
        if buy_val < 1:
            continue
        buy_shares = round(buy_val / price, 4)
        notional = round(buy_shares * price, 2)
        if notional > cash:
            buy_shares = round(cash / price, 4)
            notional = round(buy_shares * price, 2)
        if buy_shares <= 0:
            continue
        old_cost = float(h.get("avg_cost") or 0) * shares
        new_shares = shares + buy_shares
        h["avg_cost"] = round((old_cost + notional) / new_shares, 2) if new_shares else 0
        h["shares"] = round(new_shares, 4)
        cash -= notional
        trade = {
            "Timestamp": stamp,
            "Date": today,
            "Session": session,
            "Symbol": sym,
            "Side": "BUY",
            "Shares": buy_shares,
            "Price": price,
            "Notional": notional,
            "Reason": f"{action} toward Tier {tier} ({targets[sym]}%)",
        }
        trades.append(trade)
        _append_csv(TRADES_PATH, TRADE_FIELDS, trade)

    portfolio["cash"] = round(cash, 2)
    portfolio["last_synced"] = stamp
    save_portfolio(portfolio)

    # Equity snapshot
    total = portfolio_value(portfolio, quotes)
    weights = portfolio_weights(portfolio, quotes)
    starting = float(portfolio.get("starting_capital") or load_config().get("starting_capital", 100_000))
    ret = round((total / starting - 1) * 100, 2) if starting else 0
    _append_csv(
        EQUITY_PATH,
        EQUITY_FIELDS,
        {
            "Date": today,
            "Session": session,
            "Total_Value": total,
            "Cash": portfolio["cash"],
            "QQQ_pct": weights["QQQ"],
            "USO_pct": weights["USO"],
            "GLD_pct": weights["GLD"],
            "Return_pct": ret,
            "Tier": tier,
        },
    )
    return portfolio, trades


def load_trades(limit: int = 50) -> list[dict]:
    if not TRADES_PATH.exists():
        return []
    with TRADES_PATH.open(newline="") as f:
        rows = list(csv.DictReader(f))
    return list(reversed(rows[-limit:]))


def load_equity(limit: int = 60) -> list[dict]:
    if not EQUITY_PATH.exists():
        return []
    with EQUITY_PATH.open(newline="") as f:
        rows = list(csv.DictReader(f))
    return rows[-limit:]


def paper_summary(portfolio: dict, quotes: dict[str, dict]) -> dict:
    total = portfolio_value(portfolio, quotes)
    starting = float(
        portfolio.get("starting_capital") or load_config().get("starting_capital", 100_000)
    )
    ret = round((total / starting - 1) * 100, 2) if starting else 0
    ret_dollar = round(total - starting, 2)
    return {
        "enabled": True,
        "starting_capital": starting,
        "started_at": portfolio.get("started_at") or load_config().get("started_at"),
        "total_value": total,
        "return_pct": ret,
        "return_dollar": ret_dollar,
        "trade_count": len(load_trades(9999)),
    }


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Paper trading utilities")
    parser.add_argument("--init", action="store_true", help="Reset paper portfolio")
    parser.add_argument("--capital", type=float, default=100_000)
    parser.add_argument("--start-date", type=str, default=None, help="Official start date YYYY-MM-DD")
    args = parser.parse_args()
    if args.init:
        p = init_paper(args.capital, started_at=args.start_date)
        print(f"Paper portfolio reset: ${p['cash']:,.0f} cash · starts {p['started_at']}")
    else:
        parser.print_help()