#!/usr/bin/env python3
"""
Migrate existing flat-file data into regime.db (SQLite).

Safe to run multiple times — uses INSERT OR IGNORE / upserts so it won't
duplicate data. Reads from:
  - data/paper_config.json   → tab_config
  - data/paper_portfolio.json → portfolio_meta + positions
  - data/paper_trades.csv    → trades
  - data/paper_equity.csv    → equity_snapshots
  - data/paper_chart.json    → chart_snapshots
  - data/live_quotes.json    → quotes  (as mcp-sourced)
  - ../strategy_log.csv      → strategy_log (paper tab)
  - logs/reports/*.md        → llm_reports
"""

from __future__ import annotations

import csv
import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import db as _db

ET = ZoneInfo("America/New_York")


def log(msg: str) -> None:
    print(f"  {msg}")


def migrate_tab_config() -> None:
    print("→ tab_config")
    cfg_path = ROOT / "data" / "paper_config.json"
    if not cfg_path.exists():
        log("paper_config.json not found — seeding defaults")
        _db.upsert_tab_config({
            "tab_id": "paper", "label": "Paper", "type": "paper",
            "enabled": True, "real_trading_enabled": False,
            "starting_capital": 100_000, "max_step_pct": 5,
            "use_real_prices": True, "started_at": None,
        })
        _db.upsert_tab_config({
            "tab_id": "real", "label": "Real (Robinhood)", "type": "robinhood",
            "enabled": False, "real_trading_enabled": False,
            "starting_capital": 0, "max_step_pct": 5,
            "use_real_prices": False, "started_at": None,
        })
        return

    raw = json.loads(cfg_path.read_text())
    tabs = raw if isinstance(raw, list) else [raw]
    for tab in tabs:
        _db.upsert_tab_config({
            "tab_id": tab.get("id") or tab.get("tab_id", "paper"),
            "label": tab.get("label", tab.get("id", "paper")),
            "type": tab.get("type", "paper"),
            "enabled": bool(tab.get("enabled")),
            "real_trading_enabled": bool(tab.get("real_trading_enabled")),
            "starting_capital": float(tab.get("starting_capital", 0)),
            "max_step_pct": float(tab.get("max_step_pct", 5)),
            "use_real_prices": bool(tab.get("use_real_prices")),
            "started_at": tab.get("started_at"),
        })
        log(f"tab_config: {tab.get('id') or tab.get('tab_id')}")


def migrate_portfolio() -> None:
    print("→ portfolio")
    p_path = ROOT / "data" / "paper_portfolio.json"
    if not p_path.exists():
        log("paper_portfolio.json not found — skipping")
        return
    p = json.loads(p_path.read_text())
    _db.save_portfolio(p, "paper")
    log(f"paper: cash=${p.get('cash', 0):,.2f}, {len(p.get('holdings', []))} holdings")


def migrate_trades() -> None:
    print("→ trades")
    t_path = ROOT / "data" / "paper_trades.csv"
    if not t_path.exists():
        log("paper_trades.csv not found — skipping")
        return

    conn = _db.get_conn()
    # Clear existing paper trades to avoid duplicates on re-run
    conn.execute("DELETE FROM trades WHERE tab_id='paper'")
    conn.commit()

    with t_path.open(newline="") as f:
        rows = list(csv.DictReader(f))

    _db.insert_trades_batch(
        [{
            "Timestamp": r["Timestamp"].strip(),
            "Date": r["Date"].strip(),
            "Session": r["Session"].strip(),
            "Symbol": r["Symbol"].strip(),
            "Side": r["Side"].strip(),
            "Shares": r["Shares"].strip(),
            "Price": r["Price"].strip(),
            "Notional": r["Notional"].strip(),
            "Reason": r.get("Reason", "").strip(),
        } for r in rows],
        "paper", conn
    )
    conn.commit()
    log(f"{len(rows)} trade rows imported")


def migrate_equity() -> None:
    print("→ equity_snapshots")
    e_path = ROOT / "data" / "paper_equity.csv"
    if not e_path.exists():
        log("paper_equity.csv not found — skipping")
        return

    conn = _db.get_conn()
    conn.execute("DELETE FROM equity_snapshots WHERE tab_id='paper'")
    conn.commit()

    with e_path.open(newline="") as f:
        rows = list(csv.DictReader(f))

    for r in rows:
        _db.insert_equity_snapshot({
            "Date": r["Date"].strip(),
            "Session": r["Session"].strip(),
            "Total_Value": r["Total_Value"].strip(),
            "Cash": r["Cash"].strip(),
            "QQQ_pct": r["QQQ_pct"].strip(),
            "USO_pct": r["USO_pct"].strip(),
            "GLD_pct": r["GLD_pct"].strip(),
            "Return_pct": r["Return_pct"].strip(),
            "Tier": r["Tier"].strip(),
        }, "paper", conn)
    conn.commit()
    log(f"{len(rows)} equity snapshot rows imported")


