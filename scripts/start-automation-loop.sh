#!/bin/bash

# Continuous automation loop for local development
# Runs automation every 10 minutes
# Usage: ./scripts/start-automation-loop.sh

INTERVAL=600  # 10 minutes in seconds

echo "Starting automation loop (every 10 minutes)..."
echo "Press Ctrl+C to stop"
echo ""

while true; do
  ./scripts/run-automation.sh
  echo ""
  echo "Waiting 10 minutes until next run..."
  sleep $INTERVAL
done
