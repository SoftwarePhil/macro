import cors from "cors";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3847;
const SYMBOLS = ["QQQ", "USO", "GLD", "^VIX", "CL=F", "GC=F", "BTC-USD"];
const ASSETS = ["QQQ", "USO", "GLD"];

const PATHS = {
  portfolio: path.join(__dirname, "data/portfolio.json"),
  paperConfig: path.join(__dirname, "data/paper_config.json"),
  paperPortfolio: path.join(__dirname, "data/paper_portfolio.json"),
  paperTrades: path.join(__dirname, "data/paper_trades.csv"),
  paperEquity: path.join(__dirname, "data/paper_equity.csv"),
  paperChart: path.join(__dirname, "data/paper_chart.json"),
  tiers: path.join(__dirname, "data/tiers.json"),
  strategyLog: path.join(__dirname, "..", "strategy_log.csv"),
};

const REPORTS_DIR = path.join(__dirname, "logs", "reports");

function getPaperTab() {
  const data = readJson(PATHS.paperConfig, []);
  if (Array.isArray(data)) {
    return data.find(t => t.id === "paper" || t.type === "paper") || {};
  }
  return data; // old object fallback
}

function paperEnabled() {
  const cfg = getPaperTab();
  return Boolean(cfg.enabled);
}

function useRealPrices() {
  const cfg = getPaperTab();
  return Boolean(cfg.use_real_prices);
}

function loadLiveQuotes() {
  if (!useRealPrices()) return {};
  return readJson(path.join(__dirname, "data/live_quotes.json"), {});
}

function activePortfolioRaw() {
  if (paperEnabled() && fs.existsSync(PATHS.paperPortfolio)) {
    const p = readJson(PATHS.paperPortfolio);
    return p && p.holdings ? p : { cash: 0, holdings: [] };
  }
  const p = readJson(PATHS.portfolio);
  return p && p.holdings ? p : { cash: 0, holdings: [] };
}

function readJson(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function parseCsv(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? "";
    });
    return row;
  });
}

function parseCsvLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: { "User-Agent": "regime-dashboard/0.1" },
  });
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
    price: round(price, symbol === "^VIX" ? 2 : 2),
    change: round(change, 2),
    changePct: round(changePct, 2),
    currency: meta.currency ?? "USD",
    marketState: meta.marketState ?? "UNKNOWN",
    updatedAt: new Date(meta.regularMarketTime * 1000).toISOString(),
  };
}

function round(n, digits = 2) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

async function fetchQuotes() {
  const results = await Promise.allSettled(SYMBOLS.map(fetchQuote));
  const quotes = {};
  for (const r of results) {
    if (r.status === "fulfilled") quotes[r.value.symbol] = r.value;
  }
  return quotes;
}

const SESSION_ORDER = { open: 0, close: 1 };

function sessionRank(session) {
  return SESSION_ORDER[String(session || "").toLowerCase()] ?? 0;
}

function sortLogRows(rows) {
  return rows.slice().sort((a, b) => {
    if (a.Date !== b.Date) return a.Date < b.Date ? -1 : 1;
    return sessionRank(a.Session) - sessionRank(b.Session);
  });
}

function getLatestLogEntry(rows) {
  const sorted = sortLogRows(rows);
  if (!sorted.length) return null;
  return sorted[sorted.length - 1];
}

function getTodaySessions(rows, today) {
  const dayRows = rows.filter((r) => r.Date === today);
  return {
    open: dayRows.find((r) => String(r.Session).toLowerCase() === "open") ?? null,
    close: dayRows.find((r) => String(r.Session).toLowerCase() === "close") ?? null,
  };
}

