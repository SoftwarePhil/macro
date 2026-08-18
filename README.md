# Regime Dashboard

A local dashboard for monitoring a 3-tier macro regime strategy across **GLD**, **QQQ**, **USO**, and **CASH**. It scores the current regime, picks a target allocation within per-tier ranges, suggests rebalances, and supports **paper trading** with a Robinhood-style portfolio value chart.

No brokerage credentials are stored in this repo. Market data comes from public Yahoo Finance endpoints. The long-running Node server owns the in-app weekday schedule. All state is stored in a local SQLite database (`data/regime.db`).

## Strategy overview

Each tier defines allocation **ranges** per asset. The quant scorer picks a specific target within the range based on signal strength. A value of 0% for any asset (including USO) is valid and will be executed.

| Tier | Regime | QQQ | USO | GLD | CASH |
|------|--------|-----|-----|-----|------|
| 1 | Risk-on / growth | 50–70% | 0–30% | 5–25% | 0–20% |
| 2 | Balanced / neutral | 25–50% | 0–35% | 15–40% | 0–25% |
| 3 | Risk-off / stagflation | 0–25% | 0–20% | 40–70% | 10–40% |

Default midpoints and full range definitions live in `data/tiers.json`. Rebalance suggestions are capped at **5–10% per session**. Tier 3 favors capital preservation.

## Quick start

```bash
cp .env.example .env
npm install
npm run paper:init      # create fresh DB + $100k paper portfolio
npm run dev             # API + scheduler on :3847, UI on :5173
```

- **UI:** http://localhost:5173
- **API:** http://localhost:3847

`npm run dev` starts the Express API, its in-app scheduler, and the Vite dev server together. Vite proxies `/api` to the API. Keep this process running for scheduled jobs.

For one always-running production process:

```bash
npm run build
npm start
```

The production server serves the dashboard and API on http://localhost:3847 and keeps the scheduler running in the same process.

## Environment

Copy `.env.example` to `.env` and set local values there. The Node server and direct Python jobs load `.env` automatically. Variables already exported in the shell take precedence.

For development-only overrides, create `.env.local`. It is loaded automatically by `npm run dev`, the Node server, and direct Python jobs. Precedence is shell environment > `.env.local` > `.env`.

```bash
cp .env.example .env
cp .env.example .env.local
# Edit .env.local with machine-specific values or secrets.
npm run dev
```

Common settings:

- `PORT` — API port, default `3847`
- `SCHEDULER_ENABLED` — set to `false` to run the server without scheduled jobs
- `SCHEDULE_TIMEZONE` — scheduler timezone, default `America/New_York`
- `SCHEDULER_TICK_MS` — scheduler check interval, default `15000`
- `SCHEDULER_RETRY_MS` — failed-job retry delay, default `300000`
- `PYTHON_BIN` — Python executable, default `python3`
- `XAI_API_KEY` — optional key for direct Grok reports
- `XAI_MODEL` — xAI model, default `grok-3-latest`

`.env` and `.env.local` are ignored by Git. Never commit secrets; use `.env.example` for safe defaults and variable names.

### Requirements

- Node.js 20+
- Python 3.11+ (stdlib only — no pip deps)

## Dashboard features

- Portfolio value, cash, and allocation vs regime target with CASH row
- Drift warnings when any position exceeds a 5% band
- Market snapshot (QQQ, USO, GLD, VIX, WTI, gold, BTC) — Yahoo Finance with optional MCP override
- Regime rationale, strategy log, and LLM report viewer
- **Paper mode:** mock portfolio, auto-fills on in-app open/close jobs, P&L tracking
- **Portfolio chart:** Robinhood-style SVG line with hover crosshair and time ranges (1D / 1W / 1M / ALL)
- **Job run history:** every scheduled and manual execution logged with tier, action, LLM status, trade count, duration

## Paper trading

Paper mode is configured in the database. Initialize or reset via:

```bash
npm run paper:init                          # reset the paper account to $100k cash
npm run paper:init -- --capital 50000       # custom starting capital
npm run paper:init -- --start-date 2026-01-01
```

Paper state lives entirely in `data/regime.db` (gitignored). No CSV or JSON state files.

## Database

All runtime state is stored in `data/regime.db` (SQLite, WAL mode). The file is gitignored — the schema is recreated automatically on first run.

| Table | Contents |
|-------|----------|
| `tab_config` | Tab settings (paper / real), starting capital, price mode |
| `quotes` | Latest market prices per symbol with source (`yahoo` / `mcp`) and `fetched_at` timestamp |
| `portfolio_meta` | Per-tab scalars: cash, starting capital, last synced |
| `positions` | Current holdings (shares, avg cost) per tab + symbol |
| `trades` | Immutable append-only trade log |
| `equity_snapshots` | Post-rebalance portfolio state (value, weights, return %) |
| `strategy_log` | One row per job run: regime tier, targets, prices, action, rationale |
| `chart_snapshots` | Intraday value snapshots (throttled to 5 min) for the portfolio chart |
| `llm_reports` | Full LLM report text per tab / date / session |
| `job_runs` | Execution history: status, duration, trade count, LLM status, error messages |

The shared schema and all access functions are in `scripts/db.py` (Python) and `db.js` (Node). Both processes share the same file safely via WAL mode.

## Real prices via Robinhood MCP