def migrate_chart_snapshots() -> None:
    print("→ chart_snapshots")
    c_path = ROOT / "data" / "paper_chart.json"
    if not c_path.exists():
        log("paper_chart.json not found — skipping")
        return

    data = json.loads(c_path.read_text())
    points = data.get("points", [])
    if not points:
        log("no points in paper_chart.json — skipping")
        return

    conn = _db.get_conn()
    conn.execute("DELETE FROM chart_snapshots WHERE tab_id='paper'")
    with conn:
        for p in points:
            conn.execute(
                "INSERT INTO chart_snapshots (tab_id, ts, value, return_pct) VALUES (?,?,?,?)",
                ("paper", int(p["ts"]), float(p["value"]), float(p.get("returnPct", 0)))
            )
    log(f"{len(points)} chart snapshot points imported")


def migrate_strategy_log() -> None:
    print("→ strategy_log")
    # Try the canonical location (one level above repo root)
    log_path = ROOT.parent / "strategy_log.csv"
    if not log_path.exists():
        log(f"strategy_log.csv not found at {log_path} — skipping")
        return

    conn = _db.get_conn()
    conn.execute("DELETE FROM strategy_log WHERE tab_id='paper'")
    conn.commit()

    with log_path.open(newline="") as f:
        rows = list(csv.DictReader(f))

    FIELDNAMES = [
        "Date", "Session", "Regime_Tier",
        "Recommended_QQQ_%", "Recommended_USO_%", "Recommended_GLD_%",
        "Current_Portfolio_Value", "QQQ_Price", "USO_Price", "GLD_Price",
        "Rationale_Summary", "Gold_Oil_Ratio", "Key_Signals",
        "Suggested_Action", "Rebalance_Note",
    ]
    for r in rows:
        clean = {k.strip(): v.strip() for k, v in r.items()}
        _db.insert_strategy_log({
            "Date": clean.get("Date", ""),
            "Session": clean.get("Session", "Close"),
            "Regime_Tier": clean.get("Regime_Tier", "2"),
            "Recommended_QQQ_%": clean.get("Recommended_QQQ_%", "0"),
            "Recommended_USO_%": clean.get("Recommended_USO_%", "0"),
            "Recommended_GLD_%": clean.get("Recommended_GLD_%", "0"),
            "Current_Portfolio_Value": clean.get("Current_Portfolio_Value", "0"),
            "QQQ_Price": clean.get("QQQ_Price", "0"),
            "USO_Price": clean.get("USO_Price", "0"),
            "GLD_Price": clean.get("GLD_Price", "0"),
            "Rationale_Summary": clean.get("Rationale_Summary", ""),
            "Gold_Oil_Ratio": clean.get("Gold_Oil_Ratio") or None,
            "Key_Signals": clean.get("Key_Signals", ""),
            "Suggested_Action": clean.get("Suggested_Action", "Hold"),
            "Rebalance_Note": clean.get("Rebalance_Note", ""),
        }, "paper", conn)
    conn.commit()
    log(f"{len(rows)} strategy log rows imported from {log_path}")


def migrate_live_quotes() -> None:
    print("→ quotes (live_quotes.json → mcp-sourced)")
    q_path = ROOT / "data" / "live_quotes.json"
    if not q_path.exists():
        log("live_quotes.json not found — skipping")
        return
    quotes = json.loads(q_path.read_text())
    conn = _db.get_conn()
    now = datetime.now(ET).isoformat()
    with conn:
        for sym, val in quotes.items():
            price = val["price"] if isinstance(val, dict) else float(val)
            chg = val.get("changePct", val.get("change_pct", 0)) if isinstance(val, dict) else 0
            conn.execute("""
                INSERT INTO quotes (symbol, price, change_pct, market_state, fetched_at, source)
                VALUES (?, ?, ?, 'LIVE_ROBINHOOD_MCP', ?, 'mcp')
                ON CONFLICT(symbol) DO UPDATE SET
                    price=excluded.price, change_pct=excluded.change_pct,
                    market_state=excluded.market_state,
                    fetched_at=excluded.fetched_at, source=excluded.source
            """, (sym, float(price), float(chg), now))
    log(f"{len(quotes)} symbols imported from live_quotes.json")


def migrate_llm_reports() -> None:
    print("→ llm_reports")
    reports_dir = ROOT / "logs" / "reports"
    if not reports_dir.exists():
        log("logs/reports/ not found — skipping")
        return

    imported = 0
    for md in sorted(reports_dir.glob("*.md")):
        name = md.stem  # e.g. "2026-06-16_close" or "2026-06-16_close_real"
        parts = name.split("_")
        if len(parts) < 2:
            continue
        date = parts[0]
        if len(date) != 10:
            continue
        session_raw = parts[1].lower()
        if session_raw not in ("open", "close"):
            continue
        tab_id = parts[2] if len(parts) >= 3 else "paper"
        text = md.read_text().strip()
        _db.upsert_llm_report(tab_id, date, session_raw, text, md.name)
        imported += 1

    log(f"{imported} LLM report files imported")


def main() -> None:
    print("Migrating flat files → data/regime.db")
    print()
    migrate_tab_config()
    migrate_portfolio()
    migrate_trades()
    migrate_equity()
    migrate_chart_snapshots()
    migrate_strategy_log()
    migrate_live_quotes()
    migrate_llm_reports()
    print()
    print("Migration complete. DB at:", _db.DB_PATH)

    # Quick summary
    conn = _db.get_conn()
    for table in ["tab_config", "quotes", "positions", "trades",
                  "equity_snapshots", "strategy_log", "chart_snapshots", "llm_reports"]:
        n = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
        print(f"  {table}: {n} rows")


if __name__ == "__main__":
    main()
