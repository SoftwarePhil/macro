import "./style.css";
import { mountPortfolioChart, fmtChartMoney } from "./portfolioChart.js";

const ASSETS = ["QQQ", "USO", "GLD"];
const COLORS = { QQQ: "#6ee7b7", USO: "#fbbf24", GLD: "#f59e0b", CASH: "#94a3b8" };

let state = {
  data: null,
  loading: true,
  error: null,
  modalOpen: false,
  llmReportOpen: false,
  jobReportOpen: false,
  jobReport: null,
  chartRange: "ALL",
  activeTab: "paper",
};
let chartResizeTimer = null;

async function fetchDashboard() {
  state.loading = true;
  state.error = null;
  render();
  try {
    const res = await fetch("/api/dashboard");
    if (!res.ok) throw new Error(await res.text());
    state.data = await res.json();
    if (!state.activeTab && (state.data?.tabs || state.data?.paper?.tabs)?.length) {
      const tabs = state.data.tabs || state.data.paper.tabs;
      state.activeTab = tabs[0].id;
    }
  } catch (err) {
    state.error = err.message || "Failed to load dashboard";
  } finally {
    state.loading = false;
    render();
  }
}

function fmtMoney(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(n);
}

function fmtPrice(n, digits = 2) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPct(n, signed = false) {
  if (n == null || Number.isNaN(n)) return "—";
  const prefix = signed && n > 0 ? "+" : "";
  return `${prefix}${n.toFixed(1)}%`;
}

function chgClass(n) {
  if (n > 0) return "positive";
  if (n < 0) return "negative";
  return "";
}

function tierBadge(tier, name) {
  return `<span class="badge tier-${tier}">Tier ${tier} · ${name}</span>`;
}

function allocationRows(drift, positions) {
  const posMap = Object.fromEntries(positions.map((p) => [p.symbol, p]));
  return drift
    .map((d) => {
      const isCash = d.symbol === "CASH";
      const color = COLORS[d.symbol] || "#94a3b8";
      const warn = d.absDrift > 5 ? `<div class="drift-warn">Drift ${fmtPct(d.drift, true)}</div>` : "";
      // Clamp target marker to [0%, 100%] so 0% doesn't render at -1px
      const targetLeft = Math.max(0, Math.min(100, d.target));
      return `
        <div class="allocation-row">
          <div class="sym ${d.symbol.toLowerCase()}">${d.symbol}</div>
          <div>
            <div class="bar-track">
              <div class="bar-actual" style="width:${Math.min(d.actual, 100)}%;background:${color};${isCash ? "opacity:0.5" : ""}"></div>
              ${d.target > 0 ? `<div class="bar-target" style="left:calc(${targetLeft}% - 1px)"></div>` : ""}
            </div>
            ${warn}
          </div>
          <div class="pct-label mono">${fmtPct(d.actual)}</div>
          <div class="pct-label mono">${fmtPct(d.target)}</div>
          <div class="pct-label mono ${d.absDrift > 5 ? "drift-warn" : ""}">${fmtPct(d.drift, true)}</div>
        </div>
      `;
    })
    .join("");
}

function marketTiles(quotes) {
  const order = [
    ["QQQ", "QQQ"],
    ["USO", "USO"],
    ["GLD", "GLD"],
    ["^VIX", "VIX"],
    ["CL=F", "WTI"],
    ["GC=F", "Gold"],
    ["BTC-USD", "BTC"],
  ];
  return order
    .map(([key, label]) => {
      const q = quotes[key];
      if (!q) return "";
      const isMcp = q.marketState === "LIVE_ROBINHOOD_MCP";
      const sourceBadge = isMcp 
        ? `<span class="live-badge" title="Real-time price from Robinhood MCP">MCP</span>` 
        : `<span class="source-badge">Yahoo</span>`;
      return `
        <div class="market-tile ${isMcp ? 'mcp-live' : ''}">
          <div class="label">${label} ${sourceBadge}</div>
          <div class="price mono">${fmtPrice(q.price)}</div>
          <div class="chg mono ${chgClass(q.changePct)}">${fmtPct(q.changePct, true)}</div>
        </div>
      `;
    })
    .join("");
}

