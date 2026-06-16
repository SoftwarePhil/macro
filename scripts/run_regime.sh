#!/bin/bash
set -euo pipefail

SESSION="${1:-}"
if [[ "$SESSION" != "open" && "$SESSION" != "close" ]]; then
  echo "Usage: $0 <open|close>" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")/.." && pwd)"
export TZ="America/New_York"
cd "$DIR"

/usr/bin/python3 scripts/daily_regime_job.py --session "$SESSION" >> logs/cron.log 2>&1

echo ""
echo "Daily 3-Tier Regime Report + trades generated DIRECTLY by the script via Grok API call (XAI_API_KEY required in env)."
echo "Full report written to logs/reports/. No manual paste needed. News headlines fetched internally + LLM reasoning applied."