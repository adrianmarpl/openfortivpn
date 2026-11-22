#!/usr/bin/env bash
# Drives the real Electron UI against test/mock-openfortivpn.js (no sudo, no network).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${OFVGUI_SHOTS:-$(mktemp -d)}"
UD="$(mktemp -d)"
OFVGUI_USER_DATA="$UD" OFVGUI_PRIVILEGE=none OFVGUI_BINARY="$PWD/test/mock-openfortivpn.js" \
MOCK_SCENARIO=ok OFVGUI_E2E_SCRIPT="$PWD/test/e2e-electron.js" OFVGUI_SHOTS="$OUT" \
	./node_modules/.bin/electron . 2>&1 | grep E2E
rm -rf "$UD"
echo "screenshots: $OUT"
