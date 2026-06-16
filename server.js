import cors from "cors";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  getDb,
  loadTabConfig,
  upsertTabConfig,
  upsertQuotesBatch,
  loadQuotes,
  loadPortfolio,
  savePortfolio,
  loadTrades,
  countTrades,
  loadEquitySnapshots,
  loadStrategyLog,
  recordChartSnapshot,
  loadChartSnapshots,
  upsertLlmReport,
  loadLatestLlmReport,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3847;
const SYMBOLS = ["QQQ", "USO", "GLD", "^VIX", "CL=F", "GC=F", "BTC-USD"];
const ASSETS = ["QQQ", "USO", "GLD"];
const TIERS_PATH = path.join(__dirname, "data/tiers.json");
const REPORTS_DIR = path.join(__dirname, "logs", "reports");

// Ensure DB schema is initialised on startup
getDb();

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

// ---------------------------------------------------------------------------
// Quote fetching  (Yahoo Finance → DB)
// ---------------------------------------------------------------------------

async function fetchYahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, { headers: { "User-Agent": "regime-dashboard/0.1" } });
  if (!res.ok) throw new Error(`Quote fetch failed for ${symbol}`);
  const json = await res.json();
  const meta = json.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`No quote data for ${symbol}`);
  const price = meta.regularMarketPrice ?? meta.previousClose;
  const prev = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const change = price - prev;
  const changePct = prev ? (change / prev) * 100 : 0;
  return {
    symbol,
    price: round(price),
    changePct: round(changePct),
    change: round(change),
    currency: meta.currency ?? "USD",
    marketState: meta.marketState ?? "UNKNOWN",
    updatedAt: new Date(meta.regularMarketTime * 1000).toISOString(),
  };
}

