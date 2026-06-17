#!/usr/bin/env python3
"""Daily 3-tier regime job — run at market open and market close."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

import db as _db
from paper_trade import (  # noqa: E402
    execute_rebalance,
    is_enabled as paper_enabled,
    load_portfolio as load_paper_portfolio,
    portfolio_value as paper_portfolio_value,
    portfolio_weights as paper_portfolio_weights,
)

PORTFOLIO_PATH = ROOT / "data" / "portfolio.json"
TIERS_PATH = ROOT / "data" / "tiers.json"
REPORTS_DIR = ROOT / "logs" / "reports"
JOBS_LOG = ROOT / "logs" / "jobs.log"

ASSETS = ["QQQ", "USO", "GLD"]
QUOTE_SYMBOLS = ["QQQ", "USO", "GLD", "^VIX", "CL=F", "GC=F", "BTC-USD"]
SESSIONS = {"open", "close"}

ET_TZ = ZoneInfo("America/New_York")

# How old a cached quote can be before we force a fresh Yahoo fetch (seconds)
QUOTE_MAX_AGE_S = 8 * 60  # 8 minutes


# ---------------------------------------------------------------------------
# Quote fetching — writes to DB, reads from DB as cache
# ---------------------------------------------------------------------------

def _live_quote_from_db(symbol: str) -> dict | None:
    """
    Return a cached quote row if it exists, is from MCP, and is fresh.
    MCP prices are never auto-expired here — they were explicitly pushed.
    The staleness guard is only for Yahoo-sourced rows.
    """
    conn = _db.get_conn()
    row = conn.execute(
        "SELECT * FROM quotes WHERE symbol=?", (symbol,)
    ).fetchone()
    if row is None:
        return None
    row = dict(row)
    if row["source"] == "mcp":
        # MCP prices: trust them (they were explicitly pushed by the operator)
        return row
    # Yahoo prices: check age
    try:
        age = (datetime.now(ET_TZ) - datetime.fromisoformat(row["fetched_at"])).total_seconds()
        if age > QUOTE_MAX_AGE_S:
            return None
    except Exception:
        return None
    return row


def fetch_quote(symbol: str) -> dict:
    cached = _live_quote_from_db(symbol)
    if cached:
        return {
            "symbol": symbol,
            "price": round(float(cached["price"]), 2),
            "change_pct": round(float(cached["change_pct"]), 2),
            "market_state": cached["market_state"],
        }

    url = (
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{urllib.request.quote(symbol)}?interval=1d&range=5d"
    )
    req = urllib.request.Request(url, headers={"User-Agent": "regime-dashboard/0.1"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.load(resp)
    meta = data["chart"]["result"][0]["meta"]
    price = meta.get("regularMarketPrice") or meta.get("previousClose")
    prev = meta.get("chartPreviousClose") or meta.get("previousClose") or price
    change_pct = ((price - prev) / prev * 100) if prev else 0.0
    return {
        "symbol": symbol,
        "price": round(float(price), 2),
        "change_pct": round(float(change_pct), 2),
        "market_state": meta.get("marketState", "UNKNOWN"),
    }


def fetch_quotes() -> dict[str, dict]:
    quotes = {}
    for sym in QUOTE_SYMBOLS:
        try:
            quotes[sym] = fetch_quote(sym)
        except Exception as exc:  # noqa: BLE001
            print(f"warn: quote failed for {sym}: {exc}", file=sys.stderr)
    # Persist all fetched quotes to DB (Yahoo-sourced ones update fetched_at)
    _db.upsert_quotes_batch(quotes)
    return quotes


# ---------------------------------------------------------------------------
# Portfolio helpers
# ---------------------------------------------------------------------------

def load_portfolio() -> dict:
    if paper_enabled():
        return load_paper_portfolio()
    if not PORTFOLIO_PATH.exists():
        return {"cash": 0, "holdings": []}
    return json.loads(PORTFOLIO_PATH.read_text())


def portfolio_value(portfolio: dict, quotes: dict) -> float:
    total = float(portfolio.get("cash") or 0)
    for h in portfolio.get("holdings", []):
        sym = h.get("symbol")
        shares = float(h.get("shares") or 0)
        price = quotes.get(sym, {}).get("price", 0)
        total += shares * price
    return round(total, 2)


def portfolio_weights(portfolio: dict, quotes: dict) -> dict[str, float]:
    values = {}
    for sym in ASSETS:
        h = next((x for x in portfolio.get("holdings", []) if x.get("symbol") == sym), None)
        shares = float(h.get("shares") or 0) if h else 0.0
        price = quotes.get(sym, {}).get("price", 0)
        values[sym] = shares * price
    total = sum(values.values()) + float(portfolio.get("cash") or 0)
    if total <= 0:
        return {sym: 0.0 for sym in ASSETS}
    return {sym: round(values[sym] / total * 100, 1) for sym in ASSETS}


# ---------------------------------------------------------------------------
# Strategy log
# ---------------------------------------------------------------------------

def load_log_rows(tab_id: str = "paper") -> list[dict]:
    return _db.load_strategy_log(tab_id)


def append_log_row(row: dict, tab_id: str = "paper") -> None:
    _db.insert_strategy_log(row, tab_id)


# ---------------------------------------------------------------------------
# Regime logic
# ---------------------------------------------------------------------------

def find_previous(rows: list[dict], today: str, session: str) -> dict | None:
    session_rank = {"Open": 0, "Close": 1}
    target_rank = session_rank.get(session.capitalize(), 0) - 1
    same_day = [r for r in rows if r.get("Date") == today]
    if target_rank >= 0:
        for r in reversed(same_day):
            if r.get("Session", "").lower() == "open":
                return r
    prior = [r for r in rows if r.get("Date", "") < today]
    if not prior:
        return None
    latest_date = max(r["Date"] for r in prior)
    day_rows = [r for r in prior if r["Date"] == latest_date]
    for sess in ("Close", "Open"):
        for r in day_rows:
            if r.get("Session", "").lower() == sess.lower():
                return r
    return day_rows[-1]


def score_regime(quotes: dict) -> tuple[int, float, list[str]]:
    """Return (tier, signal_strength_0_to_1, signal_list).

    signal_strength is a 0–1 score indicating how strongly we're at the
    extreme of the chosen tier (0.5 = neutral mid-tier, 1.0 = maximum
    conviction). Used by tier_targets() to pick a point within the range.
    """
    vix = quotes.get("^VIX", {}).get("price", 20)
    qqq_chg = quotes.get("QQQ", {}).get("change_pct", 0)
    uso_chg = quotes.get("USO", {}).get("change_pct", 0)
    gld_chg = quotes.get("GLD", {}).get("change_pct", 0)
    btc_chg = quotes.get("BTC-USD", {}).get("change_pct", 0)
    wti = quotes.get("CL=F", {}).get("price", 0)

    risk_on = 0
    risk_off = 0
    max_possible = 8  # maximum total risk_on or risk_off score
    signals = []

    if vix < 17:
        risk_on += 2
        signals.append(f"VIX_low={vix}")
    elif vix < 20:
        risk_on += 1
    elif vix > 25:
        risk_off += 2
        signals.append(f"VIX_high={vix}")
    elif vix > 20:
        risk_off += 1

    if qqq_chg > 0.5:
        risk_on += 1
    elif qqq_chg < -0.5:
        risk_off += 1
    signals.append(f"QQQ_1D={qqq_chg:+.2f}%")

    if uso_chg < -2:
        risk_on += 1
        signals.append("oil_unwind")
    elif uso_chg > 2:
        risk_off += 1
        signals.append("oil_spike")

    if gld_chg > 0.5 and qqq_chg < 0:
        risk_off += 1
        signals.append("gold_bid_equity_soft")

    if btc_chg < -1.5:
        risk_off += 1
    elif btc_chg > 1.5:
        risk_on += 1
    signals.append(f"BTC_1D={btc_chg:+.2f}%")
    signals.append(f"WTI={wti}")

    gap = risk_on - risk_off
    if risk_off >= risk_on + 2:
        tier = 3
        # strength: how far into risk-off range (0.5 = just tipped, 1.0 = maximum)
        strength = min(1.0, 0.5 + (risk_off - risk_on - 2) / (max_possible * 0.5))
    elif risk_on >= risk_off + 2:
        tier = 1
        strength = min(1.0, 0.5 + (risk_on - risk_off - 2) / (max_possible * 0.5))
    else:
        tier = 2
        # strength at Tier 2 = 0.5 at center, approaches 0 or 1 at edges
        strength = 0.5 + gap / 4.0  # ranges roughly 0.25–0.75

    confidence = "high" if strength >= 0.75 else "medium"
    return tier, strength, signals


def tier_targets(tier: int, strength: float = 0.5) -> dict[str, int]:
    """Pick concrete targets within the tier's ranges based on signal strength.

    For Tier 1: strength near 1.0 → max QQQ, possibly 0% USO (strong risk-on, no oil).
    For Tier 3: strength near 1.0 → max GLD, max CASH, min equities.
    strength is clamped to [0, 1].

    Returns a dict with QQQ, USO, GLD, CASH summing to exactly 100.
    """
    tiers = json.loads(TIERS_PATH.read_text())
    t = tiers.get(str(tier), tiers["2"])
    ranges = t.get("ranges", {})
    defaults = t["targets"]

    if not ranges:
        return defaults

    strength = max(0.0, min(1.0, strength))

    # For Tier 1: strength drives toward max QQQ, minimum USO/GLD/CASH
    # For Tier 3: strength drives toward max GLD/CASH, minimum QQQ/USO
    # For Tier 2: strength 0.5 → defaults; 0 → more defensive, 1 → more aggressive

    def pick(sym: str, toward_max: bool) -> int:
        r = ranges.get(sym, {})
        lo, hi = r.get("min", defaults[sym]), r.get("max", defaults[sym])
        if toward_max:
            raw = lo + (hi - lo) * strength
        else:
            raw = hi - (hi - lo) * strength
        return int(round(raw))

    if tier == 1:
        # High strength = strong risk-on: max QQQ, minimal oil and gold and cash
        qqq  = pick("QQQ",  toward_max=True)
        uso  = pick("USO",  toward_max=False)
        gld  = pick("GLD",  toward_max=False)
        cash = pick("CASH", toward_max=False)
    elif tier == 3:
        # High strength = strong risk-off: max GLD, max cash, minimal equities
        gld  = pick("GLD",  toward_max=True)
        cash = pick("CASH", toward_max=True)
        qqq  = pick("QQQ",  toward_max=False)
        uso  = pick("USO",  toward_max=False)
    else:
        # Tier 2: use defaults, nudge slightly by strength (strength > 0.5 = slight risk-on lean)
        qqq  = pick("QQQ",  toward_max=(strength >= 0.5))
        uso  = pick("USO",  toward_max=False)
        gld  = pick("GLD",  toward_max=(strength < 0.5))
        cash = pick("CASH", toward_max=(strength < 0.5))

    # Clamp all to their stated ranges and ensure non-negative
    def clamp(sym: str, val: int) -> int:
        r = ranges.get(sym, {})
        return max(r.get("min", 0), min(r.get("max", 100), max(0, val)))

    qqq, uso, gld, cash = clamp("QQQ", qqq), clamp("USO", uso), clamp("GLD", gld), clamp("CASH", cash)

    # Reconcile to exactly 100 by adjusting in priority order.
    # Priority: absorbers are listed first; USO is listed last so a deliberate USO=0 is not overridden.
    # For Tier 1: CASH is the preferred absorber (keeps USO/GLD/QQQ at their signal-driven values).
    # For Tier 3: CASH is the preferred absorber.
    # For Tier 2: QQQ absorbs first.
    if tier == 1:
        absorbers = ["CASH", "QQQ", "GLD", "USO"]
    elif tier == 3:
        absorbers = ["CASH", "GLD", "QQQ", "USO"]
    else:
        absorbers = ["QQQ", "CASH", "GLD", "USO"]

    total = qqq + uso + gld + cash
    diff = 100 - total
    if diff != 0:
        vals = {"QQQ": qqq, "USO": uso, "GLD": gld, "CASH": cash}
        for sym_name in absorbers:
            r = ranges.get(sym_name, {})
            adjusted = vals[sym_name] + diff
            lo = r.get("min", 0)
            # Absorbers are allowed to exceed their stated max by up to 20% to reconcile
            hi = r.get("max", 100) + 20
            if lo <= adjusted <= hi:
                vals[sym_name] = max(0, adjusted)
                break
        else:
            vals["CASH"] = max(0, vals["CASH"] + diff)
        qqq, uso, gld, cash = vals["QQQ"], vals["USO"], vals["GLD"], vals["CASH"]

    return {"QQQ": qqq, "USO": uso, "GLD": gld, "CASH": cash}


def validate_targets(targets: dict) -> dict:
    """Validate and sanitise a targets dict (e.g. from LLM output).

    Rules:
    - All values must be >= 0
    - CASH is added implicitly if missing (remainder to 100)
    - Total across QQQ+USO+GLD+CASH must equal 100 (±1 rounding tolerance)
    - Returns a cleaned dict, or raises ValueError if unrecoverable.
    """
    clean = {}
    for sym in ASSETS:
        v = targets.get(sym, 0)
        if v < 0:
            raise ValueError(f"Target for {sym} is negative: {v}")
        clean[sym] = int(round(float(v)))

    asset_sum = sum(clean[s] for s in ASSETS)

    # Handle explicit CASH key
    cash_explicit = targets.get("CASH")
    if cash_explicit is not None:
        cash = int(round(float(cash_explicit)))
        if cash < 0:
            raise ValueError(f"Target for CASH is negative: {cash}")
        total = asset_sum + cash
        if abs(total - 100) > 2:
            raise ValueError(f"Targets sum to {total}, must be 100 (±2): {targets}")
        # Absorb rounding into CASH
        clean["CASH"] = cash + (100 - total)
    else:
        # Infer CASH as remainder
        cash = 100 - asset_sum
        if cash < 0:
            raise ValueError(f"Asset targets sum to {asset_sum} > 100: {targets}")
        clean["CASH"] = cash

    return clean


def suggest_action(
    session: str,
    weights: dict[str, float],
    targets: dict[str, int],
    previous: dict | None,
    tier: int,
) -> tuple[str, str]:
    # Compute cash weight as 100 - sum(invested assets)
    cash_actual = round(max(0.0, 100.0 - sum(weights.get(s, 0) for s in ASSETS)), 1)
    all_targets = {**targets}
    if "CASH" not in all_targets:
        all_targets["CASH"] = 0

    all_symbols = ASSETS + ["CASH"]
    actual_map = {**{s: round(weights.get(s, 0), 1) for s in ASSETS}, "CASH": cash_actual}

    drifts = {sym: round(actual_map.get(sym, 0) - all_targets[sym], 1) for sym in all_symbols}
    max_drift = max(abs(v) for v in drifts.values())
    has_positions = any(abs(weights.get(sym, 0)) > 0.01 for sym in ASSETS)

    if not has_positions:
        return "Initialize", f"{session.capitalize()}: build toward Tier {tier} targets in <=5% daily steps"

    if max_drift <= 5:
        note = f"{session.capitalize()}: within 5% drift band — hold"
        if previous and str(previous.get("Regime_Tier")) != str(tier):
            note += f" (tier changed {previous.get('Regime_Tier')}→{tier}, but drift acceptable)"
        return "Hold", note

    moves = []
    for sym in all_symbols:
        drift = drifts[sym]
        if abs(drift) <= 5:
            continue
        step = min(abs(drift), 10)
        direction = "trim" if drift > 0 else ("hold cash" if sym == "CASH" and drift < 0 else "add")
        if sym == "CASH":
            direction = "reduce cash" if drift > 0 else "build cash buffer"
        moves.append(f"{direction} {sym} ~{step:.0f}%")

    action = "Rebalance"
    note = f"{session.capitalize()}: " + "; ".join(moves) if moves else f"{session.capitalize()}: rebalance toward Tier {tier}"
    return action, note


def build_rationale(tier: int, confidence: str, session: str, signals: list[str]) -> str:
    names = {1: "Risk-On", 2: "Balanced", 3: "Risk-Off"}
    sess = "pre-open positioning" if session == "open" else "end-of-day confirmation"
    return (
        f"Tier {tier} ({names[tier]}, {confidence} confidence) at market {session} — {sess}. "
        f"Signals: {', '.join(signals[:6])}. "
        "BTC-sovereign overlay: maintain GLD/USO hedges unless VIX<17 and oil stable."
    )


# ---------------------------------------------------------------------------
# LLM + reporting
# ---------------------------------------------------------------------------

def write_report(text: str, today: str, session: str,
                 tab_id: str = "paper") -> tuple[Path, int]:
    """Insert LLM report into DB and write to disk. Returns (path, llm_report_id)."""
    filename = f"{today}_{session}.md"
    report_id = _db.insert_llm_report(tab_id, today, session, text, filename)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORTS_DIR / filename
    path.write_text(text)
    print(report_id)
    return path, report_id


def log_job(message: str) -> None:
    """Append a human-readable line to logs/jobs.log (kept for ops visibility)."""
    JOBS_LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(ET_TZ).strftime("%Y-%m-%d %H:%M:%S %Z")
    with JOBS_LOG.open("a") as f:
        f.write(f"[{stamp}] {message}\n")


def record_job_run(
    started_at: datetime,
    session: str,
    status: str = "ok",
    tier: int | None = None,
    strength: float | None = None,
    action: str | None = None,
    paper_on: bool = False,
    llm_status: str | None = None,
    trade_count: int = 0,
    portfolio_value: float | None = None,
    error_message: str | None = None,
    report_file: str | None = None,
    llm_report_id: str | None = None
) -> None:
    """Write a structured job run record to the job_runs table."""
    finished = datetime.now(ET_TZ)
    duration = (finished - started_at).total_seconds()
    _db.insert_job_run({
        "started_at":      started_at.isoformat(),
        "finished_at":     finished.isoformat(),
        "duration_s":      round(duration, 2),
        "session":         session,
        "tab_id":          "paper",
        "status":          status,
        "tier":            tier,
        "strength":        round(strength, 3) if strength is not None else None,
        "action":          action,
        "paper_enabled":   paper_on,
        "llm_status":      llm_status,
        "trade_count":     trade_count,
        "portfolio_value": portfolio_value,
        "error_message":   error_message,
        "report_file":     report_file,
        llm_report_id: llm_report_id
    })


def load_agent_prompt() -> str:
    p = ROOT / "scripts" / "daily_regime_agent_prompt.txt"
    if p.exists():
        return p.read_text().strip()
    return (
        "You are a disciplined macro regime agent. "
        "Produce the Daily 3-Tier Regime Report using the provided data and news context."
    )


def fetch_news_headlines(limit: int = 6) -> list[str]:
    """Lightweight no-key RSS fetch for recent macro-relevant headlines (robust parse)."""
    terms = "fed+OR+geopolitics+OR+oil+OR+gold+OR+inflation+OR+recession+OR+vix+OR+nasdaq+equities"
    url = f"https://news.google.com/rss/search?q={terms}&hl=en-US&gl=US&ceid=US:en"
    headlines: list[str] = []
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "regime-dashboard/0.1"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            data = resp.read()
        text = data.decode("utf-8", errors="ignore")
        try:
            root = ET.fromstring(data)
            for item in root.findall(".//item")[: limit * 2]:
                title_el = item.find("title")
                if title_el is not None and title_el.text:
                    t = title_el.text.strip()
                    low = t.lower()
                    if any(k in low for k in ["fed", "oil", "gold", "vix", "nasdaq", "inflation", "geopolit", "china", "tariff", "recession", "equit", "market", "crude"]):
                        headlines.append(t)
                        if len(headlines) >= limit:
                            break
            if not headlines:
                for item in root.findall(".//item")[:limit]:
                    title_el = item.find("title")
                    if title_el is not None and title_el.text:
                        headlines.append(title_el.text.strip())
        except Exception:
            titles = re.findall(r"<title>([^<]+)</title>", text)
            for t in titles[1: limit + 1]:
                headlines.append(t.strip())
    except Exception as exc:  # noqa: BLE001
        print(f"warn: news fetch failed: {exc}", file=sys.stderr)
    return headlines[:limit]


def call_xai_for_report(
    tab_id: str,
    session: str,
    structured: dict,
    prev_row: dict | None,
    headlines: list[str],
    system_prompt: str,
) -> str:
    """Call Grok directly via xAI API. Requires XAI_API_KEY in env."""
    api_key = os.environ.get("XAI_API_KEY") or os.environ.get("xai_api_key")
    if not api_key:
        return "LLM_CALL_SKIPPED: no XAI_API_KEY in environment."
    model = os.environ.get("XAI_MODEL", "grok-3-latest")
    base_url = "https://api.x.ai/v1/chat/completions"

    user_content = (
        f"Tab: {tab_id}\nSession: {session}\nDate: {structured.get('date')}\n\n"
        "STRUCTURED_DATA:\n"
        f"{json.dumps(structured, indent=2)}\n\n"
    )
    if prev_row:
        user_content += f"PREVIOUS_LOG_ROW:\n{json.dumps(prev_row, indent=2)}\n\n"
    if headlines:
        user_content += "RECENT_NEWS_HEADLINES:\n" + "\n".join(f"- {h}" for h in headlines) + "\n\n"
    user_content += (
        "Embody the full agent prompt. Generate the Daily 3-Tier Regime Report. "
        "Use news context for richer rationale. At the end include the exact machine-readable "
        "```json block with tier/targets/action/trades (empty trades list if Hold)."
    )

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.35,
        "max_tokens": 1600,
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        base_url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": "macro-regime-job/1.0",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=50) as resp:
            resp_data = json.loads(resp.read().decode("utf-8"))
        content = resp_data["choices"][0]["message"]["content"]
        return content.strip()
    except Exception as exc:  # noqa: BLE001
        return f"LLM_CALL_ERROR: {exc}"


def parse_llm_trades(text: str) -> list[dict]:
    """Extract suggested trades from the LLM's final JSON block if present."""
    m = re.search(r"```json\s*(\{.*?\})\s*```", text, re.DOTALL | re.IGNORECASE)
    if not m:
        m = re.search(r"\{[\s\S]*?\"trades\"[\s\S]*?\}", text)
    if not m:
        return []
    try:
        raw = m.group(1) if m.lastindex else m.group(0)
        obj = json.loads(raw)
        trades = obj.get("trades") or []
        return [
            t
            for t in trades
            if isinstance(t, dict) and t.get("symbol") in ("QQQ", "USO", "GLD") and t.get("side") in ("BUY", "SELL")
        ]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Main run
