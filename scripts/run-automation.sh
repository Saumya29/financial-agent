#!/bin/bash

# Local automation runner - runs every 10 minutes
# Usage: ./scripts/run-automation.sh

AUTOMATION_URL="http://localhost:3000/api/automation/run"
AUTOMATION_SECRET="${AUTOMATION_CRON_SECRET:-dev-secret-123}"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Running automation cycle..."

response=$(curl -s -X POST "$AUTOMATION_URL" \
  -H "Authorization: Bearer $AUTOMATION_SECRET" \
  -w "\n%{http_code}")

http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "200" ]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✓ Automation completed"
  echo "$body" | jq -r '.outcomes[0] | "  Gmail: \(.gmail.created // 0) new, Tasks: \(.tasks | length) processed"' 2>/dev/null || echo "  $body"
else
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✗ Automation failed (HTTP $http_code)"
  echo "$body"
fi
