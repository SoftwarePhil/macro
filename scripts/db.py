#!/usr/bin/env python3
"""
Shared SQLite access layer for the regime dashboard.

All reads and writes go through this module. The DB file lives at
data/regime.db relative to the repo root.

Schema
------
quotes          — latest market price snapshot per symbol (one row per symbol,
                  upserted each job run). Includes fetched_at for staleness checks.
positions       — current paper portfolio holdings (one row per tab+symbol).
portfolio_meta  — per-tab scalars: cash, starting_capital, started_at, etc.
trades          — immutable append-only trade log.
equity_snapshots— post-rebalance portfolio state snapshots.
strategy_log    — one row per job run (regime decision + prices).
chart_snapshots — intraday value snapshots written by the Node server.
llm_reports     — LLM report text stored in DB instead of .md files.
tab_config      — tab configuration (replaces paper_config.json).
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "data" / "regime.db"
ET = ZoneInfo("America/New_York")

SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS tab_config (
    tab_id              TEXT PRIMARY KEY,
    label               TEXT NOT NULL,
    type                TEXT NOT NULL DEFAULT 'paper',
    enabled             INTEGER NOT NULL DEFAULT 0,
    real_trading_enabled INTEGER NOT NULL DEFAULT 0,
    starting_capital    REAL NOT NULL DEFAULT 0,
    max_step_pct        REAL NOT NULL DEFAULT 5,
    use_real_prices     INTEGER NOT NULL DEFAULT 0,
    started_at          TEXT,
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS quotes (
    symbol      TEXT PRIMARY KEY,
    price       REAL NOT NULL,
    change_pct  REAL NOT NULL DEFAULT 0,
    market_state TEXT NOT NULL DEFAULT 'UNKNOWN',
    fetched_at  TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'yahoo'
);

CREATE TABLE IF NOT EXISTS portfolio_meta (
    tab_id          TEXT PRIMARY KEY,
    account_name    TEXT,
    source          TEXT,
    mode            TEXT,
    starting_capital REAL NOT NULL DEFAULT 0,
    started_at      TEXT,
    cash            REAL NOT NULL DEFAULT 0,
    last_synced     TEXT
);

CREATE TABLE IF NOT EXISTS positions (
    tab_id      TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    shares      REAL NOT NULL DEFAULT 0,
    avg_cost    REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (tab_id, symbol)
);

CREATE TABLE IF NOT EXISTS trades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_id      TEXT NOT NULL DEFAULT 'paper',
    timestamp   TEXT NOT NULL,
    date        TEXT NOT NULL,
    session     TEXT NOT NULL,
    symbol      TEXT NOT NULL,
    side        TEXT NOT NULL,
    shares      REAL NOT NULL,
    price       REAL NOT NULL,
    notional    REAL NOT NULL,
    reason      TEXT
);
CREATE INDEX IF NOT EXISTS trades_tab_date ON trades(tab_id, date DESC);

CREATE TABLE IF NOT EXISTS equity_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_id      TEXT NOT NULL DEFAULT 'paper',
    date        TEXT NOT NULL,
    session     TEXT NOT NULL,
    total_value REAL NOT NULL,
    cash        REAL NOT NULL,
    qqq_pct     REAL NOT NULL DEFAULT 0,
    uso_pct     REAL NOT NULL DEFAULT 0,
    gld_pct     REAL NOT NULL DEFAULT 0,
    return_pct  REAL NOT NULL DEFAULT 0,
    tier        INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS equity_tab_date ON equity_snapshots(tab_id, date DESC);

CREATE TABLE IF NOT EXISTS strategy_log (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_id                  TEXT NOT NULL DEFAULT 'paper',
    date                    TEXT NOT NULL,
    session                 TEXT NOT NULL,
    regime_tier             INTEGER NOT NULL,
    recommended_qqq_pct     REAL,
    recommended_uso_pct     REAL,
    recommended_gld_pct     REAL,
    recommended_cash_pct    REAL,
    portfolio_value         REAL,
    qqq_price               REAL,
    uso_price               REAL,
    gld_price               REAL,
    rationale_summary       TEXT,
    gold_oil_ratio          REAL,
    key_signals             TEXT,
    suggested_action        TEXT,
    rebalance_note          TEXT
);
CREATE INDEX IF NOT EXISTS strategy_log_tab_date ON strategy_log(tab_id, date DESC);

CREATE TABLE IF NOT EXISTS chart_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_id      TEXT NOT NULL DEFAULT 'paper',
    ts          INTEGER NOT NULL,
    value       REAL NOT NULL,
    return_pct  REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chart_tab_ts ON chart_snapshots(tab_id, ts DESC);

CREATE TABLE IF NOT EXISTS job_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      TEXT NOT NULL,
    finished_at     TEXT NOT NULL,
    duration_s      REAL NOT NULL DEFAULT 0,
    session         TEXT NOT NULL,
    tab_id          TEXT NOT NULL DEFAULT 'paper',
    status          TEXT NOT NULL DEFAULT 'ok',   -- 'ok' | 'fail'
    tier            INTEGER,
    strength        REAL,
    action          TEXT,
    paper_enabled   INTEGER NOT NULL DEFAULT 0,
    llm_status      TEXT,                          -- 'direct' | 'skipped' | 'error'
    trade_count     INTEGER NOT NULL DEFAULT 0,
    portfolio_value REAL,
    error_message   TEXT,
    report_file     TEXT,
    llm_report_id   INTEGER REFERENCES llm_reports(id)
);
CREATE INDEX IF NOT EXISTS job_runs_started ON job_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS llm_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tab_id      TEXT NOT NULL DEFAULT 'paper',
    date        TEXT NOT NULL,
    session     TEXT NOT NULL,
    filename    TEXT,
    report_text TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def get_conn() -> sqlite3.Connection:
    """Return a module-level cached connection (one per process)."""
    if not hasattr(get_conn, "_conn") or get_conn._conn is None:
        get_conn._conn = connect()
    return get_conn._conn


# ---------------------------------------------------------------------------
# tab_config
# ---------------------------------------------------------------------------

def load_tab_config(conn: sqlite3.Connection | None = None) -> list[dict]:
    c = conn or get_conn()
    rows = c.execute("SELECT * FROM tab_config ORDER BY tab_id").fetchall()
    return [dict(r) for r in rows]


def upsert_tab_config(tab: dict, conn: sqlite3.Connection | None = None) -> None:
    c = conn or get_conn()
    c.execute("""
        INSERT INTO tab_config
            (tab_id, label, type, enabled, real_trading_enabled,
             starting_capital, max_step_pct, use_real_prices, started_at, updated_at)
        VALUES (:tab_id, :label, :type, :enabled, :real_trading_enabled,
                :starting_capital, :max_step_pct, :use_real_prices, :started_at,
                strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(tab_id) DO UPDATE SET
            label=excluded.label,
            type=excluded.type,
            enabled=excluded.enabled,
            real_trading_enabled=excluded.real_trading_enabled,
            starting_capital=excluded.starting_capital,
            max_step_pct=excluded.max_step_pct,
            use_real_prices=excluded.use_real_prices,
            started_at=excluded.started_at,
            updated_at=excluded.updated_at
    """, {
        "tab_id": tab["tab_id"],
        "label": tab.get("label", tab["tab_id"]),
        "type": tab.get("type", "paper"),
        "enabled": 1 if tab.get("enabled") else 0,
        "real_trading_enabled": 1 if tab.get("real_trading_enabled") else 0,
        "starting_capital": float(tab.get("starting_capital", 0)),
        "max_step_pct": float(tab.get("max_step_pct", 5)),
        "use_real_prices": 1 if tab.get("use_real_prices") else 0,
        "started_at": tab.get("started_at"),
    })
    c.commit()


# ---------------------------------------------------------------------------
# quotes
# ---------------------------------------------------------------------------

def upsert_quote(symbol: str, price: float, change_pct: float,
                 market_state: str, source: str = "yahoo",
                 conn: sqlite3.Connection | None = None) -> None:
    c = conn or get_conn()
    c.execute("""
        INSERT INTO quotes (symbol, price, change_pct, market_state, fetched_at, source)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol) DO UPDATE SET
            price=excluded.price,
            change_pct=excluded.change_pct,
            market_state=excluded.market_state,
            fetched_at=excluded.fetched_at,
            source=excluded.source
    """, (symbol, price, change_pct, market_state,
          datetime.now(ET).isoformat(), source))
    c.commit()


def upsert_quotes_batch(quotes: dict[str, dict],
                        conn: sqlite3.Connection | None = None) -> None:
    """Write a full quotes dict (symbol -> {price, change_pct, market_state}) atomically."""
    c = conn or get_conn()
    now = datetime.now(ET).isoformat()
    with c:
        for sym, q in quotes.items():
            c.execute("""
                INSERT INTO quotes (symbol, price, change_pct, market_state, fetched_at, source)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol) DO UPDATE SET
                    price=excluded.price,
                    change_pct=excluded.change_pct,
                    market_state=excluded.market_state,
                    fetched_at=excluded.fetched_at,
                    source=excluded.source
            """, (sym,
                  float(q.get("price", 0)),
                  float(q.get("change_pct", q.get("changePct", 0))),
                  q.get("market_state", "UNKNOWN"),
                  now,
                  "mcp" if q.get("market_state") == "LIVE_ROBINHOOD_MCP" else "yahoo"))


def load_quotes(conn: sqlite3.Connection | None = None) -> dict[str, dict]:
    c = conn or get_conn()
    rows = c.execute("SELECT * FROM quotes").fetchall()
    return {r["symbol"]: dict(r) for r in rows}


# ---------------------------------------------------------------------------
# portfolio_meta + positions
# ---------------------------------------------------------------------------

def load_portfolio(tab_id: str = "paper",
                   conn: sqlite3.Connection | None = None) -> dict:
    c = conn or get_conn()
    meta = c.execute(
        "SELECT * FROM portfolio_meta WHERE tab_id=?", (tab_id,)
    ).fetchone()
    positions = c.execute(
        "SELECT symbol, shares, avg_cost FROM positions WHERE tab_id=?", (tab_id,)
    ).fetchall()
    if meta is None:
        return {"tab_id": tab_id, "cash": 0, "holdings": [], "starting_capital": 0}
    result = dict(meta)
    result["holdings"] = [dict(r) for r in positions]
    return result


def save_portfolio(portfolio: dict, tab_id: str = "paper",
                   conn: sqlite3.Connection | None = None) -> None:
    c = conn or get_conn()
    now = datetime.now(ET).isoformat()
    with c:
        c.execute("""
            INSERT INTO portfolio_meta
                (tab_id, account_name, source, mode, starting_capital,
                 started_at, cash, last_synced)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(tab_id) DO UPDATE SET
                account_name=excluded.account_name,
                source=excluded.source,
                mode=excluded.mode,
                starting_capital=excluded.starting_capital,
                started_at=excluded.started_at,
                cash=excluded.cash,
                last_synced=excluded.last_synced
        """, (
            tab_id,
            portfolio.get("account_name", "Paper Trading (Mock)"),
            portfolio.get("source", "paper"),
            portfolio.get("mode", "paper"),
            float(portfolio.get("starting_capital", 0)),
            portfolio.get("started_at"),
            float(portfolio.get("cash", 0)),
            now,
        ))
        for h in portfolio.get("holdings", []):
            c.execute("""
                INSERT INTO positions (tab_id, symbol, shares, avg_cost)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(tab_id, symbol) DO UPDATE SET
                    shares=excluded.shares,
                    avg_cost=excluded.avg_cost
            """, (tab_id, h["symbol"],
                  float(h.get("shares", 0)),
                  float(h.get("avg_cost", 0))))


# ---------------------------------------------------------------------------
# trades
# ---------------------------------------------------------------------------

def insert_trade(trade: dict, tab_id: str = "paper",
                 conn: sqlite3.Connection | None = None) -> None:
    c = conn or get_conn()
    c.execute("""
        INSERT INTO trades
            (tab_id, timestamp, date, session, symbol, side, shares, price, notional, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        tab_id,
        trade["Timestamp"],
        trade["Date"],
        trade["Session"],
        trade["Symbol"],
        trade["Side"],
        float(trade["Shares"]),
        float(trade["Price"]),
        float(trade["Notional"]),
        trade.get("Reason", ""),
    ))
    c.commit()


