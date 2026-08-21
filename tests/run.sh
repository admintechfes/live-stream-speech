#!/usr/bin/env bash
# Pre-event verification. Run this after any change, and once on the deployed
# VM before the doors open. Starts throwaway servers on 8098/8099.
set -uo pipefail
cd "$(dirname "$0")/.."

cleanup() { for p in 8097 8098 8099; do lsof -ti tcp:$p 2>/dev/null | xargs -r kill; done; }
trap cleanup EXIT
cleanup; sleep 0.5

fail=0

# The relay suites exercise routing, not speech. Dummy credentials keep them
# independent of whatever is in .env — and of whether .env exists at all.
export AZURE_SPEECH_KEY=${AZURE_SPEECH_KEY:-test-key}
export AZURE_SPEECH_REGION=${AZURE_SPEECH_REGION:-test-region}

echo "=== providers: language mapping, override resolution, config validation ==="
node tests/providers.test.js || fail=1

echo
echo "=== boot guards: a misconfigured provider must not reach the doors ==="
boot_check() { # name, expect_exit, env...
  local name=$1; shift
  local out
  out=$(env "$@" PORT=8097 node server.js 2>&1)
  if [ $? -ne 0 ]; then echo "PASS  $name"; else echo "FAIL  $name  <- started anyway: $out"; fail=1; fi
}
boot_check "soniox without SONIOX_API_KEY refuses to start" SPEECH_PROVIDER=soniox SONIOX_API_KEY=
boot_check "azure without AZURE_SPEECH_KEY refuses to start" SPEECH_PROVIDER=azure AZURE_SPEECH_KEY=
boot_check "an unknown SPEECH_PROVIDER refuses to start" SPEECH_PROVIDER=whisper

echo
echo "=== relay: isolation, hall validation, publisher lock, replay, health ==="
PORT=8099 HALLS=hall-1,hall-2,hall-3,hall-4 CONTROL_KEY= CAPTION_DELAY_MS=0 node server.js >/dev/null 2>&1 &
sleep 1.3
node tests/relay.test.js || fail=1

echo
echo "=== multi-language: per-language routing, replay, health, hall-wide blank ==="
PORT=8097 HALLS=hall-1,hall-2 TARGET_LANGS=en,ta CONTROL_KEY= CAPTION_DELAY_MS=0 node server.js >/dev/null 2>&1 &
sleep 1.3
node tests/multilang.test.js || fail=1

echo
echo "=== review delay + control key ==="
PORT=8098 HALLS=hall-1,hall-2 CONTROL_KEY=testkey CAPTION_DELAY_MS=1000 node server.js >/dev/null 2>&1 &
sleep 1.3
node tests/delay-auth.test.js || fail=1

echo
[ $fail -eq 0 ] && echo "ALL SUITES PASSED" || echo "SUITES FAILED"
exit $fail
