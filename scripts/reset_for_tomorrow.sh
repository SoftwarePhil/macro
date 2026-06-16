#!/bin/bash
# Full reset — paper portfolio + strategy log. First trades fire on next open job.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="$(dirname "$DIR")"
TOMORROW=$(TZ=America/New_York date -v+1d +%Y-%m-%d 2>/dev/null || python3 -c "from datetime import datetime,timedelta; from zoneinfo import ZoneInfo; print((datetime.now(ZoneInfo('America/New_York'))+__import__('datetime').timedelta(days=1)).strftime('%Y-%m-%d'))")

cd "$DIR"

# Backup today's test data
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$DIR/logs/backups"
[[ -f "$HOME_DIR/strategy_log.csv" ]] && cp "$HOME_DIR/strategy_log.csv" "$DIR/logs/backups/strategy_log_${STAMP}.csv"
[[ -f "$DIR/data/paper_trades.csv" ]] && cp "$DIR/data/paper_trades.csv" "$DIR/logs/backups/paper_trades_${STAMP}.csv"

# Reset paper account (clears trades + equity history)
python3 scripts/paper_trade.py --init --capital 100000 --start-date "$TOMORROW"
echo '{"points":[]}' > "$DIR/data/paper_chart.json"

# Fresh strategy log — first row will be tomorrow's open job
python3 - <<PY
from pathlib import Path
fields = [
    "Date","Session","Regime_Tier","Recommended_QQQ_%","Recommended_USO_%","Recommended_GLD_%",
    "Current_Portfolio_Value","QQQ_Price","USO_Price","GLD_Price","Rationale_Summary",
    "Gold_Oil_Ratio","Key_Signals","Suggested_Action","Rebalance_Note",
]
path = Path("$HOME_DIR/strategy_log.csv")
import csv
with path.open("w", newline="") as f:
    csv.DictWriter(f, fieldnames=fields).writeheader()
print(f"strategy_log.csv cleared — ready for {('$TOMORROW')}")
PY

echo ""
echo "Reset complete."
echo "  Start date:  $TOMORROW"
echo "  Capital:     \$100,000 cash"
echo "  Next action: open job at 9:30 AM ET ($TOMORROW)"
echo "  Backups:     $DIR/logs/backups/"