def insert_trades_batch(trades: list[dict], tab_id: str = "paper",
                        conn: sqlite3.Connection | None = None) -> None:
    c = conn or get_conn()
    with c:
        for trade in trades:
            c.execute("""
                INSERT INTO trades
                    (tab_id, timestamp, date, session, symbol, side,
                     shares, price, notional, reason)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                tab_id,
                trade["Timestamp"],
                trade["Date"],
                trade["Session"],
                trade["Symbol"],
                trade["Side"],
                float(trade["Shares"]),
                float(trade["Price"]),
                float(trade["Notional"]),
                trade.get("Reason", ""),
            ))


def load_trades(tab_id: str = "paper", limit: int = 50,
                conn: sqlite3.Connection | None = None) -> list[dict]:
    c = conn or get_conn()
    rows = c.execute("""
        SELECT timestamp AS "Timestamp", date AS "Date", session AS "Session",
               symbol AS "Symbol", side AS "Side", shares AS "Shares",
               price AS "Price", notional AS "Notional", reason AS "Reason"
        FROM trades
        WHERE tab_id=?
        ORDER BY id DESC
        LIMIT ?
    """, (tab_id, limit)).fetchall()
    return [dict(r) for r in rows]


def count_trades(tab_id: str = "paper",
                 conn: sqlite3.Connection | None = None) -> int:
    c = conn or get_conn()
    return c.execute(
        "SELECT COUNT(*) FROM trades WHERE tab_id=?", (tab_id,)
    ).fetchone()[0]


# ---------------------------------------------------------------------------
# equity_snapshots
# ---------------------------------------------------------------------------

def insert_equity_snapshot(snap: dict, tab_id: str = "paper",
                            conn: sqlite3.Connection | None = None) -> None:
    c = conn or get_conn()
    c.execute("""
        INSERT INTO equity_snapshots
            (tab_id, date, session, total_value, cash,
             qqq_pct, uso_pct, gld_pct, return_pct, tier)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        tab_id,
        snap["Date"],
        snap["Session"],
        float(snap["Total_Value"]),
        float(snap["Cash"]),
        float(snap.get("QQQ_pct", 0)),
        float(snap.get("USO_pct", 0)),
        float(snap.get("GLD_pct", 0)),
        float(snap.get("Return_pct", 0)),
        int(snap.get("Tier", 1)),
    ))
    c.commit()


