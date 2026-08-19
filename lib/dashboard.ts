import fs from "node:fs";
import path from "node:path";
import "./env";
import {
  countTrades,
  claimSchedulerSession,
  getDb,
  loadChartSnapshots,
  loadEquitySnapshots,
  loadJobRuns,
  loadLatestLlmReport,
  loadPortfolio,
  loadQuotes,
  loadStrategyLog,
  loadTabConfig,
  loadTrades,
  recordChartSnapshot,
  releaseSchedulerSession,
  savePortfolio,
} from "./db";
import { createScheduler, REGIME_SCHEDULE, type SchedulerStatus } from "./scheduler";
import { ASSETS, type ChartPoint, type DashboardPayload, type LlmReport, type Quote, type RawPortfolio, type StrategyLogRow, type TabData, type TabSummary, type TierDefinitions } from "./types";

const ROOT = process.cwd();
const SYMBOLS = ["QQQ", "USO", "GLD", "^VIX", "CL=F", "GC=F", "BTC-USD"];
const TIERS_PATH = path.join(ROOT, "data", "tiers.json");
const REPORTS_DIR = path.join(ROOT, "logs", "reports");

let scheduler: ReturnType<typeof createScheduler> | undefined;
let schedulerStarted = false;

export function startScheduler(): void {
  ensureScheduler();
}

function ensureScheduler(): ReturnType<typeof createScheduler> | undefined {
  if (schedulerStarted) return scheduler;
  schedulerStarted = true;
  if (process.env.SCHEDULER_ENABLED === "false") return undefined;

  scheduler = createScheduler({
    rootDir: ROOT,
    isSessionComplete,
    claimSession: claimSchedulerSession,
    releaseSession: releaseSchedulerSession,
  });
  scheduler.start();
  return scheduler;
}

export function getSchedulerStatus(): SchedulerStatus {
  return ensureScheduler()?.getStatus() ?? {
    enabled: false,
    timezone: process.env.SCHEDULE_TIMEZONE || "America/New_York",
    tickMs: 0,
    retryMs: 0,
    startedAt: null,
    lastCheckAt: null,
    activeSession: null,
    jobs: REGIME_SCHEDULE.map((job) => ({
      session: job.label,
      time: job.time,
      purpose: job.purpose,
      due: false,
      completedToday: false,
      running: false,
      nextRun: null,
      lastRun: null,
    })),
  };
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function round(n: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

interface YahooQuoteResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        previousClose?: number;
        chartPreviousClose?: number;
        currency?: string;
        marketState?: string;
        regularMarketTime?: number;
      };
    }>;
  };
}

async function fetchYahooQuote(symbol: string): Promise<Quote> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const response = await fetch(url, { headers: { "User-Agent": "regime-dashboard/0.1" } });
  if (!response.ok) throw new Error(`Quote fetch failed for ${symbol}`);
  const json = (await response.json()) as YahooQuoteResponse;
  const meta = json.chart?.result?.[0]?.meta;
  if (!meta) throw new Error(`No quote data for ${symbol}`);
  const price = meta.regularMarketPrice ?? meta.previousClose ?? 0;
  const previous = meta.chartPreviousClose ?? meta.previousClose ?? price;
  const change = price - previous;
  const changePct = previous ? (change / previous) * 100 : 0;
  return {
    symbol,
    price: round(price),
    changePct: round(changePct),
    change: round(change),
    currency: meta.currency ?? "USD",
    marketState: meta.marketState ?? "UNKNOWN",
    updatedAt: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString(),
  };
}