Paper mode uses Yahoo Finance by default. To push live prices from the Robinhood MCP:

```bash
# POST live prices directly to the API
curl -X POST http://localhost:3847/api/live-prices \
  -H "Content-Type: application/json" \
  -d '{"QQQ": {"price": 731.0, "changePct": 0.8}, "USO": {"price": 115.0, "changePct": -1.2}}'
```

Prices are written to the `quotes` table as `source=mcp` and take priority over Yahoo for both the dashboard display and the regime job. They include a `fetched_at` timestamp — the job will fall back to a fresh Yahoo fetch if MCP prices are older than 8 minutes.

## In-app Scheduler

The Node server owns scheduling. No cron or LaunchAgent installation is required. While the server is running, it executes jobs **weekdays** at market open and close (Eastern Time):

| Session | Time (ET) | Purpose |
|---------|-----------|---------|
| Open | 9:30 AM | Regime score + rebalance check vs prior close |
| Close | 4:00 PM | End-of-day drift check vs same-day open |

```bash
# macOS only: remove old LaunchAgents from an earlier installation
npm run schedule:remove

# Development: API, scheduler, and Vite UI
npm run dev

# Production: build once, then keep this process running
npm run build
npm start

# Run manually
npm run job:open
npm run job:close
```

The scheduler checks for due work every 15 seconds, runs only one regime job at a time, and treats an existing paper-tab `strategy_log` row for a date/session as completed. If the server starts after a scheduled time on a weekday, it catches up missing sessions in order. Failed jobs are retried after five minutes. Scheduler state and the next run are available from `GET /api/health` and the dashboard header.

Configuration overrides:

- `SCHEDULER_ENABLED` — set to `false` to disable the in-app scheduler
- `SCHEDULE_TIMEZONE` — defaults to `America/New_York`
- `SCHEDULER_TICK_MS` — defaults to `15000`
- `SCHEDULER_RETRY_MS` — defaults to `300000`
- `PYTHON_BIN` — defaults to `python3`

Each job run:
1. Fetches quotes (MCP cache first, Yahoo fallback)
2. Scores the regime (tier 1–3) and picks targets within the tier's ranges based on signal strength
3. Computes drift vs targets (including CASH)
4. Executes paper trades if drift > 5% (capped at 5% per step)
5. Optionally calls the Grok LLM for a richer report and additional trade suggestions
6. Writes a structured record to `job_runs` and appends to `logs/jobs.log`

**XAI API key** (for direct LLM calls from the daily job):

```bash
# Add this to .env
XAI_API_KEY=xai-yourkeyhere

# Then start the server
npm start                   # loads .env and passes the key to the job
```

Alternatively, export `XAI_API_KEY` in the environment used to start the server. The older `data/xai_api_key.txt` fallback is still supported, but `.env` is preferred. Neither file nor the environment variable is committed.

## npm scripts

| Script | Description |
|--------|-------------|
| `dev` | API + Vite dev servers |
| `server` | API only (port 3847) |
| `start` | Production dashboard server + in-app scheduler |
| `build` | Production frontend build |
| `preview` | Preview production build |
| `job:open` | Run open regime job |
| `job:close` | Run close regime job |
| `schedule:remove` | Remove legacy macOS LaunchAgents |
| `paper:init` | Initialize/reset the paper portfolio |
| `test` | Run scheduler regression tests |

## Project layout

```
regime-dashboard/
├── server.js              # Express API — quotes, portfolio, chart, job runs, scheduler startup
├── env.js                 # Local .env loader
├── scheduler.js           # In-app weekday regime scheduler
├── db.js                  # SQLite access layer (Node)
├── src/
│   ├── main.js            # Dashboard UI (vanilla JS)
│   ├── portfolioChart.js  # Robinhood-style SVG chart
│   └── style.css
├── scripts/
│   ├── db.py              # SQLite access layer (Python)
│   ├── daily_regime_job.py
│   ├── paper_trade.py
│   ├── daily_regime_agent_prompt.txt
│   └── remove_legacy_schedule.sh
├── test/
│   ├── env.test.js
│   └── scheduler.test.js
└── data/
    ├── tiers.json         # Tier range definitions (committed)
    ├── regime.db          # Runtime state — gitignored
    └── xai_api_key.txt    # xAI key for the in-app job runner — gitignored
```

## API

| Endpoint | Description |
|----------|-------------|
| `GET /api/health` | Health check — reports DB, tab count, and scheduler status |
| `GET /api/dashboard` | Full dashboard payload including job runs |
| `GET /api/job-runs?limit=N` | Job execution history (newest first, max 500) |
| `GET /api/log?tab=paper` | Strategy log rows for a tab |
| `GET /api/portfolio?tab=paper` | Raw portfolio for a tab |
| `POST /api/portfolio` | Update manual holdings (blocked in paper mode) |
| `POST /api/live-prices` | Push MCP prices to the quotes table |

## Security & git

**Never committed:**

- API keys, OAuth tokens, or brokerage credentials
- `.env` and other local environment files
- `data/regime.db` and WAL files — all runtime state
- `data/xai_api_key.txt` — xAI key for the in-app job runner
- `logs/` — runtime output

`.gitignore` covers all of these. The xAI key is read by the long-running server and passed only to the spawned job process.

Robinhood MCP / Agentic account integration is configured separately in Grok — not in this repository.

## License

Private project. All rights reserved.