async function fetchAndPersistQuotes() {
  const results = await Promise.allSettled(SYMBOLS.map(fetchYahooQuote));
  const fresh = {};
  for (const r of results) {
    if (r.status === "fulfilled") fresh[r.value.symbol] = r.value;
  }
  // Write Yahoo quotes to DB (won't overwrite MCP-sourced rows that are still live)
  // Strategy: overwrite only if the DB row is Yahoo-sourced OR missing.
  const db = getDb();
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO quotes (symbol, price, change_pct, market_state, fetched_at, source)
    VALUES (@symbol, @price, @change_pct, @market_state, @now, 'yahoo')
    ON CONFLICT(symbol) DO UPDATE SET
      price=excluded.price,
      change_pct=excluded.change_pct,
      market_state=excluded.market_state,
      fetched_at=excluded.fetched_at,
      source=excluded.source
    WHERE quotes.source != 'mcp'
  `);
  const tx = db.transaction((map) => {
    for (const [sym, q] of Object.entries(map)) {
      upsert.run({
        symbol: sym,
        price: q.price,
        change_pct: q.changePct,
        market_state: q.marketState,
        now,
      });
    }
  });
  tx(fresh);
  return fresh;
}

/** Build the quotes map the dashboard uses (DB rows formatted for display). */
function buildDisplayQuotes(freshYahoo) {
  // Merge: use DB row (may be MCP-sourced) over Yahoo fresh fetch
  const dbRows = loadQuotes();
  const result = { ...freshYahoo };
  for (const [sym, row] of Object.entries(dbRows)) {
    if (row.source === "mcp") {
      // MCP overrides Yahoo
      result[sym] = {
        symbol: sym,
        price: row.price,
        changePct: row.change_pct,
        change: 0,
        currency: "USD",
        marketState: "LIVE_ROBINHOOD_MCP",
        updatedAt: row.fetched_at,
      };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Portfolio computation (pure)
// ---------------------------------------------------------------------------

function computePortfolio(portfolio, quotes) {
  const holdings = portfolio.holdings || [];
  const positions = ASSETS.map((symbol) => {
    const holding = holdings.find((h) => h.symbol === symbol) ?? {
      symbol, shares: 0, avg_cost: 0,
    };
    const quote = quotes[symbol];
    const price = quote?.price ?? 0;
    const marketValue = holding.shares * price;
    const costBasis = holding.shares * (holding.avg_cost || 0);
    const pnl = marketValue - costBasis;
    const pnlPct = costBasis ? (pnl / costBasis) * 100 : 0;
    return {
      symbol,
      shares: holding.shares,
      avg_cost: holding.avg_cost,
      price,
      marketValue: round(marketValue),
      costBasis: round(costBasis),
      pnl: round(pnl),
      pnlPct: round(pnlPct),
      changePct: quote?.changePct ?? 0,
    };
  });

  const invested = positions.reduce((s, p) => s + p.marketValue, 0);
  const totalValue = invested + (portfolio.cash || 0);
  const weights = Object.fromEntries(
    ASSETS.map((sym) => {
      const pos = positions.find((p) => p.symbol === sym);
      const pct = totalValue ? ((pos?.marketValue ?? 0) / totalValue) * 100 : 0;
      return [sym, round(pct, 1)];
    }),
  );
  return { positions, invested: round(invested), totalValue: round(totalValue), weights };
}

function computeDrift(weights, targets) {
  // Include CASH in drift if the tier specifies a cash target
  const symbols = [...ASSETS, ...(targets.CASH != null ? ["CASH"] : [])];
  return symbols.map((symbol) => {
    const actual = symbol === "CASH"
      ? Math.max(0, round(100 - ASSETS.reduce((s, a) => s + (weights[a] ?? 0), 0), 1))
      : (weights[symbol] ?? 0);
    const target = targets[symbol] ?? 0;
    const drift = round(actual - target, 1);
    return { symbol, actual, target, drift, absDrift: Math.abs(drift) };
  });
}

// ---------------------------------------------------------------------------
// Chart series builder (from DB equity_snapshots + chart_snapshots)
// ---------------------------------------------------------------------------

const SESSION_ORDER = { open: 0, close: 1 };
function sessionRank(s) { return SESSION_ORDER[String(s || "").toLowerCase()] ?? 0; }

function chartPointTs(date, session) {
  const s = String(session || "").toLowerCase();
  if (s === "start") return new Date(`${date}T00:00:00`).getTime();
  if (s === "open")  return new Date(`${date}T09:30:00-04:00`).getTime();
  if (s === "close") return new Date(`${date}T16:00:00-04:00`).getTime();
  return new Date(`${date}T12:00:00-04:00`).getTime();
}

function buildChartSeries(equityRows, startedAt, startingCapital, liveValue, returnPct, intradaySnaps) {
  const startPoint = startedAt && startingCapital > 0
    ? { date: startedAt, session: "Start", value: startingCapital, returnPct: 0, ts: chartPointTs(startedAt, "Start") }
    : null;

  const middle = [];

  for (const row of equityRows) {
    middle.push({
      date: row["Date"],
      session: row["Session"],
      value: Number(row["Total_Value"]),
      returnPct: Number(row["Return_pct"]),
      ts: chartPointTs(row["Date"], row["Session"]),
    });
  }

  for (const snap of intradaySnaps) {
    const d = new Date(snap.ts);
    middle.push({
      date: d.toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
      session: "Intraday",
      time: d.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      }),
      value: Number(snap.value),
      returnPct: Number(snap.returnPct),
      ts: snap.ts,
    });
  }

  middle.sort((a, b) => a.ts - b.ts);

  // Deduplicate near-identical adjacent points
  const deduped = [];
  for (const p of middle) {
    const prev = deduped[deduped.length - 1];
    if (prev && Math.abs(prev.ts - p.ts) < 60_000 && Math.abs(prev.value - p.value) < 0.01) {
      deduped[deduped.length - 1] = p;
      continue;
    }
    deduped.push(p);
  }

  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const livePoint = { date: todayEt, session: "Live", value: liveValue, returnPct, ts: Date.now() };

  return [...(startPoint ? [startPoint] : []), ...deduped, livePoint];
}

// ---------------------------------------------------------------------------
// Strategy log helpers
// ---------------------------------------------------------------------------

function getLatestLogEntry(rows) {
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => {
    if (a.Date !== b.Date) return a.Date < b.Date ? -1 : 1;
    return sessionRank(a.Session) - sessionRank(b.Session);
  }).at(-1);
}

function getTodaySessions(rows, today) {
  const dayRows = rows.filter((r) => r.Date === today);
  return {
    open:  dayRows.find((r) => String(r.Session).toLowerCase() === "open")  ?? null,
    close: dayRows.find((r) => String(r.Session).toLowerCase() === "close") ?? null,
  };
}

// ---------------------------------------------------------------------------
// LLM report loader (DB first, fallback to .md files on disk)
// ---------------------------------------------------------------------------

function loadTabLlmReport(tabId, logDate, logSession) {
  if (!logDate || !logSession) return null;
  const sess = String(logSession).toLowerCase().trim();

  // Try DB first
  const dbReport = loadLatestLlmReport(tabId);
  if (dbReport && dbReport.date === logDate) {
    return { filename: dbReport.filename, text: dbReport.text, date: dbReport.date, session: dbReport.session };
  }

  // Fallback: .md files on disk (for data from before SQLite migration)
  const candidates = [
    path.join(REPORTS_DIR, `${logDate}_${sess}.md`),
    path.join(REPORTS_DIR, `${logDate}_${sess}_${tabId}.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        return {
          filename: path.basename(p),
          text: fs.readFileSync(p, "utf8").trim(),
          date: logDate,
          session: logSession,
        };
      } catch { /* ignore */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main dashboard payload builder
// ---------------------------------------------------------------------------

async function buildDashboardPayload() {
  const [freshYahoo] = await Promise.all([fetchAndPersistQuotes()]);
  const quotes = buildDisplayQuotes(freshYahoo);
  const tiers = readJson(TIERS_PATH);
  const tabList = loadTabConfig();

  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  const tabData = {};

  for (const tab of tabList) {
    const tabId = tab.tab_id;

    // Portfolio
    const tabPortfolioRaw = loadPortfolio(tabId);
    const tabPortfolioView = computePortfolio(tabPortfolioRaw, quotes);

    // Trades, equity, chart
    const tabTrades = loadTrades(tabId, 20);
    const tabEquity = loadEquitySnapshots(tabId, 30);
    const intradaySnaps = loadChartSnapshots(tabId);

    // Strategy log
    const tabLogRows = loadStrategyLog(tabId);
    const tabLatest = getLatestLogEntry(tabLogRows);
    const tabTodaySessions = getTodaySessions(tabLogRows, todayEt);

    // Regime
    const tabRegimeTier = tabLatest ? Number(tabLatest["Regime_Tier"]) : 2;
    const tabTier = tiers[String(tabRegimeTier)] || tiers["2"];
    const tabTargets = tabTier.targets;
    const tabRecommended = tabLatest ? {
      QQQ:  Number(tabLatest["Recommended_QQQ_%"]  ?? tabTargets.QQQ),
      USO:  Number(tabLatest["Recommended_USO_%"]  ?? tabTargets.USO),
      GLD:  Number(tabLatest["Recommended_GLD_%"]  ?? tabTargets.GLD),
      CASH: Number(tabLatest["Recommended_CASH_%"] ?? tabTargets.CASH ?? 0),
    } : tabTargets;

    const tabDriftVsRecommended = computeDrift(tabPortfolioView.weights, tabRecommended);
    const tabDriftVsTier = computeDrift(tabPortfolioView.weights, tabTargets);

    const tabStartingCapital = tabPortfolioRaw.starting_capital || tab.starting_capital || 0;
    const tabReturnPct = tabStartingCapital > 0
      ? round(((tabPortfolioView.totalValue / tabStartingCapital - 1) * 100))
      : 0;
    const tabReturnDollar = round(tabPortfolioView.totalValue - tabStartingCapital);

    // Chart
    const tabChartSeries = buildChartSeries(
      tabEquity,
      tabPortfolioRaw.started_at || null,
      tabStartingCapital,
      tabPortfolioView.totalValue,
      tabReturnPct,
      intradaySnaps,
    );

    // Record intraday snapshot (throttled to 5 min in DB)
    if (tab.enabled) {
      recordChartSnapshot(tabPortfolioView.totalValue, tabReturnPct, tabId);
    }

    // LLM report
    const tabLLMReport = loadTabLlmReport(tabId, tabLatest?.Date, tabLatest?.Session);

    tabData[tabId] = {
      enabled: !!tab.enabled,
      realTradingEnabled: !!tab.real_trading_enabled,
      startingCapital: tabStartingCapital,
      startedAt: tabPortfolioRaw.started_at || null,
      returnPct: tabReturnPct,
      returnDollar: tabReturnDollar,
      tradeCount: countTrades(tabId),
      trades: tabTrades,
      equity: tabEquity,
      chartSeries: tabChartSeries,
      portfolio: {
        ...tabPortfolioView,
        cash: tabPortfolioRaw.cash || 0,
        accountName: tabPortfolioRaw.account_name || (tab.type === "robinhood" ? "Real Robinhood" : "Paper"),
        source: tabPortfolioRaw.source || tab.type,
        lastSynced: tabPortfolioRaw.last_synced || null,
      },
      drift: {
        vsRecommended: tabDriftVsRecommended,
        vsTier: tabDriftVsTier,
        maxDrift: Math.max(...tabDriftVsRecommended.map((d) => d.absDrift), 0),
        rebalanceNeeded: tabDriftVsRecommended.some((d) => d.absDrift > 5),
      },
      regime: {
        tier: tabRegimeTier,
        name: tabTier.name,
        description: tabTier.description,
        targets: tabTargets,
        recommended: tabRecommended,
        rationale: tabLatest?.["Rationale_Summary"] ?? "",
        keySignals: tabLatest?.["Key_Signals"] ?? "",
        logDate: tabLatest?.["Date"] ?? null,
        session: tabLatest?.["Session"] ?? null,
        suggestedAction: tabLatest?.["Suggested_Action"] ?? "Hold",
        rebalanceNote: tabLatest?.["Rebalance_Note"] ?? "",
        todayOpen: tabTodaySessions.open,
        todayClose: tabTodaySessions.close,
        llmReport: tabLLMReport,
      },
      log: tabLogRows.slice().reverse(),
    };
  }

  // Global regime (from paper tab)
  const globalRegime = tabData.paper ? tabData.paper.regime : {
    tier: 2, name: "Balanced / Neutral",
    description: "Mixed data, moderate volatility, contained geopolitics",
    targets: { QQQ: 40, USO: 25, GLD: 25, CASH: 10 },
    recommended: { QQQ: 40, USO: 25, GLD: 25, CASH: 10 },
    rationale: "", keySignals: "", logDate: null, session: null,
    suggestedAction: "Hold", rebalanceNote: "",
    todayOpen: null, todayClose: null,
  };

  const gld = quotes["GLD"]?.price ?? 0;
  const uso = quotes["USO"]?.price ?? 0;
  const wti = quotes["CL=F"]?.price ?? 0;
  const goldSpot = quotes["GC=F"]?.price ?? 0;

  // Format tabs array for frontend (matches old paper_config shape)
  const tabs = tabList.map((t) => ({
    id: t.tab_id,
    label: t.label,
    type: t.type,
    enabled: !!t.enabled,
    real_trading_enabled: !!t.real_trading_enabled,
    starting_capital: t.starting_capital,
    max_step_pct: t.max_step_pct,
    use_real_prices: !!t.use_real_prices,
  }));

  return {
    generatedAt: new Date().toISOString(),
    tabData,
    tabs,
    regime: globalRegime,
    schedule: {
      timezone: "America/New_York",
      jobs: [
        { session: "Open", time: "09:30", purpose: "Pre-open rebalance check" },
        { session: "Close", time: "16:00", purpose: "End-of-day drift check" },
      ],
    },
    market: {
      quotes,
      goldOilRatioEtf: gld && uso ? round(gld / uso) : null,
      goldOilRatioSpot: goldSpot && wti ? round(goldSpot / wti) : null,
    },
    tiers,
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  const db = getDb();
  const tabCount = db.prepare("SELECT COUNT(*) AS n FROM tab_config").get().n;
  res.json({ ok: true, db: "sqlite", tabs: tabCount });
});

app.get("/api/dashboard", async (_req, res) => {
  try {
    res.json(await buildDashboardPayload());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/log", (req, res) => {
  const tabId = req.query.tab || "paper";
  res.json(loadStrategyLog(tabId).slice().reverse());
});

app.get("/api/portfolio", (req, res) => {
  const tabId = req.query.tab || "paper";
  res.json(loadPortfolio(tabId));
});

app.post("/api/portfolio", (req, res) => {
  // Only allowed when paper is NOT enabled (manual holdings mode)
  const tabs = loadTabConfig();
  const paperTab = tabs.find((t) => t.tab_id === "paper");
  if (paperTab?.enabled) {
    return res.status(403).json({ error: "Paper mode active — holdings are managed automatically" });
  }
  const body = req.body;
  if (!body?.holdings || !Array.isArray(body.holdings)) {
    return res.status(400).json({ error: "holdings array required" });
  }
  const current = loadPortfolio("paper");
  savePortfolio({ ...current, ...body }, "paper");
  res.json(loadPortfolio("paper"));
});

/** MCP live-price push — writes directly to quotes table as mcp-sourced rows. */
app.post("/api/live-prices", (req, res) => {
  const prices = req.body;
  if (!prices || typeof prices !== "object") {
    return res.status(400).json({ error: "prices object required, e.g. { \"QQQ\": { \"price\": 512.34, \"changePct\": 0.8 } }" });
  }
  const db = getDb();
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO quotes (symbol, price, change_pct, market_state, fetched_at, source)
    VALUES (@symbol, @price, @change_pct, @market_state, @now, 'mcp')
    ON CONFLICT(symbol) DO UPDATE SET
        price=excluded.price, change_pct=excluded.change_pct,
        market_state=excluded.market_state,
        fetched_at=excluded.fetched_at, source=excluded.source
  `);
  const tx = db.transaction(() => {
    for (const [sym, val] of Object.entries(prices)) {
      const price = typeof val === "number" ? val : (val.price ?? val);
      const changePct = typeof val === "number" ? 0 : (val.changePct ?? val.change_pct ?? 0);
      insert.run({ symbol: sym, price, change_pct: changePct, market_state: "LIVE_ROBINHOOD_MCP", now });
    }
  });
  tx();
  res.json({ ok: true, updated: Object.keys(prices), source: "mcp", storedIn: "sqlite:quotes" });
});

if (process.env.NODE_ENV === "production") {
  const dist = path.join(__dirname, "dist");
  app.use(express.static(dist));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(dist, "index.html"));
  });
}

app.listen(PORT, () => {
  console.log(`Regime dashboard API http://localhost:${PORT}`);
});
