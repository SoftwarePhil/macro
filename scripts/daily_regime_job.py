#!/usr/bin/env python3
"""Daily 3-tier regime job — run at market open and market close."""

from __future__ import annotations

import argparse
import csv
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
from paper_trade import (  # noqa: E402
    execute_rebalance,
    is_enabled as paper_enabled,
    load_portfolio as load_paper_portfolio,
    portfolio_value as paper_portfolio_value,
    portfolio_weights as paper_portfolio_weights,
)
HOME = ROOT.parent
STRATEGY_LOG = HOME / "strategy_log.csv"
PORTFOLIO_PATH = ROOT / "data" / "portfolio.json"
TIERS_PATH = ROOT / "data" / "tiers.json"
REPORTS_DIR = ROOT / "logs" / "reports"
JOBS_LOG = ROOT / "logs" / "jobs.log"

ASSETS = ["QQQ", "USO", "GLD"]
QUOTE_SYMBOLS = ["QQQ", "USO", "GLD", "^VIX", "CL=F", "GC=F", "BTC-USD"]
SESSIONS = {"open", "close"}

FIELDNAMES = [
    "Date",
    "Session",
    "Regime_Tier",
    "Recommended_QQQ_%",
    "Recommended_USO_%",
    "Recommended_GLD_%",
    "Current_Portfolio_Value",
    "QQQ_Price",
    "USO_Price",
    "GLD_Price",
    "Rationale_Summary",
    "Gold_Oil_Ratio",
    "Key_Signals",
    "Suggested_Action",
    "Rebalance_Note",
]

ET = ZoneInfo("America/New_York")


def load_live_quotes() -> dict:
    p = ROOT / "data" / "live_quotes.json"
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except Exception:
        return {}

