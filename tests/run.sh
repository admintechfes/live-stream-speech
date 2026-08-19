#!/usr/bin/env bash
# Pre-event verification. Run this after any change, and once on the deployed
# VM before the doors open. Starts throwaway servers on 8098/8099.
set -uo pipefail
cd "$(dirname "$0")/.."

cleanup() { for p in 8098 8099; do lsof -ti tcp:$p 2>/dev/null | xargs -r kill; done; }
trap cleanup EXIT
cleanup; sleep 0.5

fail=0

echo "=== relay: isolation, hall validation, publisher lock, replay, health ==="
PORT=8099 HALLS=hall-1,hall-2,hall-3,hall-4 CONTROL_KEY= CAPTION_DELAY_MS=0 node server.js >/dev/null 2>&1 &
sleep 1.3
node tests/relay.test.js || fail=1

echo
echo "=== review delay + control key ==="
PORT=8098 HALLS=hall-1,hall-2 CONTROL_KEY=testkey CAPTION_DELAY_MS=1000 node server.js >/dev/null 2>&1 &
sleep 1.3
node tests/delay-auth.test.js || fail=1

echo
[ $fail -eq 0 ] && echo "ALL SUITES PASSED" || echo "SUITES FAILED"
exit $fail
