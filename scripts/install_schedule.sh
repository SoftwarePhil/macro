#!/bin/bash
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHD="$HOME/Library/LaunchAgents"
KEY_FILE="$DIR/data/xai_api_key.txt"

mkdir -p "$LAUNCHD" "$DIR/logs"

chmod +x "$DIR/scripts/run_regime.sh"

# Read XAI API key from gitignored file (never commit real keys)
if [ ! -f "$KEY_FILE" ]; then
  echo "ERROR: $KEY_FILE not found."
  echo ""
  echo "Create it with your xAI API key (one line only, no quotes):"
  echo "  echo 'xai-yourkeyhere' > $KEY_FILE"
  echo "  chmod 600 $KEY_FILE"
  echo ""
  echo "This file is gitignored and will be used to inject the key into the launchd plists."
  exit 1
fi

XAI_KEY=$(tr -d ' \t\n\r' < "$KEY_FILE")

if [ -z "$XAI_KEY" ]; then
  echo "ERROR: $KEY_FILE is empty. Put your xAI API key in it."
  exit 1
fi

# Inject key into plists at install time (source templates always use placeholder)
sed "s/REPLACE_WITH_YOUR_XAI_API_KEY/${XAI_KEY}/g" \
  "$DIR/scripts/launchd/com.phil.regime-open.plist" > "$LAUNCHD/com.phil.regime-open.plist"

sed "s/REPLACE_WITH_YOUR_XAI_API_KEY/${XAI_KEY}/g" \
  "$DIR/scripts/launchd/com.phil.regime-close.plist" > "$LAUNCHD/com.phil.regime-close.plist"

launchctl bootout "gui/$(id -u)/com.phil.regime-open" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.phil.regime-close" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$LAUNCHD/com.phil.regime-open.plist"
launchctl bootstrap "gui/$(id -u)" "$LAUNCHD/com.phil.regime-close.plist"

echo "Installed schedule (Mon–Fri, America/New_York):"
echo "  09:30  market open  → regime job (open)"
echo "  16:00  market close → regime job (close)"
echo ""
echo "XAI key injected from $KEY_FILE (gitignored)."
echo ""
echo "Manual test:"
echo "  $DIR/scripts/run_regime.sh open"
echo "  $DIR/scripts/run_regime.sh close"