function tierList(tiers, activeTier) {
  return Object.entries(tiers)
    .map(([id, t]) => {
      const active = Number(id) === activeTier ? "active" : "";
      const alloc = `QQQ ${t.targets.QQQ}% · USO ${t.targets.USO}% · GLD ${t.targets.GLD}%`;
      return `
        <div class="tier-item ${active}">
          <h3>Tier ${id}: ${t.name}</h3>
          <p>${t.description}</p>
          <div class="tier-alloc">${alloc}</div>
        </div>
      `;
    })
    .join("");
}

function logTable(rows) {
  if (!rows.length) return `<p class="stat-sub">No strategy log entries yet.</p>`;
  const head = `
    <tr>
      <th>Date</th>
      <th>Session</th>
      <th>Tier</th>
      <th>QQQ</th>
      <th>USO</th>
      <th>GLD</th>
      <th>CASH</th>
      <th>Action</th>
    </tr>
  `;
  const body = rows
    .slice(0, 14)
    .map(
      (r) => `
      <tr>
        <td>${r.Date}</td>
        <td>${r.Session || "—"}</td>
        <td class="mono">${r.Regime_Tier}</td>
        <td class="mono">${r["Recommended_QQQ_%"]}%</td>
        <td class="mono">${r["Recommended_USO_%"]}%</td>
        <td class="mono">${r["Recommended_GLD_%"]}%</td>
        <td class="mono">${r["Recommended_CASH_%"] ?? 0}%</td>
        <td>${r.Suggested_Action || "Hold"}</td>
      </tr>
    `,
    )
    .join("");
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function jobRunsTable(runs) {
  if (!runs?.length) return `<p class="stat-sub">No job runs recorded yet — runs after this update will appear here.</p>`;

  const statusBadge = (s) => {
    if (s === "ok")   return `<span class="badge tier-1" style="font-size:0.65rem;padding:1px 6px">OK</span>`;
    if (s === "fail") return `<span class="badge tier-3" style="font-size:0.65rem;padding:1px 6px">FAIL</span>`;
    return `<span class="badge" style="font-size:0.65rem;padding:1px 6px">${s}</span>`;
  };
  const llmBadge = (s) => {
    if (!s) return "—";
    if (s === "direct")  return `<span style="color:var(--up);font-size:0.7rem">LLM</span>`;
    if (s === "skipped") return `<span style="color:var(--muted);font-size:0.7rem">quant</span>`;
    if (s === "error")   return `<span style="color:var(--down);font-size:0.7rem">error</span>`;
    return s;
  };

  const body = runs.slice(0, 30).map((r) => {
    const ts = new Date(r.started_at).toLocaleString("en-US", {
      month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
      timeZoneName: "short",
    });
    const dur = r.duration_s != null ? `${r.duration_s.toFixed(1)}s` : "—";
    const val = r.portfolio_value != null ? `$${Math.round(r.portfolio_value).toLocaleString()}` : "—";
    const tierStr = r.tier != null
      ? `<span class="badge tier-${r.tier}" style="font-size:0.65rem;padding:1px 6px">T${r.tier}</span>`
      : "—";
    const strengthStr = r.strength != null
      ? `<span class="mono" style="font-size:0.7rem;color:var(--muted)">${(r.strength * 100).toFixed(0)}%</span>`
      : "";
    return `
      <tr>
        <td class="mono" style="font-size:0.72rem;white-space:nowrap">${ts}</td>
        <td>${r.session || "—"}</td>
        <td>${statusBadge(r.status)}${r.error_message ? `<div style="font-size:0.65rem;color:var(--down);margin-top:2px">${escapeHtml(r.error_message)}</div>` : ""}</td>
        <td>${tierStr} ${strengthStr}</td>
        <td>${r.action || "—"}</td>
        <td>${llmBadge(r.llm_status)}</td>
        <td class="mono">${r.trade_count ?? 0}</td>
        <td class="mono">${val}</td>
        <td class="mono" style="color:var(--muted)">${dur}</td>
        <td>${r.llm_report_id ? `<button type="button" class="small" data-job-report-id="${r.id}">View</button>` : "—"}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="trades-table">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Session</th>
            <th>Status</th>
            <th>Tier</th>
            <th>Action</th>
            <th>LLM</th>
            <th>Trades</th>
            <th>Value</th>
            <th>Dur</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function jobReportModal() {
  if (!state.jobReportOpen) return "";

  const rep = state.jobReport?.report;
  const job = state.jobReport?.jobRun;
  if (!rep || !rep.text) {
    return `
      <div class="modal-backdrop" id="job-report-modal-backdrop">
        <div class="modal">
          <h2>Job Report</h2>
          <p class="stat-sub">No report found for this job run.</p>
          <div class="modal-actions">
            <button type="button" id="job-report-modal-close">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  return `
    <div class="modal-backdrop" id="job-report-modal-backdrop">
      <div class="modal" style="max-width: 900px; width: 95%;">
        <h2>Job LLM Report</h2>
        <div style="font-size:0.75rem;color:var(--muted);margin-bottom:8px">
          Job #${job?.id ?? "?"} · ${job?.session ?? ""} · ${job?.started_at ? new Date(job.started_at).toLocaleString() : ""} · ${rep.filename || "report"}
        </div>
        <div class="llm-report-body">
          <pre>${escapeHtml(rep.text)}</pre>
        </div>
        <div class="modal-actions">
          <button type="button" id="job-report-modal-close">Close</button>
          <button type="button" id="job-report-modal-copy">Copy report text</button>
        </div>
      </div>
    </div>
  `;
}

function positionsTable(positions) {
  if (!positions.some((p) => p.shares > 0)) {
    return `<p class="stat-sub">No positions yet — edit holdings to start tracking drift.</p>`;
  }
  const rows = positions
    .map(
      (p) => `
      <tr>
        <td class="sym ${p.symbol.toLowerCase()}">${p.symbol}</td>
        <td class="mono">${p.shares}</td>
        <td class="mono">${fmtPrice(p.price)}</td>
        <td class="mono">${fmtMoney(p.marketValue)}</td>
        <td class="mono ${chgClass(p.pnl)}">${fmtMoney(p.pnl)}</td>
      </tr>
    `,
    )
    .join("");
  return `
    <table>
      <thead>
        <tr><th>Symbol</th><th>Shares</th><th>Price</th><th>Value</th><th>P&L</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function editModal() {
  if (!state.modalOpen) return "";
  const rows = ASSETS.map((sym) => {
    const h = state.editHoldings?.[sym] ?? { shares: 0, avg_cost: 0 };
    return `
      <div class="form-row">
        <label class="sym ${sym.toLowerCase()}">${sym}</label>
        <input type="number" step="any" data-field="shares" data-symbol="${sym}" value="${h.shares}" placeholder="Shares" />
        <input type="number" step="any" data-field="avg_cost" data-symbol="${sym}" value="${h.avg_cost}" placeholder="Avg cost" />
      </div>
    `;
  }).join("");
  return `
    <div class="modal-backdrop" id="modal-backdrop">
      <div class="modal">
        <h2>Edit Holdings</h2>
        <div class="form-row" style="grid-template-columns:80px 1fr">
          <label>Cash</label>
          <input type="number" step="any" id="edit-cash" value="${state.editCash ?? 0}" />
        </div>
        <div style="margin:12px 0 6px;font-size:0.75rem;color:var(--muted)">Shares · Avg Cost</div>
        ${rows}
        <div class="modal-actions">
          <button type="button" id="modal-cancel">Cancel</button>
          <button type="button" id="modal-save">Save</button>
        </div>
      </div>
    </div>
  `;
}

function llmReportModal() {
  const d = state.data;
  if (!state.llmReportOpen || !d) return "";

  const tabList = Array.isArray(d.tabs || d.paper?.tabs) ? (d.tabs || d.paper.tabs) : [];
  const currentTab = tabList.find(t => t.id === state.activeTab) || tabList[0] || { id: "paper" };
  const thisTabData = d.tabData && d.tabData[currentTab.id] ? d.tabData[currentTab.id] : {};
  const rep = thisTabData.regime && thisTabData.regime.llmReport;

  if (!rep || !rep.text) {
    return `
      <div class="modal-backdrop" id="llm-modal-backdrop">
        <div class="modal">
          <h2>LLM Report</h2>
          <p class="stat-sub">No LLM report available for this tab yet.</p>
          <div class="modal-actions">
            <button type="button" id="llm-modal-close">Close</button>
          </div>
        </div>
      </div>
    `;
  }

  const header = `${rep.date || ""} ${rep.session || ""} — ${rep.filename || "LLM Report"}`;

  return `
    <div class="modal-backdrop" id="llm-modal-backdrop">
      <div class="modal" style="max-width: 860px; width: 94%;">
        <h2>Daily 3-Tier Regime Report (Grok)</h2>
        <div style="font-size:0.75rem;color:var(--muted);margin-bottom:8px">${header}</div>
        <div class="llm-report-body">
          <pre>${escapeHtml(rep.text)}</pre>
        </div>
        <div style="margin-top:8px;font-size:0.7rem;color:var(--muted)">Generated automatically by direct Grok API call from the scheduled daily job. Any trades in the JSON block were parsed and applied by the script.</div>
        <div class="modal-actions">
          <button type="button" id="llm-modal-close">Close</button>
          <button type="button" id="llm-modal-copy">Copy report text</button>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function tradesTable(trades) {
  if (!trades?.length) return `<p class="stat-sub">No paper trades yet — next open/close job will build positions.</p>`;
  const rows = trades
    .slice(0, 20)
    .map(
      (t) => `
      <tr>
        <td>${t.Date}</td>
        <td>${t.Session}</td>
        <td class="sym ${t.Symbol.toLowerCase()}">${t.Symbol}</td>
        <td>${t.Side}</td>
        <td class="mono">${Number(t.Shares).toFixed(4)}</td>
        <td class="mono">${fmtPrice(Number(t.Price))}</td>
        <td class="mono">${fmtMoney(Number(t.Notional))}</td>
        <td class="small">${t.Reason || ""}</td>
      </tr>
    `,
    )
    .join("");
  return `
    <div class="trades-table">
      <table>
        <thead><tr><th>Date</th><th>Session</th><th>Symbol</th><th>Side</th><th>Shares</th><th>Exec Price</th><th>Notional</th><th>Reason</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderMain() {
  const d = state.data;
  const { regime, market } = d;
  const tabList = Array.isArray(d.tabs || d.paper?.tabs) ? (d.tabs || d.paper.tabs) : [];
  const currentTab = tabList.find(t => t.id === state.activeTab) || tabList[0] || {id: 'paper', real_trading_enabled: false, type: 'paper'};
  const thisTabData = d.tabData && d.tabData[currentTab.id] ? d.tabData[currentTab.id] : {};
  const drift = thisTabData.drift || { vsRecommended: [], vsTier: [], maxDrift: 0, rebalanceNeeded: false };
  const portfolio = thisTabData.portfolio || { positions: [], totalValue: 0, invested: 0, cash: 0, weights: {} };
  const isRealTypeTab = currentTab.type === 'robinhood' || currentTab.id === 'real';
  const showEmptyReal = isRealTypeTab && !currentTab.real_trading_enabled;
  const action = drift.rebalanceNeeded
    ? `<div class="alert">Rebalance suggested — max drift ${fmtPct(drift.maxDrift)} exceeds 5% threshold. Cap moves at 5–10% per day.</div>`
    : `<div class="alert ok">Within drift tolerance — Hold current allocation.</div>`;

  return `
    <header class="top">
      <div>
        <h1>3-Tier Regime Dashboard</h1>
        <p>${regime.logDate ? `Last update: ${regime.logDate} ${regime.session || ""}` : "Awaiting first regime log"} · ${thisTabData.portfolio?.accountName || 'Account'}</p>
        <p style="margin-top:4px;font-size:0.8rem">Jobs: 9:30 AM open · 4:00 PM close (ET, weekdays)</p>
      </div>
      <div class="header-actions">
        ${!isRealTypeTab && thisTabData.enabled ? `<span class="badge paper">Paper · $${(thisTabData.startingCapital / 1000).toFixed(0)}k mock</span>` : ""}
        ${tierBadge(regime.tier, regime.name)}
        <button type="button" id="btn-refresh">Refresh</button>
        ${!isRealTypeTab && !thisTabData.enabled ? `<button type="button" id="btn-edit">Edit Holdings</button>` : ""}
      </div>
    </header>

    <div class="tabs">
      ${Array.isArray(d.tabs || d.paper?.tabs) ? (d.tabs || d.paper.tabs).map(tab => `
        <button type="button" class="tab-btn ${state.activeTab === tab.id ? 'active' : ''}" data-tab="${tab.id}">${tab.label || tab.id}</button>
      `).join('') : ''}
    </div>

    ${!isRealTypeTab && thisTabData.enabled ? `
    <div class="card chart-card" style="margin-bottom:16px">
      <div class="chart-hero">
        <div class="chart-hero-value mono" id="chart-hero-value">${fmtMoney(thisTabData.portfolio ? thisTabData.portfolio.totalValue : 0)}</div>
        <div class="chart-hero-change mono ${chgClass(thisTabData.returnPct)}" id="chart-hero-change">
          ${(thisTabData.returnDollar || 0) >= 0 ? "+" : ""}${fmtMoney(thisTabData.returnDollar || 0)} (${fmtPct(thisTabData.returnPct, true)}) all time
        </div>
      </div>
      <div class="chart-container" id="portfolio-chart"></div>
      <div class="chart-footer">
        <div class="chart-ranges">
          ${["1D", "1W", "1M", "ALL"].map((r) => `<button type="button" class="chart-range ${state.chartRange === r ? "active" : ""}" data-range="${r}">${r}</button>`).join("")}
        </div>
        <span class="chart-hint">Open · close jobs + live snapshots</span>
      </div>
    </div>` : ""}

    <div class="grid grid-3" style="margin-bottom:16px">
      <div class="card">
        ${showEmptyReal ? `
          <h2>Real Robinhood Portfolio</h2>
          <div class="stat-value mono">$0.00</div>
          <div class="stat-sub">Cash $0.00 · Invested $0.00</div>
          <div class="stat-sub" style="color:#64748b">No positions (empty state)</div>
        ` : isRealTypeTab && currentTab.real_trading_enabled ? `
          <h2>Real Robinhood Portfolio</h2>
          <div class="stat-value mono">Real data enabled via MCP (fetch not yet wired for this session)</div>
          <div class="stat-sub">Set real_trading_enabled: true on the tab to populate from Robinhood</div>
        ` : `
          <h2>${thisTabData.enabled ? "Paper Portfolio" : "Portfolio Value"}</h2>
          <div class="stat-value mono">${fmtMoney(thisTabData.portfolio ? thisTabData.portfolio.totalValue : 0)}</div>
          <div class="stat-sub">Cash ${fmtMoney(thisTabData.portfolio ? thisTabData.portfolio.cash : 0)} · Invested ${fmtMoney(thisTabData.portfolio ? thisTabData.portfolio.invested : 0)}</div>
          ${thisTabData.enabled ? `<div class="stat-sub ${chgClass(thisTabData.returnPct)}">P&L ${fmtPct(thisTabData.returnPct, true)} (${fmtMoney(thisTabData.returnDollar)}) vs $${(thisTabData.startingCapital || 0).toLocaleString()} start</div>` : ""}
        `}
      </div>
      <div class="card">
        <h2>Today's Regime</h2>
        <div class="stat-value" style="font-size:1.2rem">${thisTabData.regime ? thisTabData.regime.name : 'Default'}</div>
        <div class="stat-sub">QQQ ${thisTabData.regime ? thisTabData.regime.recommended.QQQ : 40}% · USO ${thisTabData.regime ? thisTabData.regime.recommended.USO : 30}% · GLD ${thisTabData.regime ? thisTabData.regime.recommended.GLD : 30}%${(thisTabData.regime?.recommended?.CASH ?? 0) > 0 ? ` · CASH ${thisTabData.regime.recommended.CASH}%` : ""}</div>
        <div class="stat-sub" style="margin-top:8px"><strong>${thisTabData.regime ? thisTabData.regime.suggestedAction || "Hold" : "Hold"}</strong>${thisTabData.regime && thisTabData.regime.rebalanceNote ? ` — ${thisTabData.regime.rebalanceNote}` : ""}</div>
      </div>
      <div class="card">
        <h2>Gold / Oil Ratio</h2>
        <div class="stat-value mono">${market.goldOilRatioSpot ?? "—"}</div>
        <div class="stat-sub">Spot (GC/WTI) · ETF ratio ${market.goldOilRatioEtf ?? "—"}</div>
      </div>
    </div>

    <div class="grid grid-2" style="margin-bottom:16px">
      ${!isRealTypeTab ? `
      <div class="card">
        <h2>Allocation vs Target</h2>
        <div class="allocation-row" style="font-size:0.72rem;color:var(--muted);padding-bottom:4px;border:none">
          <div>Asset</div><div>Actual vs Target</div><div style="text-align:right">Actual</div><div style="text-align:right">Target</div><div style="text-align:right">Drift</div>
        </div>
        ${allocationRows(thisTabData.drift ? thisTabData.drift.vsRecommended : [], thisTabData.portfolio ? thisTabData.portfolio.positions : [])}
        ${action}
      </div>
      ` : `<div class="card"><h2>Real Allocation</h2><p class="stat-sub">Real trading disabled for this tab (real_trading_enabled: false). Real data view-only from MCP when enabled on the tab.</p></div>`}
      <div class="card">
        ${showEmptyReal ? `
          <h2>Real Positions</h2>
          <p class="stat-sub" style="margin: 12px 0;">No positions</p>
          <div style="font-size:0.8rem;color:#64748b">Real Robinhood positions (view only). Real trading is OFF for this tab in config. Currently empty (0 dollars, no positions) as requested.</div>
        ` : isRealTypeTab && currentTab.real_trading_enabled ? `
          <h2>Real Positions</h2>
          <p class="stat-sub">Real trading enabled on this tab - live MCP portfolio would display here.</p>
        ` : `
          <h2>Positions</h2>
          ${positionsTable(thisTabData.portfolio ? thisTabData.portfolio.positions : [])}
        `}
      </div>
    </div>

    <div class="grid grid-2" style="margin-bottom:16px">
      <div class="card">
        <h2>Market Snapshot</h2>
        <div class="market-grid">${marketTiles(market.quotes)}</div>
        ${Object.values(market.quotes || {}).some(q => q.marketState === "LIVE_ROBINHOOD_MCP") 
          ? `<div style="font-size:0.7rem;color:#86efac;margin-top:6px">🔴 Real prices from Robinhood MCP (live via Grok)</div>` 
          : `<div style="font-size:0.7rem;color:var(--muted);margin-top:6px">Data: Yahoo Finance</div>`}
      </div>
      <div class="card">
        <h2>Regime Rationale</h2>
        <p class="rationale">${thisTabData.regime ? thisTabData.regime.rationale || "No rationale logged yet." : "No rationale logged yet."}</p>
        ${thisTabData.regime && thisTabData.regime.keySignals ? `<p class="stat-sub" style="margin-top:12px">${thisTabData.regime.keySignals}</p>` : ""}
        ${thisTabData.regime && thisTabData.regime.llmReport && thisTabData.regime.llmReport.text ? `
          <button type="button" id="btn-view-llm-report" style="margin-top:10px;font-size:0.75rem;padding:4px 10px">View full LLM report (${thisTabData.regime.llmReport.date} ${thisTabData.regime.llmReport.session})</button>
        ` : ""}
      </div>
    </div>

    <div class="grid grid-2" style="margin-bottom:16px">
      <div class="card">
        ${isRealTypeTab ? `
          <h2>Real Trades</h2>
          <p class="stat-sub" style="margin-bottom:8px;font-size:0.75rem">Real trading is disabled for this tab (real_trading_enabled: false in the config list). Paper simulation trade history is shown on the Paper tab.</p>
        ` : `
          <h2>Paper Trades</h2>
          <p class="stat-sub" style="margin-bottom:8px;font-size:0.75rem">Paper simulation trades executed by the regime jobs.</p>
          ${tradesTable(thisTabData.trades || [])}
        `}
      </div>
      <div class="card">
        <h2>Strategy Log</h2>
        ${thisTabData.log && thisTabData.log.length > 0 
          ? logTable(thisTabData.log) 
          : `<p class="stat-sub">No strategy log entries for this tab yet.</p>`}
      </div>
    </div>

    ${thisTabData.enabled ? `
    <div class="card" style="margin-bottom:16px">
      <h2>Tier Reference</h2>
      <div class="tier-list">${tierList(d.tiers, regime.tier)}</div>
    </div>` : ""}

    <div class="card" style="margin-bottom:16px">
      <h2>Job Run History</h2>
      <p class="stat-sub" style="margin-bottom:8px;font-size:0.75rem">Every scheduled and manual job execution — most recent first.</p>
      ${jobRunsTable(d.jobRuns)}
    </div>

    <div class="footer-meta mono">Updated ${new Date(d.generatedAt).toLocaleString()} · Source: ${thisTabData.portfolio?.source || 'paper'}${thisTabData.enabled ? ` · Started ${thisTabData.startedAt || ''} · ${thisTabData.tradeCount || 0} trades` : ""}${(thisTabData.portfolio && thisTabData.portfolio.lastSynced) ? ` · Synced ${new Date(thisTabData.portfolio.lastSynced).toLocaleString()}` : ""}</div>
  `;
}

function render() {
  const root = document.getElementById("app");
  if (state.loading && !state.data) {
    root.innerHTML = `<div class="loading">Loading dashboard…</div>`;
    return;
  }
  if (state.error && !state.data) {
    root.innerHTML = `<div class="error">${state.error}<br><button type="button" id="btn-retry" style="margin-top:16px">Retry</button></div>`;
    document.getElementById("btn-retry")?.addEventListener("click", fetchDashboard);
    return;
  }
  root.innerHTML = renderMain() + editModal() + llmReportModal() + jobReportModal();
  bindEvents();
  mountChart();
}

function mountChart() {
  const d = state.data;
  const tabList = Array.isArray(d.tabs || d.paper?.tabs) ? (d.tabs || d.paper.tabs) : [];
  const currentTab = tabList.find(t => t.id === state.activeTab) || tabList[0] || {id: 'paper'};
  const thisTabData = d.tabData && d.tabData[currentTab.id] ? d.tabData[currentTab.id] : d.paper || {};
  if (!thisTabData.enabled) return;
  const el = document.getElementById("portfolio-chart");
  if (!el) return;  // chart not present on this tab (e.g. Real tab)
  const result = mountPortfolioChart(el, {
    points: thisTabData.chartSeries || [],
    startingCapital: thisTabData.startingCapital,
    range: state.chartRange,
  });
  if (result && el) {
    const heroVal = document.getElementById("chart-hero-value");
    const heroChg = document.getElementById("chart-hero-change");
    if (heroVal) heroVal.textContent = fmtChartMoney(result.last.value);
    if (heroChg) {
      heroChg.className = `chart-hero-change mono ${result.isUp ? "positive" : "negative"}`;
      heroChg.textContent = `${result.delta >= 0 ? "+" : ""}${fmtChartMoney(result.delta)} (${result.deltaPct >= 0 ? "+" : ""}${result.deltaPct.toFixed(2)}%) all time`;
    }
  }
}

function openEditModal() {
  const d = state.data;
  const tabList = Array.isArray(d?.tabs) ? d.tabs : [];
  const currentTab = tabList.find(t => t.id === state.activeTab) || tabList[0] || { id: 'paper' };
  const thisTabData = d?.tabData?.[currentTab.id] || {};
  const p = thisTabData.portfolio || { cash: 0, positions: [] };
  state.editCash = p.cash;
  state.editHoldings = Object.fromEntries(
    p.positions.map((pos) => [pos.symbol, { shares: pos.shares, avg_cost: pos.avg_cost }]),
  );
  state.modalOpen = true;
  render();
}

async function saveHoldings() {
  const holdings = ASSETS.map((sym) => ({
    symbol: sym,
    shares: Number(state.editHoldings[sym]?.shares || 0),
    avg_cost: Number(state.editHoldings[sym]?.avg_cost || 0),
  }));
  const cash = Number(state.editCash || 0);
  await fetch("/api/portfolio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cash, holdings }),
  });
  state.modalOpen = false;
  await fetchDashboard();
}

function bindEvents() {
  document.getElementById("btn-refresh")?.addEventListener("click", fetchDashboard);
  document.getElementById("btn-edit")?.addEventListener("click", openEditModal);
  document.getElementById("modal-cancel")?.addEventListener("click", () => {
    state.modalOpen = false;
    render();
  });
  document.getElementById("modal-save")?.addEventListener("click", saveHoldings);
  document.getElementById("modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "modal-backdrop") {
      state.modalOpen = false;
      render();
    }
  });
  document.querySelectorAll("[data-field]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const sym = e.target.dataset.symbol;
      const field = e.target.dataset.field;
      if (!state.editHoldings[sym]) state.editHoldings[sym] = {};
      state.editHoldings[sym][field] = e.target.value;
    });
  });
  document.getElementById("edit-cash")?.addEventListener("input", (e) => {
    state.editCash = e.target.value;
  });
  document.querySelectorAll("[data-range]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.chartRange = btn.dataset.range;
      render();
    });
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.activeTab = btn.dataset.tab;
      render();
    });
  });

  // LLM full report modal (per-tab, from direct Grok calls in the daily job)
  document.getElementById("btn-view-llm-report")?.addEventListener("click", () => {
    state.llmReportOpen = true;
    render();
  });

  document.getElementById("llm-modal-close")?.addEventListener("click", () => {
    state.llmReportOpen = false;
    render();
  });

  document.getElementById("llm-modal-copy")?.addEventListener("click", () => {
    const d = state.data;
    const tabList = Array.isArray(d?.tabs || d?.paper?.tabs) ? (d.tabs || d.paper.tabs) : [];
    const currentTab = tabList.find(t => t.id === state.activeTab) || tabList[0];
    const thisTabData = d?.tabData?.[currentTab?.id] || {};
    const text = thisTabData.regime?.llmReport?.text || "";
    if (text) {
      navigator.clipboard?.writeText(text).then(() => {
        const btn = document.getElementById("llm-modal-copy");
        if (btn) {
          const old = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => { if (btn) btn.textContent = old; }, 1200);
        }
      }).catch(() => {});
    }
  });

  document.getElementById("llm-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "llm-modal-backdrop") {
      state.llmReportOpen = false;
      render();
    }
  });

  // Per-job linked report modal
  document.querySelectorAll("[data-job-report-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.jobReportId;
      if (!id) return;
      try {
        const res = await fetch(`/api/job-runs/${id}/report`);
        if (!res.ok) throw new Error(await res.text());
        state.jobReport = await res.json();
      } catch (err) {
        state.jobReport = { report: { text: `Failed to load report: ${err.message || err}` }, jobRun: { id } };
      }
      state.jobReportOpen = true;
      render();
    });
  });

  document.getElementById("job-report-modal-close")?.addEventListener("click", () => {
    state.jobReportOpen = false;
    render();
  });

  document.getElementById("job-report-modal-copy")?.addEventListener("click", () => {
    const text = state.jobReport?.report?.text || "";
    if (!text) return;
    navigator.clipboard?.writeText(text).then(() => {
      const btn = document.getElementById("job-report-modal-copy");
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = old; }, 1200);
    }).catch(() => {});
  });

  document.getElementById("job-report-modal-backdrop")?.addEventListener("click", (e) => {
    if (e.target.id === "job-report-modal-backdrop") {
      state.jobReportOpen = false;
      render();
    }
  });
}

window.addEventListener("resize", () => {
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(() => mountChart(), 150);
});

fetchDashboard();
setInterval(fetchDashboard, 60_000);
