/**
 * Shared SQLite access layer for the regime dashboard (Node / server.js side).
 *
 * Uses better-sqlite3 (synchronous API — safe for Express since all DB
 * operations are sub-millisecond local reads on WAL mode).
 *
 * The DB file lives at  data/regime.db  relative to the repo root.
 * Schema is identical to scripts/db.py — both processes share the same file.
 */

import Database from "better-sqlite3";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "data", "regime.db");

const SCHEMA = `
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
    status          TEXT NOT NULL DEFAULT 'ok',
    tier            INTEGER,
    strength        REAL,
    action          TEXT,
    paper_enabled   INTEGER NOT NULL DEFAULT 0,
    llm_status      TEXT,
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
`;

let _db = null;

export function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec(SCHEMA);
  }
  return _db;
}

// ---------------------------------------------------------------------------
// tab_config
// ---------------------------------------------------------------------------

export function loadTabConfig() {
  return getDb().prepare("SELECT * FROM tab_config ORDER BY tab_id").all();
}

export function upsertTabConfig(tab) {
  getDb().prepare(`
    INSERT INTO tab_config
        (tab_id, label, type, enabled, real_trading_enabled,
         starting_capital, max_step_pct, use_real_prices, started_at, updated_at)
    VALUES (@tab_id, @label, @type, @enabled, @real_trading_enabled,
            @starting_capital, @max_step_pct, @use_real_prices, @started_at,
            strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(tab_id) DO UPDATE SET
        label=excluded.label, type=excluded.type,
        enabled=excluded.enabled,
        real_trading_enabled=excluded.real_trading_enabled,
        starting_capital=excluded.starting_capital,
        max_step_pct=excluded.max_step_pct,
        use_real_prices=excluded.use_real_prices,
        started_at=excluded.started_at,
        updated_at=excluded.updated_at
  `).run({
    tab_id: tab.id || tab.tab_id,
    label: tab.label || tab.id || tab.tab_id,
    type: tab.type || "paper",
    enabled: tab.enabled ? 1 : 0,
    real_trading_enabled: tab.real_trading_enabled ? 1 : 0,
    starting_capital: Number(tab.starting_capital || 0),
    max_step_pct: Number(tab.max_step_pct || 5),
    use_real_prices: tab.use_real_prices ? 1 : 0,
    started_at: tab.started_at || null,
  });
}

// ---------------------------------------------------------------------------
// quotes  (Node server writes Yahoo fetches here; Python reads these too)
// ---------------------------------------------------------------------------

const QUOTE_STALENESS_MS = 10 * 60 * 1000; // 10 minutes

export function upsertQuotesBatch(quotesMap) {
  const now = new Date().toISOString();
  const insert = getDb().prepare(`
    INSERT INTO quotes (symbol, price, change_pct, market_state, fetched_at, source)
    VALUES (@symbol, @price, @change_pct, @market_state, @fetched_at, @source)
    ON CONFLICT(symbol) DO UPDATE SET
        price=excluded.price, change_pct=excluded.change_pct,
        market_state=excluded.market_state,
        fetched_at=excluded.fetched_at, source=excluded.source
  `);
  const tx = getDb().transaction((map) => {
    for (const [sym, q] of Object.entries(map)) {
      insert.run({
        symbol: sym,
        price: Number(q.price || 0),
        change_pct: Number(q.changePct ?? q.change_pct ?? 0),
        market_state: q.marketState || q.market_state || "UNKNOWN",
        fetched_at: now,
        source: (q.marketState || q.market_state || "").includes("MCP") ? "mcp" : "yahoo",
      });
    }
  });
  tx(quotesMap);
}

export function loadQuotes() {
  const rows = getDb().prepare("SELECT * FROM quotes").all();
  const map = {};
  for (const r of rows) map[r.symbol] = r;
  return map;
}