def load_equity_snapshots(tab_id: str = "paper", limit: int = 60,
                           conn: sqlite3.Connection | None = None) -> list[dict]:
    c = conn or get_conn()
    rows = c.execute("""
        SELECT date AS "Date", session AS "Session",
               total_value AS "Total_Value", cash AS "Cash",
               qqq_pct AS "QQQ_pct", uso_pct AS "USO_pct", gld_pct AS "GLD_pct",
               return_pct AS "Return_pct", tier AS "Tier"
        FROM equity_snapshots
        WHERE tab_id=?
        ORDER BY id DESC
        LIMIT ?
    """, (tab_id, limit)).fetchall()
    return list(reversed([dict(r) for r in rows]))


# ---------------------------------------------------------------------------
# strategy_log
# ---------------------------------------------------------------------------

def insert_strategy_log(row: dict, tab_id: str = "paper",
                         conn: sqlite3.Connection | None = None) -> None:
    c = conn or get_conn()
    c.execute("""
        INSERT INTO strategy_log
            (tab_id, date, session, regime_tier,
             recommended_qqq_pct, recommended_uso_pct, recommended_gld_pct, recommended_cash_pct,
             portfolio_value, qqq_price, uso_price, gld_price,
             rationale_summary, gold_oil_ratio, key_signals,
             suggested_action, rebalance_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        tab_id,
        row["Date"],
        row["Session"],
        int(row["Regime_Tier"]),
        float(row.get("Recommended_QQQ_%") or 0),
        float(row.get("Recommended_USO_%") or 0),
        float(row.get("Recommended_GLD_%") or 0),
        float(row.get("Recommended_CASH_%") or 0),
        float(row.get("Current_Portfolio_Value") or 0),
        float(row.get("QQQ_Price") or 0),
        float(row.get("USO_Price") or 0),
        float(row.get("GLD_Price") or 0),
        row.get("Rationale_Summary", ""),
        float(row["Gold_Oil_Ratio"]) if row.get("Gold_Oil_Ratio") else None,
        row.get("Key_Signals", ""),
        row.get("Suggested_Action", "Hold"),
        row.get("Rebalance_Note", ""),
    ))
    c.commit()


def load_strategy_log(tab_id: str = "paper",
                       conn: sqlite3.Connection | None = None) -> list[dict]:
    """Return all rows oldest-first (matches old CSV DictReader order)."""
    c = conn or get_conn()
    rows = c.execute("""
        SELECT
            date        AS "Date",
            session     AS "Session",
            regime_tier AS "Regime_Tier",
            recommended_qqq_pct  AS "Recommended_QQQ_%",
            recommended_uso_pct  AS "Recommended_USO_%",
            recommended_gld_pct  AS "Recommended_GLD_%",
            recommended_cash_pct AS "Recommended_CASH_%",
            portfolio_value      AS "Current_Portfolio_Value",
            qqq_price   AS "QQQ_Price",
            uso_price   AS "USO_Price",
            gld_price   AS "GLD_Price",
            rationale_summary    AS "Rationale_Summary",
            gold_oil_ratio       AS "Gold_Oil_Ratio",
            key_signals          AS "Key_Signals",
            suggested_action     AS "Suggested_Action",
            rebalance_note       AS "Rebalance_Note"
        FROM strategy_log
        WHERE tab_id=?
        ORDER BY id ASC
    """, (tab_id,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# chart_snapshots
# ---------------------------------------------------------------------------

CHART_SNAP_INTERVAL_MS = 5 * 60 * 1000
CHART_SNAP_MAX = 2000


def record_chart_snapshot(value: float, return_pct: float,
                           tab_id: str = "paper",
                           conn: sqlite3.Connection | None = None) -> None:
    c = conn or get_conn()
    import time
    now_ms = int(time.time() * 1000)
    last = c.execute("""
        SELECT ts FROM chart_snapshots WHERE tab_id=? ORDER BY ts DESC LIMIT 1
    """, (tab_id,)).fetchone()
    if last and (now_ms - last["ts"]) < CHART_SNAP_INTERVAL_MS:
        return
    c.execute("""
        INSERT INTO chart_snapshots (tab_id, ts, value, return_pct)
        VALUES (?, ?, ?, ?)
    """, (tab_id, now_ms, round(value, 2), round(return_pct, 2)))
    # Prune old points beyond the cap
    c.execute("""
        DELETE FROM chart_snapshots
        WHERE tab_id=? AND id NOT IN (
            SELECT id FROM chart_snapshots WHERE tab_id=? ORDER BY ts DESC LIMIT ?
        )
    """, (tab_id, tab_id, CHART_SNAP_MAX))
    c.commit()


def load_chart_snapshots(tab_id: str = "paper",
                          conn: sqlite3.Connection | None = None) -> list[dict]:
    c = conn or get_conn()
    rows = c.execute("""
        SELECT ts, value, return_pct AS returnPct
        FROM chart_snapshots
        WHERE tab_id=?
        ORDER BY ts ASC
    """, (tab_id,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# job_runs
# ---------------------------------------------------------------------------

def insert_job_run(run: dict, conn: sqlite3.Connection | None = None) -> int:
    """Insert a completed job run record. Returns the new row id."""
    c = conn or get_conn()
    cur = c.execute("""
        INSERT INTO job_runs
            (started_at, finished_at, duration_s, session, tab_id,
             status, tier, strength, action, paper_enabled,
             llm_status, trade_count, portfolio_value, error_message,
             report_file, llm_report_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (
        run["started_at"],
        run["finished_at"],
        float(run.get("duration_s", 0)),
        run["session"],
        run.get("tab_id", "paper"),
        run.get("status", "ok"),
        int(run["tier"]) if run.get("tier") is not None else None,
        float(run["strength"]) if run.get("strength") is not None else None,
        run.get("action"),
        1 if run.get("paper_enabled") else 0,
        run.get("llm_status"),
        int(run.get("trade_count", 0)),
        float(run["portfolio_value"]) if run.get("portfolio_value") is not None else None,
        run.get("error_message"),
        run.get("report_file"),
        int(run["llm_report_id"]) if run.get("llm_report_id") is not None else None,
    ))
    c.commit()
    return cur.lastrowid


def load_job_runs(limit: int = 100, conn: sqlite3.Connection | None = None) -> list[dict]:
    """Return job runs newest-first."""
    c = conn or get_conn()
    rows = c.execute("""
        SELECT id, started_at, finished_at, duration_s, session, tab_id,
               status, tier, strength, action, paper_enabled,
               llm_status, trade_count, portfolio_value, error_message, report_file, llm_report_id
        FROM job_runs
        ORDER BY id DESC
        LIMIT ?
    """, (limit,)).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# llm_reports
# ---------------------------------------------------------------------------

def insert_llm_report(tab_id: str, date: str, session: str,
                       text: str, filename: str | None = None,
                       conn: sqlite3.Connection | None = None) -> int:
    """Always insert a new LLM report row (one per job run). Returns the new row id."""
    c = conn or get_conn()
    cur = c.execute("""
        INSERT INTO llm_reports (tab_id, date, session, filename, report_text)
        VALUES (?, ?, ?, ?, ?)
    """, (tab_id, date, session.lower(), filename, text))
    c.commit()
    return cur.lastrowid


# Keep this alias so any old call sites don't break during transition
def upsert_llm_report(tab_id: str, date: str, session: str,
                       text: str, filename: str | None = None,
                       conn: sqlite3.Connection | None = None) -> int:
    return insert_llm_report(tab_id, date, session, text, filename, conn)


def load_llm_report_by_id(report_id: int,
                           conn: sqlite3.Connection | None = None) -> dict | None:
    c = conn or get_conn()
    row = c.execute("""
        SELECT id, tab_id, date, session, filename, report_text AS text, created_at
        FROM llm_reports WHERE id=?
    """, (report_id,)).fetchone()
    return dict(row) if row else None


def load_latest_llm_report(tab_id: str,
                             conn: sqlite3.Connection | None = None) -> dict | None:
    c = conn or get_conn()
    row = c.execute("""
        SELECT tab_id, date, session, filename, report_text AS text
        FROM llm_reports
        WHERE tab_id=?
        ORDER BY date DESC, CASE WHEN session='close' THEN 1 ELSE 0 END DESC
        LIMIT 1
    """, (tab_id,)).fetchone()
    return dict(row) if row else None