# ---------------------------------------------------------------------------

def run(session: str) -> int:
    session = session.lower()
    if session not in SESSIONS:
        print(f"Invalid session: {session}", file=sys.stderr)
        return 1

    job_started_at = datetime.now(ET_TZ)
    now = job_started_at
    today = now.strftime("%Y-%m-%d")
    session_label = session.capitalize()

    # Minimal tab awareness from DB
    try:
        tab_list = _db.load_tab_config()
        tab_ids = [t.get("tab_id") for t in tab_list]
        log_job(f"config tabs: {tab_ids}")
    except Exception:
        tab_list = []
        log_job("config tabs: load failed (using paper fallback)")

    # Fetch fresh quotes — Yahoo for stale/missing, DB cache for fresh MCP prices
    quotes = fetch_quotes()
    if not all(sym in quotes for sym in ASSETS):
        log_job(f"FAIL {session_label}: missing core quotes")
        record_job_run(job_started_at, session_label, status="fail",
                       error_message="missing core quotes")
        return 1

    portfolio = load_portfolio()
    total_value = portfolio_value(portfolio, quotes)
    weights = portfolio_weights(portfolio, quotes)
    rows = load_log_rows("paper")

    tier, strength, signals = score_regime(quotes)
    confidence = "high" if strength >= 0.75 else "medium"
    targets = tier_targets(tier, strength)
    previous = find_previous(rows, today, session_label)
    action, rebalance_note = suggest_action(session_label, weights, targets, previous, tier)

    trade_summary = ""
    if paper_enabled() and action in ("Initialize", "Rebalance"):
        portfolio, trades = execute_rebalance(
            portfolio, quotes, targets, session_label, tier, action
        )
        if trades:
            parts = [f"{t['Side']} {t['Symbol']} ${t['Notional']:,.0f}" for t in trades]
            trade_summary = "Paper: " + ", ".join(parts)
            rebalance_note = f"{rebalance_note}. {trade_summary}"
        else:
            trade_summary = "Paper: no trades (cash/limits)"
        total_value = paper_portfolio_value(portfolio, quotes)
        weights = paper_portfolio_weights(portfolio, quotes)

    gld = quotes["GLD"]["price"]
    uso = quotes["USO"]["price"]
    gold_spot = quotes.get("GC=F", {}).get("price", 0)
    wti = quotes.get("CL=F", {}).get("price", 0)
    gold_oil = round(gold_spot / wti, 2) if gold_spot and wti else ""

    log_row = {
        "Date": today,
        "Session": session_label,
        "Regime_Tier": tier,
        "Recommended_QQQ_%": targets["QQQ"],
        "Recommended_USO_%": targets["USO"],
        "Recommended_GLD_%": targets["GLD"],
        "Recommended_CASH_%": targets.get("CASH", 0),
        "Current_Portfolio_Value": total_value if total_value else "",
        "QQQ_Price": quotes["QQQ"]["price"],
        "USO_Price": quotes["USO"]["price"],
        "GLD_Price": gld,
        "Rationale_Summary": build_rationale(tier, confidence, session, signals),
        "Gold_Oil_Ratio": gold_oil,
        "Key_Signals": "; ".join(signals),
        "Suggested_Action": action,
        "Rebalance_Note": rebalance_note,
    }
    append_log_row(log_row, "paper")

    prev_line = ""
    if previous:
        prev_line = (
            f"\nPrior ({previous.get('Date')} {previous.get('Session')}): "
            f"Tier {previous.get('Regime_Tier')} — "
            f"QQQ {previous.get('Recommended_QQQ_%')}% / "
            f"USO {previous.get('Recommended_USO_%')}% / "
            f"GLD {previous.get('Recommended_GLD_%')}%"
        )

    paper_line = f"- Paper trades: {trade_summary}\n" if trade_summary else ""
    quant_report = f"""# Daily 3-Tier Regime Report — {today} ({session_label})

## Regime
- **Tier {tier}** ({confidence} confidence)
- **Action:** {action}
- {rebalance_note}

## Recommended Allocation
| Asset | Target % |
|-------|----------|
| QQQ | {targets['QQQ']}% |
| USO | {targets['USO']}% |
| GLD | {targets['GLD']}% |
| CASH | {targets.get('CASH', 0)}% |

## Portfolio
- Value: ${total_value:,.0f}
- Weights: QQQ {weights['QQQ']}% · USO {weights['USO']}% · GLD {weights['GLD']}%
{paper_line}{prev_line}

## Market
- QQQ ${quotes['QQQ']['price']} ({quotes['QQQ']['change_pct']:+.2f}%)
- USO ${quotes['USO']['price']} ({quotes['USO']['change_pct']:+.2f}%)
- GLD ${gld} ({quotes['GLD']['change_pct']:+.2f}%)
- VIX {quotes.get('^VIX', {}).get('price', '—')}
- Gold/Oil {gold_oil}

## Rationale
{log_row['Rationale_Summary']}
"""

    agent_prompt = load_agent_prompt()
    headlines = fetch_news_headlines()
    llm_structured = {
        "date": today,
        "tab": "paper",
        "session": session_label,
        "prices": {sym: {"price": q["price"], "change_pct": q.get("change_pct", 0)} for sym, q in quotes.items()},
        "portfolio_value": total_value,
        "cash": portfolio.get("cash", 0),
        "holdings": portfolio.get("holdings", []),
        "current_allocation": {sym: round(weights.get(sym, 0), 1) for sym in ASSETS},
        "gold_oil_ratio": gold_oil,
        "vix": quotes.get("^VIX", {}).get("price"),
        "key_signals": signals,
        "quant_tier": tier,
        "quant_targets": targets,
        "quant_action": action,
        "quant_note": rebalance_note,
    }
    llm_text = call_xai_for_report("paper", session_label, llm_structured, previous, headlines, agent_prompt)

    # If LLM suggested specific trades, apply them (with validation)
    llm_trades = parse_llm_trades(llm_text)
    if llm_trades and paper_enabled():
        llm_tier = tier
        llm_targets = targets
        try:
            blk = re.search(r"```json\s*(\{.*?\})\s*```", llm_text, re.DOTALL | re.IGNORECASE)
            if blk:
                obj = json.loads(blk.group(1))
                if isinstance(obj.get("tier"), int):
                    llm_tier = int(obj["tier"])
                if isinstance(obj.get("targets"), dict):
                    raw = {k: v for k, v in obj["targets"].items()
                           if k in ASSETS + ["CASH"]}
                    llm_targets = validate_targets(raw)
        except (ValueError, Exception) as e:
            log_job(f"LLM targets rejected ({e}); using quant targets")
            llm_targets = targets
        portfolio, extra = execute_rebalance(portfolio, quotes, llm_targets, session_label, llm_tier, "Rebalance")
        if extra:
            parts = [f"{t['Side']} {t['Symbol']} ${t['Notional']:,.0f}" for t in extra]
            rebalance_note = f"{rebalance_note}. LLM-applied: " + ", ".join(parts)
            total_value = paper_portfolio_value(portfolio, quotes)
            weights = paper_portfolio_weights(portfolio, quotes)

    if llm_text.startswith("LLM_CALL_SKIPPED") or llm_text.startswith("LLM_CALL_ERROR"):
        report = quant_report
        llm_status = "skipped" if llm_text.startswith("LLM_CALL_SKIPPED") else "error"
        log_job(f"LLM fallback for {session_label} (no key or error)")
    else:
        report = llm_text
        llm_status = "direct"

    # Count trades that happened in this run (trades written since job_started_at)
    conn = _db.get_conn()
    run_trade_count = conn.execute(
        "SELECT COUNT(*) FROM trades WHERE tab_id='paper' AND timestamp >= ?",
        (job_started_at.isoformat(),)
    ).fetchone()[0]

    report_path = write_report(report, today, session, "paper")[0]
    report_id = write_report(report, today, session, "paper")[1]
    paper_tag = " paper=on" if paper_enabled() else ""
    llm_tag = f" llm={llm_status}"
    log_job(f"OK {session_label}: tier={tier} action={action}{paper_tag}{llm_tag} report={report_path}")
    record_job_run(
        job_started_at, session_label,
        status="ok",
        tier=tier,
        strength=strength,
        action=action,
        paper_on=paper_enabled(),
        llm_status=llm_status,
        trade_count=run_trade_count,
        portfolio_value=total_value,
        report_file=report_path,
        llm_report_id=report_id
    )
    print(report)

    print("\nSTRUCTURED_DATA_FOR_PROMPT:")
    print(json.dumps(llm_structured, indent=2))

    # Generate report for "real" tab
    try:
        real_tab = next((t for t in tab_list if t.get("tab_id") == "real"), None)
        if real_tab:
            real_p = ROOT / "data" / "real_portfolio.json"
            real_port = {"cash": 0, "holdings": []}
            if real_p.exists():
                real_port = json.loads(real_p.read_text())
            real_val = portfolio_value(real_port, quotes)
            real_w = portfolio_weights(real_port, quotes)
            real_struct = {
                "date": today,
                "tab": "real",
                "session": session_label,
                "prices": llm_structured["prices"],
                "portfolio_value": real_val,
                "cash": real_port.get("cash", 0),
                "holdings": real_port.get("holdings", []),
                "current_allocation": {sym: round(real_w.get(sym, 0), 1) for sym in ASSETS},
                "gold_oil_ratio": gold_oil,
                "vix": llm_structured["vix"],
                "key_signals": signals,
                "quant_tier": tier,
                "quant_targets": targets,
                "quant_action": "Observe (real trading disabled)",
                "quant_note": "Real tab report only — no auto trades while real_trading_enabled=false",
            }
            real_llm = call_xai_for_report("real", session_label, real_struct, previous, headlines, agent_prompt)
            if not real_llm.startswith("LLM_"):
                real_report_path = write_report(real_llm, today, f"{session}_real", "real")
                log_job(f"OK {session_label}: real tab LLM report written ({real_report_path.name})")
            else:
                real_fallback = (
                    f"# Daily 3-Tier Regime Report — {today} ({session_label}) — real tab\n\n"
                    "(Direct LLM call skipped or errored; using quant signals.)\n\n"
                    f"## Regime\n- Tier {tier}\n\n## Allocation targets\n{targets}\n\n"
                    f"## Current real portfolio value\n${real_val:,.0f}\n"
                )
                write_report(real_fallback, today, f"{session}_real", "real")
    except Exception as e:
        log_job(f"real tab report skipped: {e}")

    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Run 3-tier regime job")
    parser.add_argument("--session", required=True, choices=sorted(SESSIONS))
    args = parser.parse_args()
    return run(args.session)


if __name__ == "__main__":
    raise SystemExit(main())
