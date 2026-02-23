#!/bin/bash

# Start launchd automation service

PLIST_NAME="com.financial-agent.automation.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ -f "$PLIST_DEST" ]; then
  launchctl unload "$PLIST_DEST" 2>/dev/null
  launchctl load "$PLIST_DEST"
  echo "✓ Automation service started"
else
  echo "✗ Service not found. Run 'npm run automation:setup' first"
  exit 1
fi
