#!/bin/bash

# Stop launchd automation service

PLIST_NAME="com.financial-agent.automation.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ -f "$PLIST_DEST" ]; then
  launchctl unload "$PLIST_DEST"
  echo "✓ Automation service stopped"
else
  echo "✗ Service not found"
  exit 1
fi
