"use client";

import { useEffect, useState } from "react";
import PortfolioChart, { fmtChartMoney, type PortfolioChartResult } from "./portfolio-chart";
import type {
  ChartRange,
  DashboardPayload,
  DriftRow,
  JobRun,
  LlmReport,
  Position,
  Quote,
  StrategyLogRow,
  TabData,
  TabSummary,
  TradeRow,
} from "@/lib/types";

const ASSETS = ["QQQ", "USO", "GLD"] as const;
const COLORS: Record<string, string> = {
  QQQ: "#6ee7b7",
  USO: "#fbbf24",
  GLD: "#f59e0b",
  CASH: "#94a3b8",
};
const CHART_RANGES: ChartRange[] = ["1D", "1W", "1M", "ALL"];

type EditableHolding = { shares: number | string; avg_cost: number | string };
type EditableHoldings = Record<string, EditableHolding>;
type JobReportPayload = { report?: LlmReport; jobRun?: JobRun };

function fmtMoney(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

function fmtPrice(value: number | null | undefined, digits = 2): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtPct(value: number | null | undefined, signed = false): string {
  if (value == null || Number.isNaN(value)) return "—";
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(1)}%`;
}

function chgClass(value: number | null | undefined): string {
  if (value == null) return "";
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "";
}

function TierBadge({ tier, name }: { tier: number; name: string }) {
  return <span className={`badge tier-${tier}`}>Tier {tier} · {name}</span>;
}

function AllocationRows({ drift }: { drift: DriftRow[] }) {
  return (
    <>
      {drift.map((row) => {
        const isCash = row.symbol === "CASH";
        const color = COLORS[row.symbol] || "#94a3b8";
        const targetLeft = Math.max(0, Math.min(100, row.target));
        return (
          <div className="allocation-row" key={row.symbol}>
            <div className={`sym ${row.symbol.toLowerCase()}`}>{row.symbol}</div>
            <div>
              <div className="bar-track">
                <div
                  className="bar-actual"
                  style={{ width: `${Math.min(row.actual, 100)}%`, background: color, opacity: isCash ? 0.5 : 1 }}
                />
                {row.target > 0 && <div className="bar-target" style={{ left: `calc(${targetLeft}% - 1px)` }} />}
              </div>
              {row.absDrift > 5 && <div className="drift-warn">Drift {fmtPct(row.drift, true)}</div>}
            </div>
            <div className="pct-label mono">{fmtPct(row.actual)}</div>
            <div className="pct-label mono">{fmtPct(row.target)}</div>
            <div className={`pct-label mono ${row.absDrift > 5 ? "drift-warn" : ""}`}>{fmtPct(row.drift, true)}</div>
          </div>
        );
      })}
    </>
  );
}

function MarketTiles({ quotes }: { quotes: Record<string, Quote> }) {
  const order: Array<[string, string]> = [
    ["QQQ", "QQQ"],
    ["USO", "USO"],
    ["GLD", "GLD"],
    ["^VIX", "VIX"],
    ["CL=F", "WTI"],
    ["GC=F", "Gold"],
    ["BTC-USD", "BTC"],
  ];
  return (
    <div className="market-grid">
      {order.map(([key, label]) => {
        const quote = quotes[key];
        if (!quote) return null;
        const isMcp = quote.marketState === "LIVE_ROBINHOOD_MCP";
        return (
          <div className={`market-tile ${isMcp ? "mcp-live" : ""}`} key={key}>
            <div className="label">
              {label} {isMcp ? <span className="live-badge" title="Real-time price from Robinhood MCP">MCP</span> : <span className="source-badge">Yahoo</span>}
            </div>
            <div className="price mono">{fmtPrice(quote.price)}</div>
            <div className={`chg mono ${chgClass(quote.changePct)}`}>{fmtPct(quote.changePct, true)}</div>
          </div>
        );
      })}
    </div>
  );
}

function TierList({ tiers, activeTier }: { tiers: DashboardPayload["tiers"]; activeTier: number }) {
  return (
    <div className="tier-list">
      {Object.entries(tiers).map(([id, tier]) => (
        <div className={`tier-item ${Number(id) === activeTier ? "active" : ""}`} key={id}>
          <h3>Tier {id}: {tier.name}</h3>
          <p>{tier.description}</p>
          <div className="tier-alloc">QQQ {tier.targets.QQQ}% · USO {tier.targets.USO}% · GLD {tier.targets.GLD}%</div>
        </div>
      ))}
    </div>
  );
}

function LogTable({ rows }: { rows: StrategyLogRow[] }) {
  if (!rows.length) return <p className="stat-sub">No strategy log entries yet.</p>;
  return (
    <table>
      <thead>
        <tr><th>Date</th><th>Session</th><th>Tier</th><th>QQQ</th><th>USO</th><th>GLD</th><th>CASH</th><th>Action</th></tr>
      </thead>
      <tbody>
        {rows.slice(0, 14).map((row, index) => (
          <tr key={`${row.Date}-${row.Session}-${index}`}>
            <td>{row.Date}</td>
            <td>{row.Session || "—"}</td>
            <td className="mono">{row.Regime_Tier}</td>
            <td className="mono">{row["Recommended_QQQ_%"]}%</td>
            <td className="mono">{row["Recommended_USO_%"]}%</td>
            <td className="mono">{row["Recommended_GLD_%"]}%</td>
            <td className="mono">{row["Recommended_CASH_%"] ?? 0}%</td>
            <td>{row.Suggested_Action || "Hold"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PositionsTable({ positions }: { positions: Position[] }) {
  if (!positions.some((position) => position.shares > 0)) {
    return <p className="stat-sub">No positions yet — edit holdings to start tracking drift.</p>;
  }
  return (
    <table>
      <thead><tr><th>Symbol</th><th>Shares</th><th>Price</th><th>Value</th><th>P&amp;L</th></tr></thead>
      <tbody>
        {positions.map((position) => (
          <tr key={position.symbol}>
            <td className={`sym ${position.symbol.toLowerCase()}`}>{position.symbol}</td>
            <td className="mono">{position.shares}</td>
            <td className="mono">{fmtPrice(position.price)}</td>
            <td className="mono">{fmtMoney(position.marketValue)}</td>
            <td className={`mono ${chgClass(position.pnl)}`}>{fmtMoney(position.pnl)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TradesTable({ trades }: { trades: TradeRow[] }) {
  if (!trades.length) return <p className="stat-sub">No paper trades yet — next open/close job will build positions.</p>;
  return (
    <div className="trades-table">
      <table>
        <thead><tr><th>Date</th><th>Session</th><th>Symbol</th><th>Side</th><th>Shares</th><th>Exec Price</th><th>Notional</th><th>Reason</th></tr></thead>
        <tbody>
          {trades.slice(0, 20).map((trade, index) => (
            <tr key={`${trade.Date}-${trade.Symbol}-${index}`}>
              <td>{trade.Date}</td>
              <td>{trade.Session}</td>
              <td className={`sym ${trade.Symbol.toLowerCase()}`}>{trade.Symbol}</td>
              <td>{trade.Side}</td>
              <td className="mono">{Number(trade.Shares).toFixed(4)}</td>
              <td className="mono">{fmtPrice(Number(trade.Price))}</td>
              <td className="mono">{fmtMoney(Number(trade.Notional))}</td>
              <td className="small">{trade.Reason || ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobRunsTable({ runs, onViewReport }: { runs: JobRun[]; onViewReport: (id: number) => void }) {
  if (!runs.length) return <p className="stat-sub">No job runs recorded yet — runs after this update will appear here.</p>;

  return (
    <div className="trades-table">
      <table>
        <thead><tr><th>Time</th><th>Session</th><th>Status</th><th>Tier</th><th>Action</th><th>LLM</th><th>Trades</th><th>Value</th><th>Dur</th><th>Report</th></tr></thead>
        <tbody>
          {runs.slice(0, 30).map((run) => {
            const timestamp = new Date(run.started_at).toLocaleString("en-US", {
              month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
            });
            const statusClass = run.status === "ok" ? "tier-1" : run.status === "fail" ? "tier-3" : "";
            const llmLabel = run.llm_status === "direct" ? "LLM" : run.llm_status === "skipped" ? "quant" : run.llm_status === "error" ? "error" : "—";
            return (
              <tr key={run.id}>
                <td className="mono" style={{ fontSize: "0.72rem", whiteSpace: "nowrap" }}>{timestamp}</td>
                <td>{run.session || "—"}</td>
                <td>
                  <span className={`badge ${statusClass}`} style={{ fontSize: "0.65rem", padding: "1px 6px" }}>{run.status.toUpperCase()}</span>
                  {run.error_message && <div style={{ fontSize: "0.65rem", color: "var(--down)", marginTop: 2 }}>{run.error_message}</div>}
                </td>
                <td>
                  {run.tier != null ? <span className={`badge tier-${run.tier}`} style={{ fontSize: "0.65rem", padding: "1px 6px" }}>T{run.tier}</span> : "—"}
                  {run.strength != null && <span className="mono" style={{ fontSize: "0.7rem", color: "var(--muted)" }}> {(run.strength * 100).toFixed(0)}%</span>}
                </td>
                <td>{run.action || "—"}</td>
                <td className={run.llm_status === "direct" ? "positive" : run.llm_status === "error" ? "negative" : ""}>{llmLabel}</td>
                <td className="mono">{run.trade_count ?? 0}</td>
                <td className="mono">{run.portfolio_value != null ? `$${Math.round(run.portfolio_value).toLocaleString()}` : "—"}</td>
                <td className="mono" style={{ color: "var(--muted)" }}>{run.duration_s != null ? `${run.duration_s.toFixed(1)}s` : "—"}</td>
                <td>{run.llm_report_id ? <button type="button" className="small" onClick={() => onViewReport(run.id)}>View</button> : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReportModal({
  title,
  report,
  subtitle,
  note,
  onClose,
  onCopy,
}: {
  title: string;
  report?: LlmReport | null;
  subtitle?: string;
  note?: string;
  onClose: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <div className="modal report-modal">
        <h2>{title}</h2>
        {!report?.text ? (
          <p className="stat-sub">No report found for this job run.</p>
        ) : (
          <>
            {subtitle && <div className="report-subtitle">{subtitle}</div>}
            <div className="llm-report-body"><pre>{report.text}</pre></div>
            {note && <div className="report-note">{note}</div>}
          </>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Close</button>
          {report?.text && <button type="button" onClick={onCopy}>Copy report text</button>}
        </div>
      </div>
    </div>
  );
}

function EditModal({
  cash,
  holdings,
  onCashChange,
  onHoldingChange,
  onCancel,
  onSave,
}: {
  cash: number | string;
  holdings: EditableHoldings;
  onCashChange: (value: string) => void;
  onHoldingChange: (symbol: string, field: keyof EditableHolding, value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={(event) => { if (event.currentTarget === event.target) onCancel(); }}>
      <div className="modal">
        <h2>Edit Holdings</h2>
        <div className="form-row" style={{ gridTemplateColumns: "80px 1fr" }}>
          <label htmlFor="edit-cash">Cash</label>
          <input id="edit-cash" type="number" step="any" value={cash} onChange={(event) => onCashChange(event.target.value)} />
        </div>
        <div style={{ margin: "12px 0 6px", fontSize: "0.75rem", color: "var(--muted)" }}>Shares · Avg Cost</div>
        {ASSETS.map((symbol) => {
          const holding = holdings[symbol] ?? { shares: 0, avg_cost: 0 };
          return (
            <div className="form-row" key={symbol}>
              <label className={`sym ${symbol.toLowerCase()}`} htmlFor={`${symbol}-shares`}>{symbol}</label>
              <input id={`${symbol}-shares`} type="number" step="any" value={holding.shares} placeholder="Shares" onChange={(event) => onHoldingChange(symbol, "shares", event.target.value)} />
              <input type="number" step="any" value={holding.avg_cost} placeholder="Avg cost" aria-label={`${symbol} average cost`} onChange={(event) => onHoldingChange(symbol, "avg_cost", event.target.value)} />
            </div>
          );
        })}
        <div className="modal-actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="button" onClick={onSave}>Save</button>
        </div>
      </div>
    </div>
  );
}

function emptyTabData(): Partial<TabData> {
  return {
    enabled: false,
    realTradingEnabled: false,
    startingCapital: 0,
    returnPct: 0,
    returnDollar: 0,
    tradeCount: 0,
    trades: [],
    chartSeries: [],
    portfolio: { positions: [], invested: 0, totalValue: 0, weights: { QQQ: 0, USO: 0, GLD: 0 }, cash: 0 },
    drift: { vsRecommended: [], vsTier: [], maxDrift: 0, rebalanceNeeded: false },
    log: [],
  };
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("paper");
  const [chartRange, setChartRange] = useState<ChartRange>("ALL");
  const [chartResult, setChartResult] = useState<PortfolioChartResult | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [llmReportOpen, setLlmReportOpen] = useState(false);
  const [jobReportOpen, setJobReportOpen] = useState(false);
  const [jobReport, setJobReport] = useState<JobReportPayload | null>(null);
  const [editCash, setEditCash] = useState<number | string>(0);
  const [editHoldings, setEditHoldings] = useState<EditableHoldings>({});

  async function loadDashboard(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/dashboard");
      if (!response.ok) throw new Error(await response.text());
      const payload = (await response.json()) as DashboardPayload;
      setData(payload);
      setActiveTab((current) => payload.tabs.some((tab) => tab.id === current) ? current : payload.tabs[0]?.id || "paper");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load dashboard");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      if (disposed) return;
      await loadDashboard();
    };
    void load();
    const interval = window.setInterval(() => { void load(); }, 60_000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, []);

  function openEditModal(): void {
    if (!data) return;
    const current = data.tabData[activeTab];
    if (!current) return;
    setEditCash(current.portfolio.cash || 0);
    setEditHoldings(Object.fromEntries(current.portfolio.positions.map((position) => [
      position.symbol,
      { shares: position.shares, avg_cost: position.avg_cost },
    ])));
    setModalOpen(true);
  }

  async function saveHoldings(): Promise<void> {
    const holdings = ASSETS.map((symbol) => ({
      symbol,
      shares: Number(editHoldings[symbol]?.shares || 0),
      avg_cost: Number(editHoldings[symbol]?.avg_cost || 0),
    }));
    const response = await fetch("/api/portfolio", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cash: Number(editCash || 0), holdings }),
    });
    if (!response.ok) {
      setError(await response.text());
      return;
    }
    setModalOpen(false);
    await loadDashboard();
  }

  async function viewJobReport(id: number): Promise<void> {
    try {
      const response = await fetch(`/api/job-runs/${id}/report`);
      if (!response.ok) throw new Error(await response.text());
      setJobReport((await response.json()) as JobReportPayload);
    } catch (caught) {
      setJobReport({ report: { date: "", session: "", text: `Failed to load report: ${caught instanceof Error ? caught.message : String(caught)}` }, jobRun: { id } as JobRun });
    }
    setJobReportOpen(true);
  }

  async function copyText(text: string): Promise<void> {
    if (!text || !navigator.clipboard) return;
    await navigator.clipboard.writeText(text).catch(() => undefined);
  }

  if (loading && !data) return <div className="loading">Loading dashboard…</div>;
  if (error && !data) {
    return <div className="error">{error}<br /><button type="button" style={{ marginTop: 16 }} onClick={() => void loadDashboard()}>Retry</button></div>;
  }
  if (!data) return null;

  const fallbackTab: TabSummary = {
    id: "paper", label: "Paper", type: "paper", enabled: false,
    real_trading_enabled: false, starting_capital: 0, max_step_pct: 5, use_real_prices: false,
  };
  const currentTab = data.tabs.find((tab) => tab.id === activeTab) || data.tabs[0] || fallbackTab;
  const tab = data.tabData[currentTab.id] || emptyTabData() as TabData;
  const regime = tab.regime || data.regime;
  const portfolio = tab.portfolio;
  const isRealTypeTab = currentTab.type === "robinhood" || currentTab.id === "real";
  const showEmptyReal = isRealTypeTab && !currentTab.real_trading_enabled;
  const scheduleText = !data.schedule?.enabled
    ? "In-app scheduler offline"
    : data.schedule.activeSession
      ? `In-app scheduler running ${data.schedule.activeSession.toLowerCase()} job`
      : "In-app scheduler online · 9:30 AM open · 4:00 PM close (ET, weekdays)";
  const action = tab.drift.rebalanceNeeded
    ? <div className="alert">Rebalance suggested — max drift {fmtPct(tab.drift.maxDrift)} exceeds 5% threshold. Cap moves at 5–10% per day.</div>
    : <div className="alert ok">Within drift tolerance — Hold current allocation.</div>;
  const chartChange = chartResult
    ? `${chartResult.delta >= 0 ? "+" : ""}${fmtChartMoney(chartResult.delta)} (${chartResult.deltaPct >= 0 ? "+" : ""}${chartResult.deltaPct.toFixed(2)}%) all time`
    : `${tab.returnDollar >= 0 ? "+" : ""}${fmtMoney(tab.returnDollar)} (${fmtPct(tab.returnPct, true)}) all time`;

  return (
    <main id="app">
      <header className="top">
        <div>
          <h1>3-Tier Regime Dashboard</h1>
          <p>{regime.logDate ? `Last update: ${regime.logDate} ${regime.session || ""}` : "Awaiting first regime log"} · {portfolio.accountName || "Account"}</p>
          <p style={{ marginTop: 4, fontSize: "0.8rem" }}>{scheduleText}</p>
        </div>
        <div className="header-actions">
          {!isRealTypeTab && tab.enabled && <span className="badge paper">Paper · ${(tab.startingCapital / 1000).toFixed(0)}k mock</span>}
          <TierBadge tier={regime.tier} name={regime.name} />
          <button type="button" onClick={() => void loadDashboard()}>Refresh</button>
          {!isRealTypeTab && !tab.enabled && <button type="button" onClick={openEditModal}>Edit Holdings</button>}
        </div>
      </header>

      <div className="tabs">
        {data.tabs.map((item) => (
          <button type="button" className={`tab-btn ${activeTab === item.id ? "active" : ""}`} key={item.id} onClick={() => setActiveTab(item.id)}>{item.label || item.id}</button>
        ))}
      </div>

      {!isRealTypeTab && tab.enabled && (
        <div className="card chart-card" style={{ marginBottom: 16 }}>
          <div className="chart-hero">
            <div className="chart-hero-value mono">{fmtMoney(chartResult?.last.value ?? portfolio.totalValue)}</div>
            <div className={`chart-hero-change mono ${chgClass(chartResult?.delta ?? tab.returnPct)}`}>{chartChange}</div>
          </div>
          <PortfolioChart points={tab.chartSeries} startingCapital={tab.startingCapital} range={chartRange} onResult={setChartResult} />
          <div className="chart-footer">
            <div className="chart-ranges">
              {CHART_RANGES.map((range) => <button type="button" className={`chart-range ${chartRange === range ? "active" : ""}`} key={range} onClick={() => setChartRange(range)}>{range}</button>)}
            </div>
            <span className="chart-hint">In-app open/close runs + live snapshots</span>
          </div>
        </div>
      )}

      <div className="grid grid-3" style={{ marginBottom: 16 }}>
        <div className="card">
          {showEmptyReal ? <>
            <h2>Real Robinhood Portfolio</h2><div className="stat-value mono">$0.00</div><div className="stat-sub">Cash $0.00 · Invested $0.00</div><div className="stat-sub" style={{ color: "#64748b" }}>No positions (empty state)</div>
          </> : isRealTypeTab && currentTab.real_trading_enabled ? <>
            <h2>Real Robinhood Portfolio</h2><div className="stat-value mono">Real data enabled via MCP (fetch not yet wired for this session)</div><div className="stat-sub">Set real_trading_enabled: true on the tab to populate from Robinhood</div>
          </> : <>
            <h2>{tab.enabled ? "Paper Portfolio" : "Portfolio Value"}</h2><div className="stat-value mono">{fmtMoney(portfolio.totalValue)}</div><div className="stat-sub">Cash {fmtMoney(portfolio.cash)} · Invested {fmtMoney(portfolio.invested)}</div>{tab.enabled && <div className={`stat-sub ${chgClass(tab.returnPct)}`}>P&amp;L {fmtPct(tab.returnPct, true)} ({fmtMoney(tab.returnDollar)}) vs ${(tab.startingCapital || 0).toLocaleString()} start</div>}
          </>}
        </div>
        <div className="card">
          <h2>Today&apos;s Regime</h2><div className="stat-value" style={{ fontSize: "1.2rem" }}>{regime.name}</div><div className="stat-sub">QQQ {regime.recommended.QQQ}% · USO {regime.recommended.USO}% · GLD {regime.recommended.GLD}%{(regime.recommended.CASH ?? 0) > 0 ? ` · CASH ${regime.recommended.CASH}%` : ""}</div><div className="stat-sub" style={{ marginTop: 8 }}><strong>{regime.suggestedAction || "Hold"}</strong>{regime.rebalanceNote ? ` — ${regime.rebalanceNote}` : ""}</div>
        </div>
        <div className="card"><h2>Gold / Oil Ratio</h2><div className="stat-value mono">{data.market.goldOilRatioSpot ?? "—"}</div><div className="stat-sub">Spot (GC/WTI) · ETF ratio {data.market.goldOilRatioEtf ?? "—"}</div></div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        {!isRealTypeTab ? <div className="card">
          <h2>Allocation vs Target</h2>
          <div className="allocation-row allocation-heading"><div>Asset</div><div>Actual vs Target</div><div>Actual</div><div>Target</div><div>Drift</div></div>
          <AllocationRows drift={tab.drift.vsRecommended} />{action}
        </div> : <div className="card"><h2>Real Allocation</h2><p className="stat-sub">Real trading disabled for this tab (real_trading_enabled: false). Real data view-only from MCP when enabled on the tab.</p></div>}
        <div className="card">
          {showEmptyReal ? <><h2>Real Positions</h2><p className="stat-sub" style={{ margin: "12px 0" }}>No positions</p><div style={{ fontSize: "0.8rem", color: "#64748b" }}>Real Robinhood positions (view only). Real trading is OFF for this tab in config. Currently empty.</div></> : isRealTypeTab && currentTab.real_trading_enabled ? <><h2>Real Positions</h2><p className="stat-sub">Real trading enabled on this tab — live MCP portfolio would display here.</p></> : <><h2>Positions</h2><PositionsTable positions={portfolio.positions} /></>}
        </div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card"><h2>Market Snapshot</h2><MarketTiles quotes={data.market.quotes} />{Object.values(data.market.quotes).some((quote) => quote.marketState === "LIVE_ROBINHOOD_MCP") ? <div className="market-source live-source">Real prices from Robinhood MCP (live via Grok)</div> : <div className="market-source">Data: Yahoo Finance</div>}</div>
        <div className="card"><h2>Regime Rationale</h2><p className="rationale">{regime.rationale || "No rationale logged yet."}</p>{regime.keySignals && <p className="stat-sub" style={{ marginTop: 12 }}>{regime.keySignals}</p>}{regime.llmReport?.text && <button type="button" style={{ marginTop: 10, fontSize: "0.75rem", padding: "4px 10px" }} onClick={() => setLlmReportOpen(true)}>View full LLM report ({regime.llmReport.date} {regime.llmReport.session})</button>}</div>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card">{isRealTypeTab ? <><h2>Real Trades</h2><p className="stat-sub" style={{ marginBottom: 8, fontSize: "0.75rem" }}>Real trading is disabled for this tab. Paper simulation trade history is shown on the Paper tab.</p></> : <><h2>Paper Trades</h2><p className="stat-sub" style={{ marginBottom: 8, fontSize: "0.75rem" }}>Paper simulation trades executed by the regime jobs.</p><TradesTable trades={tab.trades} /></>}</div>
        <div className="card"><h2>Strategy Log</h2><LogTable rows={tab.log} /></div>
      </div>

      {tab.enabled && <div className="card" style={{ marginBottom: 16 }}><h2>Tier Reference</h2><TierList tiers={data.tiers} activeTier={regime.tier} /></div>}
      <div className="card" style={{ marginBottom: 16 }}><h2>Job Run History</h2><p className="stat-sub" style={{ marginBottom: 8, fontSize: "0.75rem" }}>Every scheduled and manual job execution — most recent first.</p><JobRunsTable runs={data.jobRuns} onViewReport={(id) => void viewJobReport(id)} /></div>
      <div className="footer-meta mono">Updated {new Date(data.generatedAt).toLocaleString()} · Source: {portfolio.source || "paper"}{tab.enabled ? ` · Started ${tab.startedAt || ""} · ${tab.tradeCount || 0} trades` : ""}{portfolio.lastSynced ? ` · Synced ${new Date(portfolio.lastSynced).toLocaleString()}` : ""}</div>

      {modalOpen && <EditModal cash={editCash} holdings={editHoldings} onCashChange={setEditCash} onHoldingChange={(symbol, field, value) => setEditHoldings((current) => ({ ...current, [symbol]: { ...(current[symbol] || { shares: 0, avg_cost: 0 }), [field]: value } }))} onCancel={() => setModalOpen(false)} onSave={() => void saveHoldings()} />}
      {llmReportOpen && <ReportModal title="Daily 3-Tier Regime Report (Grok)" report={regime.llmReport} subtitle={`${regime.llmReport?.date || ""} ${regime.llmReport?.session || ""} — ${regime.llmReport?.filename || "LLM Report"}`} note="Generated automatically by direct Grok API call from the scheduled daily job. Any trades in the JSON block were parsed and applied by the script." onClose={() => setLlmReportOpen(false)} onCopy={() => void copyText(regime.llmReport?.text || "")} />}
      {jobReportOpen && <ReportModal title="Job LLM Report" report={jobReport?.report} subtitle={jobReport?.jobRun ? `Job #${jobReport.jobRun.id} · ${jobReport.jobRun.session || ""} · ${jobReport.jobRun.started_at ? new Date(jobReport.jobRun.started_at).toLocaleString() : ""} · ${jobReport.report?.filename || "report"}` : undefined} onClose={() => setJobReportOpen(false)} onCopy={() => void copyText(jobReport?.report?.text || "")} />}
    </main>
  );
}
