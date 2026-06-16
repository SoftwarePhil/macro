#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHD="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCHD" "$DIR/logs"

chmod +x "$DIR/scripts/run_regime.sh"

cp "$DIR/scripts/launchd/com.phil.regime-open.plist" "$LAUNCHD/"
cp "$DIR/scripts/launchd/com.phil.regime-close.plist" "$LAUNCHD/"

launchctl bootout "gui/$(id -u)/com.phil.regime-open" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.phil.regime-close" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCHD/com.phil.regime-open.plist"
launchctl bootstrap "gui/$(id -u)" "$LAUNCHD/com.phil.regime-close.plist"

echo "Installed schedule (Mon–Fri, America/New_York):"
echo "  09:30  market open  → regime job (open)"
echo "  16:00  market close → regime job (close)"
echo ""
echo "Manual test:"
echo "  $DIR/scripts/run_regime.sh open"
echo "  $DIR/scripts/run_regime.sh close"