async function fetchAndPersistQuotes(): Promise<Record<string, Quote>> {
  const results = await Promise.allSettled(SYMBOLS.map(fetchYahooQuote));
  const fresh: Record<string, Quote> = {};
  for (const result of results) {
    if (result.status === "fulfilled") fresh[result.value.symbol] = result.value;
  }

  const database = getDb();
  const now = new Date().toISOString();
  const upsert = database.prepare(`
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
  const transaction = database.transaction((quotes: Record<string, Quote>) => {
    for (const quote of Object.values(quotes)) {
      upsert.run({
        symbol: quote.symbol,
        price: quote.price,
        change_pct: quote.changePct,
        market_state: quote.marketState,
        now,
      });
    }
  });
  transaction(fresh);
  return fresh;
}

function buildDisplayQuotes(freshYahoo: Record<string, Quote>): Record<string, Quote> {
  const dbRows = loadQuotes();
  const result = { ...freshYahoo };
  for (const [symbol, row] of Object.entries(dbRows)) {
    if (row.source !== "mcp") continue;
    result[symbol] = {
      symbol,
      price: row.price,
      changePct: row.change_pct,
      change: 0,
      currency: "USD",
      marketState: "LIVE_ROBINHOOD_MCP",
      updatedAt: row.fetched_at,
    };
  }
  return result;
}

function computePortfolio(portfolio: RawPortfolio, quotes: Record<string, Quote>) {
  const positions = ASSETS.map((symbol) => {
    const holding = portfolio.holdings.find((item) => item.symbol === symbol) ?? {
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
      marketValue: round(marketValue),
      costBasis: round(costBasis),
      pnl: round(pnl),
      pnlPct: round(pnlPct),
      changePct: quote?.changePct ?? 0,
    };
  });

  const invested = positions.reduce((sum, position) => sum + position.marketValue, 0);
  const totalValue = invested + (portfolio.cash || 0);
  const weights = Object.fromEntries(
    ASSETS.map((symbol) => {
      const position = positions.find((item) => item.symbol === symbol);
      const percentage = totalValue ? ((position?.marketValue ?? 0) / totalValue) * 100 : 0;
      return [symbol, round(percentage, 1)];
    }),
  ) as Record<(typeof ASSETS)[number], number>;

  return {
    positions,
    invested: round(invested),
    totalValue: round(totalValue),
    weights,
  };
}

function computeDrift(weights: Record<string, number>, targets: Record<string, number>) {
  const symbols = [...ASSETS, ...(targets.CASH != null ? ["CASH"] : [])];
  return symbols.map((symbol) => {
    const actual = symbol === "CASH"
      ? Math.max(0, round(100 - ASSETS.reduce((sum, asset) => sum + (weights[asset] ?? 0), 0), 1))
      : weights[symbol] ?? 0;
    const target = targets[symbol] ?? 0;
    const drift = round(actual - target, 1);
    return { symbol, actual, target, drift, absDrift: Math.abs(drift) };
  });
}

const SESSION_ORDER: Record<string, number> = { open: 0, close: 1 };

function sessionRank(session: string | undefined): number {
  return SESSION_ORDER[String(session || "").toLowerCase()] ?? 0;
}

function chartPointTs(date: string, session: string): number {
  const normalized = String(session || "").toLowerCase();
  if (normalized === "start") return new Date(`${date}T00:00:00`).getTime();
  if (normalized === "open") return new Date(`${date}T09:30:00-04:00`).getTime();
  if (normalized === "close") return new Date(`${date}T16:00:00-04:00`).getTime();
  return new Date(`${date}T12:00:00-04:00`).getTime();
}

function buildChartSeries(
  equityRows: Array<Record<string, unknown>>,
  startedAt: string | null | undefined,
  startingCapital: number,
  liveValue: number,
  returnPct: number,
  intradaySnapshots: ChartPoint[],
): ChartPoint[] {
  const startPoint = startedAt && startingCapital > 0
    ? { date: startedAt, session: "Start", value: startingCapital, returnPct: 0, ts: chartPointTs(startedAt, "Start") }
    : null;
  const middle: ChartPoint[] = [];

  for (const row of equityRows) {
    const date = String(row.Date);
    const session = String(row.Session);
    middle.push({
      date,
      session,
      value: Number(row.Total_Value),
      returnPct: Number(row.Return_pct),
      ts: chartPointTs(date, session),
    });
  }

  for (const snapshot of intradaySnapshots) {
    const date = new Date(snapshot.ts);
    middle.push({
      date: date.toLocaleDateString("en-CA", { timeZone: "America/New_York" }),
      session: "Intraday",
      time: date.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
      }),
      value: Number(snapshot.value),
      returnPct: Number(snapshot.returnPct),
      ts: snapshot.ts,
    });
  }

  middle.sort((a, b) => a.ts - b.ts);
  const deduped: ChartPoint[] = [];
  for (const point of middle) {
    const previous = deduped.at(-1);
    if (previous && Math.abs(previous.ts - point.ts) < 60_000 && Math.abs(previous.value - point.value) < 0.01) {
      deduped[deduped.length - 1] = point;
    } else {
      deduped.push(point);
    }
  }

  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return [
    ...(startPoint ? [startPoint] : []),
    ...deduped,
    { date: todayEt, session: "Live", value: liveValue, returnPct, ts: Date.now() },
  ];
}

function getLatestLogEntry(rows: StrategyLogRow[]): StrategyLogRow | null {
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => {
    if (a.Date !== b.Date) return a.Date < b.Date ? -1 : 1;
    return sessionRank(a.Session) - sessionRank(b.Session);
  }).at(-1) ?? null;
}

function getTodaySessions(rows: StrategyLogRow[], today: string): {
  open: StrategyLogRow | null;
  close: StrategyLogRow | null;
} {
  const dayRows = rows.filter((row) => row.Date === today);
  return {
    open: dayRows.find((row) => String(row.Session).toLowerCase() === "open") ?? null,
    close: dayRows.find((row) => String(row.Session).toLowerCase() === "close") ?? null,
  };
}

function isSessionComplete(dateKey: string, session: string): boolean {
  const row = getDb().prepare(
    "SELECT 1 FROM strategy_log WHERE tab_id=? AND date=? AND session=? LIMIT 1",
  ).get("paper", dateKey, String(session).toLowerCase());
  return Boolean(row);
}

function loadTabLlmReport(tabId: string, logDate: string | undefined, logSession: string | undefined): LlmReport | null {
  if (!logDate || !logSession) return null;
  const dbReport = loadLatestLlmReport(tabId);
  if (dbReport && dbReport.date === logDate) return dbReport;

  const session = String(logSession).toLowerCase().trim();
  const candidates = [
    path.join(REPORTS_DIR, `${logDate}_${session}.md`),
    path.join(REPORTS_DIR, `${logDate}_${session}_${tabId}.md`),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(/* turbopackIgnore: true */ candidate)) continue;
    try {
      return {
        filename: path.basename(candidate),
        text: fs.readFileSync(/* turbopackIgnore: true */ candidate, "utf8").trim(),
        date: logDate,
        session: logSession,
      };
    } catch {
      // Ignore unreadable legacy report files.
    }
  }
  return null;
}

export async function buildDashboardPayload(): Promise<DashboardPayload> {
  ensureScheduler();
  const [freshYahoo] = await Promise.all([fetchAndPersistQuotes()]);
  const quotes = buildDisplayQuotes(freshYahoo);
  const tiers = readJson<TierDefinitions>(TIERS_PATH, {});
  const tabList = loadTabConfig();
  const todayEt = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const tabData: Record<string, TabData> = {};

  for (const tab of tabList) {
    const tabId = tab.tab_id;
    const rawPortfolio = loadPortfolio(tabId);
    const portfolioView = computePortfolio(rawPortfolio, quotes);
    const trades = loadTrades(tabId, 20);
    const equity = loadEquitySnapshots(tabId, 30);
    const intradaySnapshots = loadChartSnapshots(tabId);
    const log = loadStrategyLog(tabId);
    const latest = getLatestLogEntry(log);
    const todaySessions = getTodaySessions(log, todayEt);
    const regimeTier = latest ? Number(latest.Regime_Tier) : 2;
    const tier = tiers[String(regimeTier)] || tiers["2"];
    const targets = tier?.targets ?? { QQQ: 40, USO: 25, GLD: 25, CASH: 10 };
    const recommended = latest
      ? {
          QQQ: Number(latest["Recommended_QQQ_%"] ?? targets.QQQ),
          USO: Number(latest["Recommended_USO_%"] ?? targets.USO),
          GLD: Number(latest["Recommended_GLD_%"] ?? targets.GLD),
          CASH: Number(latest["Recommended_CASH_%"] ?? targets.CASH ?? 0),
        }
      : targets;
    const driftVsRecommended = computeDrift(portfolioView.weights, recommended);
    const driftVsTier = computeDrift(portfolioView.weights, targets);
    const startingCapital = rawPortfolio.starting_capital || tab.starting_capital || 0;
    const returnPct = startingCapital > 0
      ? round((portfolioView.totalValue / startingCapital - 1) * 100)
      : 0;
    const returnDollar = round(portfolioView.totalValue - startingCapital);
    const chartSeries = buildChartSeries(
      equity as unknown as Array<Record<string, unknown>>,
      rawPortfolio.started_at,
      startingCapital,
      portfolioView.totalValue,
      returnPct,
      intradaySnapshots,
    );

    if (tab.enabled) recordChartSnapshot(portfolioView.totalValue, returnPct, tabId);

    tabData[tabId] = {
      enabled: Boolean(tab.enabled),
      realTradingEnabled: Boolean(tab.real_trading_enabled),
      startingCapital,
      startedAt: rawPortfolio.started_at || null,
      returnPct,
      returnDollar,
      tradeCount: countTrades(tabId),
      trades,
      equity,
      chartSeries,
      portfolio: {
        ...portfolioView,
        cash: rawPortfolio.cash || 0,
        accountName: rawPortfolio.account_name || (tab.type === "robinhood" ? "Real Robinhood" : "Paper"),
        source: rawPortfolio.source || tab.type,
        lastSynced: rawPortfolio.last_synced || null,
      },
      drift: {
        vsRecommended: driftVsRecommended,
        vsTier: driftVsTier,
        maxDrift: Math.max(...driftVsRecommended.map((row) => row.absDrift), 0),
        rebalanceNeeded: driftVsRecommended.some((row) => row.absDrift > 5),
      },
      regime: {
        tier: regimeTier,
        name: tier?.name ?? "Balanced / Neutral",
        description: tier?.description ?? "",
        targets,
        recommended,
        rationale: latest?.Rationale_Summary ?? "",
        keySignals: latest?.Key_Signals ?? "",
        logDate: latest?.Date ?? null,
        session: latest?.Session ?? null,
        suggestedAction: latest?.Suggested_Action ?? "Hold",
        rebalanceNote: latest?.Rebalance_Note ?? "",
        todayOpen: todaySessions.open,
        todayClose: todaySessions.close,
        llmReport: loadTabLlmReport(tabId, latest?.Date, latest?.Session),
      },
      log: log.slice().reverse(),
    };
  }

  const globalRegime = tabData.paper?.regime ?? {
    tier: 2,
    name: "Balanced / Neutral",
    description: "Mixed data, moderate volatility, contained geopolitics",
    targets: { QQQ: 40, USO: 25, GLD: 25, CASH: 10 },
    recommended: { QQQ: 40, USO: 25, GLD: 25, CASH: 10 },
    rationale: "",
    keySignals: "",
    logDate: null,
    session: null,
    suggestedAction: "Hold",
    rebalanceNote: "",
    todayOpen: null,
    todayClose: null,
  };
  const gld = quotes.GLD?.price ?? 0;
  const uso = quotes.USO?.price ?? 0;
  const wti = quotes["CL=F"]?.price ?? 0;
  const goldSpot = quotes["GC=F"]?.price ?? 0;
  const tabs: TabSummary[] = tabList.map((tab) => ({
    id: tab.tab_id,
    label: tab.label,
    type: tab.type,
    enabled: Boolean(tab.enabled),
    real_trading_enabled: Boolean(tab.real_trading_enabled),
    starting_capital: tab.starting_capital,
    max_step_pct: tab.max_step_pct,
    use_real_prices: Boolean(tab.use_real_prices),
  }));

  return {
    generatedAt: new Date().toISOString(),
    tabData,
    tabs,
    regime: globalRegime,
    schedule: getSchedulerStatus(),
    market: {
      quotes,
      goldOilRatioEtf: gld && uso ? round(gld / uso) : null,
      goldOilRatioSpot: goldSpot && wti ? round(goldSpot / wti) : null,
    },
    tiers,
    jobRuns: loadJobRuns(50),
  };
}

export function saveManualPortfolio(cash: number, holdings: Array<{ symbol: string; shares: number; avg_cost: number }>): RawPortfolio {
  const current = loadPortfolio("paper");
  savePortfolio({ ...current, cash, holdings }, "paper");
  return loadPortfolio("paper");
}