def fetch_quote(symbol: str) -> dict:
    live = load_live_quotes()
    entry = live.get(symbol) or live.get(symbol.upper())
    if entry is not None:
        price = entry["price"] if isinstance(entry, dict) else entry
        change_pct = (entry.get("change_pct") or entry.get("changePct") or 0) if isinstance(entry, dict) else 0
        return {
            "symbol": symbol,
            "price": round(float(price), 2),
            "change_pct": round(float(change_pct), 2),
            "market_state": "LIVE_ROBINHOOD_MCP",
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
    return quotes


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


def load_log_rows() -> list[dict]:
    if not STRATEGY_LOG.exists():
        return []
    with STRATEGY_LOG.open(newline="") as f:
        return list(csv.DictReader(f))


def ensure_log_header() -> None:
    if not STRATEGY_LOG.exists():
        with STRATEGY_LOG.open("w", newline="") as f:
            csv.DictWriter(f, fieldnames=FIELDNAMES).writeheader()
        return
    with STRATEGY_LOG.open(newline="") as f:
        rows = list(csv.reader(f))
    if not rows:
        with STRATEGY_LOG.open("w", newline="") as f:
            csv.DictWriter(f, fieldnames=FIELDNAMES).writeheader()
        return
    header = rows[0]
    if header == FIELDNAMES:
        return
    # migrate legacy header
    legacy = rows[0]
    body = rows[1:]
    mapped = []
    for line in body:
        row = dict(zip(legacy, line))
        mapped.append(
            {
                "Date": row.get("Date", ""),
                "Session": row.get("Session", "Close"),
                "Regime_Tier": row.get("Regime_Tier", ""),
                "Recommended_QQQ_%": row.get("Recommended_QQQ_%", ""),
                "Recommended_USO_%": row.get("Recommended_USO_%", ""),
                "Recommended_GLD_%": row.get("Recommended_GLD_%", ""),
                "Current_Portfolio_Value": row.get("Current_Portfolio_Value", ""),
                "QQQ_Price": row.get("QQQ_Price", ""),
                "USO_Price": row.get("USO_Price", ""),
                "GLD_Price": row.get("GLD_Price", ""),
                "Rationale_Summary": row.get("Rationale_Summary", ""),
                "Gold_Oil_Ratio": row.get("Gold_Oil_Ratio", ""),
                "Key_Signals": row.get("Key_Signals", ""),
                "Suggested_Action": row.get("Suggested_Action", "Hold"),
                "Rebalance_Note": row.get("Rebalance_Note", ""),
            }
        )
    with STRATEGY_LOG.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        writer.writerows(mapped)


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
    # latest prior date, prefer Close over Open
    latest_date = max(r["Date"] for r in prior)
    day_rows = [r for r in prior if r["Date"] == latest_date]
    for sess in ("Close", "Open"):
        for r in day_rows:
            if r.get("Session", "").lower() == sess.lower():
                return r
    return day_rows[-1]


def score_regime(quotes: dict) -> tuple[int, str, list[str]]:
    """Return (tier, confidence_label, signal_list)."""
    vix = quotes.get("^VIX", {}).get("price", 20)
    qqq_chg = quotes.get("QQQ", {}).get("change_pct", 0)
    uso_chg = quotes.get("USO", {}).get("change_pct", 0)
    gld_chg = quotes.get("GLD", {}).get("change_pct", 0)
    btc_chg = quotes.get("BTC-USD", {}).get("change_pct", 0)
    wti = quotes.get("CL=F", {}).get("price", 0)

    risk_on = 0
    risk_off = 0
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

    if risk_off >= risk_on + 2:
        tier = 3
        confidence = "high" if risk_off >= risk_on + 3 else "medium"
    elif risk_on >= risk_off + 2:
        tier = 1
        confidence = "high" if risk_on >= risk_off + 3 else "medium"
    else:
        tier = 2
        confidence = "medium"

    return tier, confidence, signals


def tier_targets(tier: int) -> dict[str, int]:
    tiers = json.loads(TIERS_PATH.read_text())
    t = tiers.get(str(tier), tiers["2"])
    return t["targets"]


def suggest_action(
    session: str,
    weights: dict[str, float],
    targets: dict[str, int],
    previous: dict | None,
    tier: int,
) -> tuple[str, str]:
    drifts = {sym: round(weights.get(sym, 0) - targets[sym], 1) for sym in ASSETS}
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
    for sym in ASSETS:
        drift = drifts[sym]
        if abs(drift) <= 5:
            continue
        step = min(abs(drift), 10)
        direction = "trim" if drift > 0 else "add"
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


def append_log_row(row: dict) -> None:
    ensure_log_header()
    with STRATEGY_LOG.open("a", newline="") as f:
        csv.DictWriter(f, fieldnames=FIELDNAMES).writerow(row)


def write_report(text: str, today: str, session: str) -> Path:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = REPORTS_DIR / f"{today}_{session}.md"
    path.write_text(text)
    return path


def log_job(message: str) -> None:
    JOBS_LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(ET).strftime("%Y-%m-%d %H:%M:%S %Z")
    with JOBS_LOG.open("a") as f:
        f.write(f"[{stamp}] {message}\n")


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
        # Prefer XML parse
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
            # Regex fallback on titles (channel title is first)
            titles = re.findall(r"<title>([^<]+)</title>", text)
            for t in titles[1 : limit + 1]:
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
    """Call Grok directly via xAI API (no extra deps). Requires XAI_API_KEY in env."""
    api_key = os.environ.get("XAI_API_KEY") or os.environ.get("xai_api_key")
    if not api_key:
        return "LLM_CALL_SKIPPED: no XAI_API_KEY in environment. Export it before the job for direct calls from the script."
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
        "Use news context for richer rationale. At the end include the exact machine-readable ```json block with tier/targets/action/trades (empty trades list if Hold)."
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
        return f"LLM_CALL_ERROR: {exc}\n(Direct Grok call from script failed; using quant fallback. Verify key and connectivity.)"


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


def run(session: str) -> int:
    session = session.lower()
    if session not in SESSIONS:
        print(f"Invalid session: {session}", file=sys.stderr)
        return 1

    now = datetime.now(ET)
    today = now.strftime("%Y-%m-%d")
    session_label = session.capitalize()

    # Minimal tab awareness from config list (paper + real)
    try:
        cfg_raw = json.loads((ROOT / "data" / "paper_config.json").read_text() or "[]")
        tab_list = cfg_raw if isinstance(cfg_raw, list) else [cfg_raw]
        tab_ids = [t.get("id") for t in tab_list]
        log_job(f"config tabs: {tab_ids}")
    except Exception:
        tab_list = []
        log_job("config tabs: load failed (using paper fallback)")

    quotes = fetch_quotes()
    if not all(sym in quotes for sym in ASSETS):
        log_job(f"FAIL {session_label}: missing core quotes")
        return 1

    portfolio = load_portfolio()
    total_value = portfolio_value(portfolio, quotes)
    weights = portfolio_weights(portfolio, quotes)
    rows = load_log_rows()

    tier, confidence, signals = score_regime(quotes)
    targets = tier_targets(tier)
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

    row = {
        "Date": today,
        "Session": session_label,
        "Regime_Tier": tier,
        "Recommended_QQQ_%": targets["QQQ"],
        "Recommended_USO_%": targets["USO"],
        "Recommended_GLD_%": targets["GLD"],
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
    append_log_row(row)

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
{row['Rationale_Summary']}
"""

    # === Direct call to Grok from the script (no pasting) ===
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

    # If LLM suggested specific trades, apply them (LLM can steer beyond pure quant)
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
                    llm_targets = {k: int(v) for k, v in obj["targets"].items() if k in ASSETS}
        except Exception:
            pass
        portfolio, extra = execute_rebalance(portfolio, quotes, llm_targets, session_label, llm_tier, "Rebalance")
        if extra:
            parts = [f"{t['Side']} {t['Symbol']} ${t['Notional']:,.0f}" for t in extra]
            rebalance_note = f"{rebalance_note}. LLM-applied: " + ", ".join(parts)
            total_value = paper_portfolio_value(portfolio, quotes)
            weights = paper_portfolio_weights(portfolio, quotes)

    # Prefer the direct LLM report; fall back to quant if call was skipped/errored
    if llm_text.startswith("LLM_CALL_SKIPPED") or llm_text.startswith("LLM_CALL_ERROR"):
        report = quant_report
        log_job(f"LLM fallback for {session_label} (no key or error)")
    else:
        report = llm_text

    report_path = write_report(report, today, session)
    paper_tag = " paper=on" if paper_enabled() else ""
    llm_tag = " llm=direct" if not llm_text.startswith("LLM_") else " llm=skipped"
    log_job(f"OK {session_label}: tier={tier} action={action}{paper_tag}{llm_tag} report={report_path.name}")
    print(report)

    # Debug structured (for transparency / future multi-tab)
    print("\nSTRUCTURED_DATA_FOR_PROMPT:")
    print(json.dumps(llm_structured, indent=2))

    # Also generate a direct LLM report for the "real" tab (non-trading for now, just the intelligence layer + news)
    # This ensures every scheduled run calls Grok directly for all configured tabs.
    try:
        real_tab = next((t for t in tab_list if t.get("id") == "real"), None)
        if real_tab:
            real_p = ROOT / "data" / "real_portfolio.json"
            real_port = {"cash": 0, "holdings": []}
            if real_p.exists():
                real_port = json.loads(real_p.read_text())
            real_val = portfolio_value(real_port, quotes)  # reuse the local func (works for any)
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
                real_report_path = write_report(real_llm, today, f"{session}_real")
                log_job(f"OK {session_label}: real tab LLM report written ({real_report_path.name})")
            else:
                # still write a minimal real report so the tab has something
                real_fallback = f"# Daily 3-Tier Regime Report — {today} ({session_label}) — real tab\n\n(Direct LLM call skipped or errored; using quant signals.)\n\n## Regime\n- Tier {tier}\n\n## Allocation targets\n{targets}\n\n## Current real portfolio value\n${real_val:,.0f}\n"
                write_report(real_fallback, today, f"{session}_real")
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