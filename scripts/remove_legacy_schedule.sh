#!/bin/bash
set -euo pipefail

LAUNCHD="$HOME/Library/LaunchAgents"

for label in com.phil.regime-open com.phil.regime-close; do
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  rm -f "$LAUNCHD/$label.plist"
done

echo "Removed legacy regime LaunchAgents. The Node server now owns scheduling."