function computePortfolio(portfolio, quotes) {
  const holdings = portfolio.holdings || [];
  const positions = ASSETS.map((symbol) => {
    const holding = holdings.find((h) => h.symbol === symbol) ?? {
      symbol,
      shares: 0,
      avg_cost: 0,
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
      marketValue: round(marketValue, 2),
      costBasis: round(costBasis, 2),
      pnl: round(pnl, 2),
      pnlPct: round(pnlPct, 2),
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

  return { positions, invested: round(invested, 2), totalValue: round(totalValue, 2), weights };
}

const CHART_SNAP_INTERVAL_MS = 5 * 60 * 1000;
const CHART_SNAP_MAX = 2000;

function chartPointTs(date, session) {
  const s = String(session || "").toLowerCase();
  if (s === "start") return new Date(`${date}T00:00:00`).getTime();
  if (s === "open") return new Date(`${date}T09:30:00-04:00`).getTime();
  if (s === "close") return new Date(`${date}T16:00:00-04:00`).getTime();
  return new Date(`${date}T12:00:00-04:00`).getTime();
}

function readChartSnapshots() {
  return readJson(PATHS.paperChart, { points: [] }).points ?? [];
}

function recordChartSnapshot(value, returnPct) {
  if (!paperEnabled()) return;
  const data = readJson(PATHS.paperChart, { points: [] });
  const points = data.points ?? [];
  const now = Date.now();
  const last = points[points.length - 1];
  if (last && now - last.ts < CHART_SNAP_INTERVAL_MS) return;
  points.push({
    ts: now,
    value: round(value, 2),
    returnPct: round(returnPct, 2),
  });
  if (points.length > CHART_SNAP_MAX) {
    data.points = points.slice(-CHART_SNAP_MAX);
  } else {
    data.points = points;
  }
  writeJson(PATHS.paperChart, data);
}

function buildChartSeries(paperEquity, startedAt, startingCapital, liveValue, returnPct) {
  const startPoint =
    startedAt && startingCapital > 0
      ? {
          date: startedAt,
          session: "Start",
          value: startingCapital,
          returnPct: 0,
          ts: chartPointTs(startedAt, "Start"),
        }
      : null;

  const middle = [];

  for (const row of paperEquity) {
    middle.push({
      date: row.Date,
      session: row.Session,
      value: Number(row.Total_Value),
      returnPct: Number(row.Return_pct),
      ts: chartPointTs(row.Date, row.Session),
    });
  }

  for (const snap of readChartSnapshots()) {
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
  const livePoint = {
    date: todayEt,
    session: "Live",
    value: liveValue,
    returnPct,
    ts: Date.now(),
  };

  return [...(startPoint ? [startPoint] : []), ...deduped, livePoint];
}

function computeDrift(weights, targets) {
  return ASSETS.map((symbol) => {
    const actual = weights[symbol] ?? 0;
    const target = targets[symbol] ?? 0;
    const drift = round(actual - target, 1);
    return { symbol, actual, target, drift, absDrift: Math.abs(drift) };
  });
}

function loadTabLLMReport(tabId, logDate, logSession) {
  if (!logDate || !logSession) return null;
  const sess = String(logSession).toLowerCase().trim();
  const candidates = [
    path.join(REPORTS_DIR, `${logDate}_${sess}.md`),
    path.join(REPORTS_DIR, `${logDate}_${sess}_${tabId}.md`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      try {
        const text = fs.readFileSync(p, "utf8").trim();
        return {
          filename: path.basename(p),
          text,
          date: logDate,
          session: logSession,
        };
      } catch (e) {
        // ignore unreadable
      }
    }
  }
  return null;
}

function buildDashboardPayload() {
  return Promise.all([
    fetchQuotes(),
    Promise.resolve(activePortfolioRaw()),
    Promise.resolve(readJson(PATHS.tiers)),
    Promise.resolve(readJson(PATHS.paperConfig, [])),
    Promise.resolve(
      fs.existsSync(PATHS.strategyLog)
        ? parseCsv(fs.readFileSync(PATHS.strategyLog, "utf8"))
        : [],
    ),
  ]).then(([liveQuotes, portfolio, tiers, tabs, logRows]) => {
    const tabList = Array.isArray(tabs) ? tabs : [];
    const paperTab = tabList.find(t => t.id === "paper" || t.type === "paper") || {};
    const strategyLogEnabled = true;  // global, as configured separately
    const effectiveLogRows = strategyLogEnabled ? logRows : [];
    const latest = getLatestLogEntry(effectiveLogRows);
    const todayEt = new Date().toLocaleDateString("en-CA", {
      timeZone: "America/New_York",
    });
    const todaySessions = getTodaySessions(effectiveLogRows, todayEt);
    const regimeTier = latest ? Number(latest.Regime_Tier) : 2;
    const tier = tiers[String(regimeTier)] ?? tiers["2"];
    const targets = tier.targets;
    const recommended = latest
      ? {
          QQQ: Number(latest["Recommended_QQQ_%"]),
          USO: Number(latest["Recommended_USO_%"]),
          GLD: Number(latest["Recommended_GLD_%"]),
        }
      : targets;

    let quotes = liveQuotes;
    if (useRealPrices()) {
      const mcpPrices = loadLiveQuotes();
      quotes = { ...liveQuotes };
      for (const [sym, val] of Object.entries(mcpPrices)) {
        if (quotes[sym]) {
          const p = typeof val === "number" ? val : (val.price ?? val);
          const cp = typeof val === "number" ? 0 : (val.changePct ?? val.change_pct ?? 0);
          quotes[sym] = {
            ...quotes[sym],
            price: p,
            changePct: cp,
            marketState: "LIVE_ROBINHOOD_MCP"
          };
        }
      }
    }

    const portfolioView = computePortfolio(portfolio, quotes);
    const driftVsRecommended = computeDrift(portfolioView.weights, recommended);
    const driftVsTier = computeDrift(portfolioView.weights, targets);

    const gld = liveQuotes.GLD?.price ?? 0;
    const uso = liveQuotes.USO?.price ?? 0;
    const wti = liveQuotes["CL=F"]?.price ?? 0;
    const goldSpot = liveQuotes["GC=F"]?.price ?? 0;

    const startingCapital = Number(
      portfolio.starting_capital || paperTab.starting_capital || 0,
    );
    const returnPct =
      startingCapital > 0
        ? round(((portfolioView.totalValue / startingCapital - 1) * 100), 2)
        : 0;
    const returnDollar = round(portfolioView.totalValue - startingCapital, 2);

    if (paperEnabled()) {
      recordChartSnapshot(portfolioView.totalValue, returnPct);
    }

    const allPaperTrades = fs.existsSync(PATHS.paperTrades)
      ? parseCsv(fs.readFileSync(PATHS.paperTrades, "utf8"))
      : [];
    const paperTrades = allPaperTrades.slice().reverse().slice(0, 50);
    const paperEquity = fs.existsSync(PATHS.paperEquity)
      ? parseCsv(fs.readFileSync(PATHS.paperEquity, "utf8")).slice(-30)
      : [];

    const tabData = {};
    tabList.forEach(tab => {
      let tabPortfolioRaw = { cash: 0, holdings: [] };
      let tabTrades = [];
      let tabEquity = [];
      let tabChartData = {points: []};
      let tabLogRows = [];
      if (tab.id === 'paper' || tab.type === 'paper') {
        tabPortfolioRaw = fs.existsSync(PATHS.paperPortfolio) ? readJson(PATHS.paperPortfolio, tabPortfolioRaw) : tabPortfolioRaw;
        tabTrades = fs.existsSync(PATHS.paperTrades) ? parseCsv(fs.readFileSync(PATHS.paperTrades, "utf8")) : [];
        tabEquity = fs.existsSync(PATHS.paperEquity) ? parseCsv(fs.readFileSync(PATHS.paperEquity, "utf8")) : [];
        tabChartData = fs.existsSync(PATHS.paperChart) ? readJson(PATHS.paperChart, tabChartData) : tabChartData;
        tabLogRows = fs.existsSync(PATHS.strategyLog) ? parseCsv(fs.readFileSync(PATHS.strategyLog, "utf8")) : [];
      } else {
        const base = tab.id;
        const pPath = path.join(__dirname, `data/${base}_portfolio.json`);
        const tPath = path.join(__dirname, `data/${base}_trades.csv`);
        const ePath = path.join(__dirname, `data/${base}_equity.csv`);
        const cPath = path.join(__dirname, `data/${base}_chart.json`);
        const lPath = path.join(__dirname, `../${base}_strategy_log.csv`);
        tabPortfolioRaw = fs.existsSync(pPath) ? readJson(pPath, tabPortfolioRaw) : tabPortfolioRaw;
        tabTrades = fs.existsSync(tPath) ? parseCsv(fs.readFileSync(tPath, "utf8")) : [];
        tabEquity = fs.existsSync(ePath) ? parseCsv(fs.readFileSync(ePath, "utf8")) : [];
        tabChartData = fs.existsSync(cPath) ? readJson(cPath, tabChartData) : tabChartData;
        tabLogRows = fs.existsSync(lPath) ? parseCsv(fs.readFileSync(lPath, "utf8")) : [];
      }
      const tabPortfolioView = computePortfolio(tabPortfolioRaw, quotes);
      const tabLatest = getLatestLogEntry(tabLogRows);
      const tabTodaySessions = getTodaySessions(tabLogRows, todayEt);
      const tabLLMReport = loadTabLLMReport(tab.id, tabLatest?.Date, tabLatest?.Session);
      const tabRegimeTier = tabLatest ? Number(tabLatest.Regime_Tier) : 2;
      const tabTier = tiers[String(tabRegimeTier)] || tiers["2"];
      const tabTargets = tabTier.targets;
      const tabRecommended = tabLatest ? {
        QQQ: Number(tabLatest["Recommended_QQQ_%"] || tabTargets.QQQ),
        USO: Number(tabLatest["Recommended_USO_%"] || tabTargets.USO),
        GLD: Number(tabLatest["Recommended_GLD_%"] || tabTargets.GLD),
      } : tabTargets;
      const tabDriftVsRecommended = computeDrift(tabPortfolioView.weights, tabRecommended);
      const tabDriftVsTier = computeDrift(tabPortfolioView.weights, tabTargets);
      const tabStartingCapital = tabPortfolioRaw.starting_capital || (tab.id === 'paper' ? 100000 : 0);
      const tabReturnPct = tabStartingCapital > 0 ? round(((tabPortfolioView.totalValue / tabStartingCapital - 1) * 100), 2) : 0;
      const tabReturnDollar = round(tabPortfolioView.totalValue - tabStartingCapital, 2);
      const tabChartSeries = buildChartSeries(
        tabEquity,
        tabPortfolioRaw.started_at || null,
        tabStartingCapital,
        tabPortfolioView.totalValue,
        tabReturnPct
      );
      tabData[tab.id] = {
        enabled: !!tab.enabled,
        realTradingEnabled: !!tab.real_trading_enabled,
        startingCapital: tabStartingCapital,
        startedAt: tabPortfolioRaw.started_at || null,
        returnPct: tabReturnPct,
        returnDollar: tabReturnDollar,
        tradeCount: tabTrades.length,
        trades: tabTrades.slice().reverse().slice(0, 20),
        equity: tabEquity.slice(-30),
        chartSeries: tabChartSeries,
        portfolio: {
          ...tabPortfolioView,
          cash: tabPortfolioRaw.cash || 0,
          accountName: tabPortfolioRaw.account_name || (tab.type === 'robinhood' ? 'Real Robinhood' : 'Paper'),
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
          rationale: tabLatest?.Rationale_Summary ?? "",
          keySignals: tabLatest?.Key_Signals ?? "",
          logDate: tabLatest?.Date ?? null,
          session: tabLatest?.Session ?? null,
          suggestedAction: tabLatest?.Suggested_Action ?? "Hold",
          rebalanceNote: tabLatest?.Rebalance_Note ?? "",
          todayOpen: tabTodaySessions.open,
          todayClose: tabTodaySessions.close,
          llmReport: tabLLMReport || null,
        },
        log: tabLogRows.slice().reverse(),
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      tabData: tabData,
      tabs: tabList,
      regime: tabData.paper ? tabData.paper.regime : {
        tier: 2,
        name: 'Balanced / neutral',
        description: 'Balanced / neutral',
        targets: {QQQ:40,USO:30,GLD:30},
        recommended: {QQQ:40,USO:30,GLD:30},
        rationale: '',
        keySignals: '',
        logDate: null,
        session: null,
        suggestedAction: 'Hold',
        rebalanceNote: '',
        todayOpen: null,
        todayClose: null,
      },
      schedule: {
        timezone: "America/New_York",
        jobs: [
          { session: "Open", time: "09:30", purpose: "Pre-open rebalance check" },
          { session: "Close", time: "16:00", purpose: "End-of-day drift check" },
        ],
      },
      market: {
        quotes: liveQuotes,
        goldOilRatioEtf: gld && uso ? round(gld / uso, 2) : null,
        goldOilRatioSpot: goldSpot && wti ? round(goldSpot / wti, 2) : null,
      },
      tiers,
    };
  });
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, strategyLog: fs.existsSync(PATHS.strategyLog) });
});

app.get("/api/dashboard", async (_req, res) => {
  try {
    res.json(await buildDashboardPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/log", (_req, res) => {
  if (!fs.existsSync(PATHS.strategyLog)) return res.json([]);
  res.json(parseCsv(fs.readFileSync(PATHS.strategyLog, "utf8")).reverse());
});

app.get("/api/portfolio", (_req, res) => {
  res.json(activePortfolioRaw());
});

app.post("/api/portfolio", (req, res) => {
  if (paperEnabled()) {
    return res.status(403).json({ error: "Paper mode active — holdings are managed automatically" });
  }
  const body = req.body;
  if (!body?.holdings || !Array.isArray(body.holdings)) {
    return res.status(400).json({ error: "holdings array required" });
  }
  const current = readJson(PATHS.portfolio);
  const updated = {
    ...current,
    ...body,
    last_synced: new Date().toISOString(),
  };
  writeJson(PATHS.portfolio, updated);
  res.json(updated);
});

app.post("/api/live-prices", (req, res) => {
  const prices = req.body;
  if (!prices || typeof prices !== "object") {
    return res.status(400).json({ error: "prices object required, e.g. { \"QQQ\": { \"price\": 512.34, \"changePct\": 0.8 } }" });
  }
  const livePath = path.join(__dirname, "data/live_quotes.json");
  writeJson(livePath, prices);
  res.json({ ok: true, updated: Object.keys(prices), note: "Paper mode with use_real_prices: true will now use these prices instead of Yahoo" });
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