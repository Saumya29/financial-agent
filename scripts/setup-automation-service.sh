#!/bin/bash

# Setup launchd service for automation
# This will run automation every 10 minutes in the background

PLIST_NAME="com.financial-agent.automation.plist"
PLIST_SRC="$(pwd)/scripts/$PLIST_NAME"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"
LOG_DIR="$(pwd)/logs"

echo "Setting up automation service..."

# Create logs directory
mkdir -p "$LOG_DIR"
echo "✓ Created logs directory"

# Copy plist to LaunchAgents
cp "$PLIST_SRC" "$PLIST_DEST"
echo "✓ Copied service definition"

# Load the service
launchctl unload "$PLIST_DEST" 2>/dev/null
launchctl load "$PLIST_DEST"
echo "✓ Service loaded"

echo ""
echo "Automation service is now running in the background!"
echo "It will run every 10 minutes automatically."
echo ""
echo "Commands:"
echo "  npm run automation:start   - Start the service"
echo "  npm run automation:stop    - Stop the service"
echo "  npm run automation:status  - Check service status"
echo "  npm run automation:logs    - View logs"