/** Returns true if all core symbols have fresh quotes (within staleness window). */
export function quotesAreFresh(symbols = ["QQQ", "USO", "GLD"]) {
  const now = Date.now();
  for (const sym of symbols) {
    const row = getDb().prepare(
      "SELECT fetched_at FROM quotes WHERE symbol=?"
    ).get(sym);
    if (!row) return false;
    const age = now - new Date(row.fetched_at).getTime();
    if (age > QUOTE_STALENESS_MS) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// portfolio_meta + positions
// ---------------------------------------------------------------------------

export function loadPortfolio(tabId = "paper") {
  const db = getDb();
  const meta = db.prepare("SELECT * FROM portfolio_meta WHERE tab_id=?").get(tabId);
  const positions = db.prepare(
    "SELECT symbol, shares, avg_cost FROM positions WHERE tab_id=?"
  ).all(tabId);
  if (!meta) return { tab_id: tabId, cash: 0, holdings: [], starting_capital: 0 };
  return { ...meta, holdings: positions };
}

export function savePortfolio(portfolio, tabId = "paper") {
  const db = getDb();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO portfolio_meta
          (tab_id, account_name, source, mode, starting_capital,
           started_at, cash, last_synced)
      VALUES (@tab_id, @account_name, @source, @mode, @starting_capital,
              @started_at, @cash, @last_synced)
      ON CONFLICT(tab_id) DO UPDATE SET
          account_name=excluded.account_name, source=excluded.source,
          mode=excluded.mode, starting_capital=excluded.starting_capital,
          started_at=excluded.started_at, cash=excluded.cash,
          last_synced=excluded.last_synced
    `).run({
      tab_id: tabId,
      account_name: portfolio.account_name || "Paper Trading (Mock)",
      source: portfolio.source || "paper",
      mode: portfolio.mode || "paper",
      starting_capital: Number(portfolio.starting_capital || 0),
      started_at: portfolio.started_at || null,
      cash: Number(portfolio.cash || 0),
      last_synced: now,
    });
    for (const h of (portfolio.holdings || [])) {
      db.prepare(`
        INSERT INTO positions (tab_id, symbol, shares, avg_cost)
        VALUES (@tab_id, @symbol, @shares, @avg_cost)
        ON CONFLICT(tab_id, symbol) DO UPDATE SET
            shares=excluded.shares, avg_cost=excluded.avg_cost
      `).run({
        tab_id: tabId,
        symbol: h.symbol,
        shares: Number(h.shares || 0),
        avg_cost: Number(h.avg_cost || 0),
      });
    }
  });
  tx();
}

// ---------------------------------------------------------------------------
// trades
// ---------------------------------------------------------------------------

export function loadTrades(tabId = "paper", limit = 50) {
  return getDb().prepare(`
    SELECT timestamp AS "Timestamp", date AS "Date", session AS "Session",
           symbol AS "Symbol", side AS "Side", shares AS "Shares",
           price AS "Price", notional AS "Notional", reason AS "Reason"
    FROM trades WHERE tab_id=? ORDER BY id DESC LIMIT ?
  `).all(tabId, limit);
}

export function countTrades(tabId = "paper") {
  return getDb().prepare(
    "SELECT COUNT(*) AS n FROM trades WHERE tab_id=?"
  ).get(tabId).n;
}

// ---------------------------------------------------------------------------
// equity_snapshots
// ---------------------------------------------------------------------------

export function loadEquitySnapshots(tabId = "paper", limit = 60) {
  const rows = getDb().prepare(`
    SELECT date AS "Date", session AS "Session",
           total_value AS "Total_Value", cash AS "Cash",
           qqq_pct AS "QQQ_pct", uso_pct AS "USO_pct", gld_pct AS "GLD_pct",
           return_pct AS "Return_pct", tier AS "Tier"
    FROM equity_snapshots
    WHERE tab_id=? ORDER BY id DESC LIMIT ?
  `).all(tabId, limit);
  return rows.slice().reverse();
}

// ---------------------------------------------------------------------------
// strategy_log
// ---------------------------------------------------------------------------

export function loadStrategyLog(tabId = "paper") {
  return getDb().prepare(`
    SELECT
        date AS "Date", session AS "Session",
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
    FROM strategy_log WHERE tab_id=? ORDER BY id ASC
  `).all(tabId);
}

// ---------------------------------------------------------------------------
// chart_snapshots
// ---------------------------------------------------------------------------

const CHART_SNAP_INTERVAL_MS = 5 * 60 * 1000;
const CHART_SNAP_MAX = 2000;

export function recordChartSnapshot(value, returnPct, tabId = "paper") {
  const db = getDb();
  const nowMs = Date.now();
  const last = db.prepare(
    "SELECT ts FROM chart_snapshots WHERE tab_id=? ORDER BY ts DESC LIMIT 1"
  ).get(tabId);
  if (last && (nowMs - last.ts) < CHART_SNAP_INTERVAL_MS) return;
  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO chart_snapshots (tab_id, ts, value, return_pct) VALUES (?,?,?,?)"
    ).run(tabId, nowMs, Math.round(value * 100) / 100, Math.round(returnPct * 100) / 100);
    // Prune beyond cap
    db.prepare(`
      DELETE FROM chart_snapshots
      WHERE tab_id=? AND id NOT IN (
          SELECT id FROM chart_snapshots WHERE tab_id=? ORDER BY ts DESC LIMIT ?
      )
    `).run(tabId, tabId, CHART_SNAP_MAX);
  });
  tx();
}

export function loadChartSnapshots(tabId = "paper") {
  return getDb().prepare(`
    SELECT ts, value, return_pct AS returnPct
    FROM chart_snapshots WHERE tab_id=? ORDER BY ts ASC
  `).all(tabId);
}

// ---------------------------------------------------------------------------
// job_runs
// ---------------------------------------------------------------------------

export function insertJobRun(run) {
  const stmt = getDb().prepare(`
    INSERT INTO job_runs
        (started_at, finished_at, duration_s, session, tab_id,
         status, tier, strength, action, paper_enabled,
         llm_status, trade_count, portfolio_value, error_message, report_file)
    VALUES (@started_at, @finished_at, @duration_s, @session, @tab_id,
            @status, @tier, @strength, @action, @paper_enabled,
            @llm_status, @trade_count, @portfolio_value, @error_message, @report_file)
  `);
  const result = stmt.run({
    started_at:      run.started_at,
    finished_at:     run.finished_at,
    duration_s:      Number(run.duration_s ?? 0),
    session:         run.session,
    tab_id:          run.tab_id ?? "paper",
    status:          run.status ?? "ok",
    tier:            run.tier ?? null,
    strength:        run.strength ?? null,
    action:          run.action ?? null,
    paper_enabled:   run.paper_enabled ? 1 : 0,
    llm_status:      run.llm_status ?? null,
    trade_count:     Number(run.trade_count ?? 0),
    portfolio_value: run.portfolio_value ?? null,
    error_message:   run.error_message ?? null,
    report_file:     run.report_file ?? null,
  });
  return result.lastInsertRowid;
}

export function loadJobRuns(limit = 100) {
  return getDb().prepare(`
    SELECT id, started_at, finished_at, duration_s, session, tab_id,
           status, tier, strength, action, paper_enabled,
           llm_status, trade_count, portfolio_value, error_message, report_file
    FROM job_runs ORDER BY id DESC LIMIT ?
  `).all(limit);
}

// ---------------------------------------------------------------------------
// llm_reports
// ---------------------------------------------------------------------------

export function upsertLlmReport(tabId, date, session, text, filename = null) {
  getDb().prepare(`
    INSERT INTO llm_reports (tab_id, date, session, filename, report_text)
    VALUES (@tab_id, @date, @session, @filename, @text)
    ON CONFLICT(tab_id, date, session) DO UPDATE SET
        filename=excluded.filename,
        report_text=excluded.report_text,
        created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run({ tab_id: tabId, date, session: session.toLowerCase(), filename, text });
}

export function loadLatestLlmReport(tabId) {
  const row = getDb().prepare(`
    SELECT tab_id, date, session, filename, report_text AS text
    FROM llm_reports WHERE tab_id=?
    ORDER BY date DESC, CASE WHEN session='close' THEN 1 ELSE 0 END DESC
    LIMIT 1
  `).get(tabId);
  return row || null;
}
