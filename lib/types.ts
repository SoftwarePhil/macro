export const ASSETS = ["QQQ", "USO", "GLD"] as const;

export type Asset = (typeof ASSETS)[number];
export type ChartRange = "1D" | "1W" | "1M" | "ALL";

export interface Quote {
  symbol: string;
  price: number;
  changePct: number;
  change: number;
  currency: string;
  marketState: string;
  updatedAt: string;
}

export interface QuoteRow {
  symbol: string;
  price: number;
  change_pct: number;
  market_state: string;
  fetched_at: string;
  source: string;
}

export interface Holding {
  symbol: string;
  shares: number;
  avg_cost: number;
}

export interface RawPortfolio {
  tab_id: string;
  account_name?: string | null;
  source?: string | null;
  mode?: string | null;
  starting_capital: number;
  started_at?: string | null;
  cash: number;
  last_synced?: string | null;
  holdings: Holding[];
}

export interface Position extends Holding {
  price: number;
  marketValue: number;
  costBasis: number;
  pnl: number;
  pnlPct: number;
  changePct: number;
}

export interface PortfolioView {
  positions: Position[];
  invested: number;
  totalValue: number;
  weights: Record<Asset, number>;
  cash?: number;
  accountName?: string;
  source?: string;
  lastSynced?: string | null;
}

export interface DriftRow {
  symbol: string;
  actual: number;
  target: number;
  drift: number;
  absDrift: number;
}

export interface TierDefinition {
  name: string;
  description: string;
  targets: Record<string, number>;
  ranges: Record<string, { min: number; max: number }>;
}

export type TierDefinitions = Record<string, TierDefinition>;

export interface TabConfig {
  tab_id: string;
  label: string;
  type: string;
  enabled: number | boolean;
  real_trading_enabled: number | boolean;
  starting_capital: number;
  max_step_pct: number;
  use_real_prices: number | boolean;
  started_at?: string | null;
  updated_at?: string;
}

export interface TabSummary {
  id: string;
  label: string;
  type: string;
  enabled: boolean;
  real_trading_enabled: boolean;
  starting_capital: number;
  max_step_pct: number;
  use_real_prices: boolean;
}

export interface StrategyLogRow {
  Date: string;
  Session?: string;
  Regime_Tier: number;
  "Recommended_QQQ_%": number;
  "Recommended_USO_%": number;
  "Recommended_GLD_%": number;
  "Recommended_CASH_%"?: number;
  Current_Portfolio_Value?: number;
  QQQ_Price?: number;
  USO_Price?: number;
  GLD_Price?: number;
  Rationale_Summary?: string;
  Gold_Oil_Ratio?: number;
  Key_Signals?: string;
  Suggested_Action?: string;
  Rebalance_Note?: string;
}

export interface TradeRow {
  Timestamp?: string;
  Date: string;
  Session: string;
  Symbol: string;
  Side: string;
  Shares: number;
  Price: number;
  Notional: number;
  Reason?: string;
}

export interface EquitySnapshot {
  Date: string;
  Session: string;
  Total_Value: number;
  Cash: number;
  QQQ_pct: number;
  USO_pct: number;
  GLD_pct: number;
  Return_pct: number;
  Tier: number;
}

export interface ChartPoint {
  date?: string;
  session?: string;
  time?: string;
  value: number;
  returnPct?: number;
  ts: number;
}

export interface LlmReport {
  id?: number;
  tab_id?: string;
  date: string;
  session: string;
  filename?: string | null;
  text: string;
  created_at?: string;
}

export interface JobRun {
  id: number;
  started_at: string;
  finished_at: string;
  duration_s: number;
  session: string;
  tab_id: string;
  status: string;
  tier?: number | null;
  strength?: number | null;
  action?: string | null;
  paper_enabled?: number | boolean;
  llm_status?: string | null;
  trade_count: number;
  portfolio_value?: number | null;
  error_message?: string | null;
  report_file?: string | null;
  llm_report_id?: number | null;
}

export interface ScheduleJob {
  session: string;
  time: string;
  purpose: string;
  due?: boolean;
  completedToday?: boolean;
  running?: boolean;
  nextRun?: string | null;
  lastRun?: unknown;
}

export interface SchedulerStatus {
  enabled: boolean;
  timezone?: string;
  tickMs?: number;
  retryMs?: number;
  startedAt?: string | null;
  lastCheckAt?: string | null;
  activeSession?: string | null;
  jobs?: ScheduleJob[];
}

export interface RegimeView {
  tier: number;
  name: string;
  description: string;
  targets: Record<string, number>;
  recommended: Record<string, number>;
  rationale: string;
  keySignals: string;
  logDate: string | null;
  session: string | null;
  suggestedAction: string;
  rebalanceNote: string;
  todayOpen: StrategyLogRow | null;
  todayClose: StrategyLogRow | null;
  llmReport?: LlmReport | null;
}

export interface TabData {
  enabled: boolean;
  realTradingEnabled: boolean;
  startingCapital: number;
  startedAt: string | null;
  returnPct: number;
  returnDollar: number;
  tradeCount: number;
  trades: TradeRow[];
  equity: EquitySnapshot[];
  chartSeries: ChartPoint[];
  portfolio: PortfolioView;
  drift: {
    vsRecommended: DriftRow[];
    vsTier: DriftRow[];
    maxDrift: number;
    rebalanceNeeded: boolean;
  };
  regime: RegimeView;
  log: StrategyLogRow[];
}

export interface DashboardPayload {
  generatedAt: string;
  tabData: Record<string, TabData>;
  tabs: TabSummary[];
  regime: RegimeView;
  schedule: SchedulerStatus;
  market: {
    quotes: Record<string, Quote>;
    goldOilRatioEtf: number | null;
    goldOilRatioSpot: number | null;
  };
  tiers: TierDefinitions;
  jobRuns: JobRun[];
}
