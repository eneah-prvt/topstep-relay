#!/usr/bin/env bash
# Minimal signal send via curl — works from any language/algo that can shell out.
RELAY_URL="${RELAY_URL:-https://your-relay.up.railway.app}"
SENDER_SECRET="${SENDER_SECRET:-change-me-long-random-string}"

curl -sS -X POST "$RELAY_URL/signal" \
  -H "Content-Type: application/json" \
  -H "x-secret: $SENDER_SECRET" \
  -d '{
    "signalId": "'"$(uuidgen 2>/dev/null || date +%s%N)"'",
    "symbol": "NQ",
    "side": "LONG",
    "size": 2,
    "orderType": "MARKET",
    "stopLossTicks": 40,
    "takeProfitTicks": 80
  }'
echo
