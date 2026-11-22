#!/usr/bin/env bash
# Builds a distributable, universal (Apple Silicon + Intel) openfortivpn Connect
# .dmg/.zip. The bundled openfortivpn has OpenSSL linked statically, so the app
# needs nothing besides macOS 11+ (no Homebrew).
#
# electron-builder breaks on FAT32/exFAT volumes (macOS AppleDouble "._*"
# files), so the build runs in a temporary copy on the system APFS disk.
set -euo pipefail
GUI="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$GUI/vendor/openfortivpn"

if [ ! -x "$BIN" ] || [ "${REBUILD_OPENFORTIVPN:-0}" = 1 ]; then
	"$GUI/scripts/build-openfortivpn-macos.sh"
fi
if otool -L "$BIN" | grep -qE '/opt/homebrew|libssl|libcrypto'; then
	echo "vendor/openfortivpn depends on external libraries - run scripts/build-openfortivpn-macos.sh" >&2
	exit 1
fi

WORK="$(mktemp -d /tmp/ofvgui-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
rsync -a --exclude '._*' --exclude '/dist' "$GUI/" "$WORK/"
(cd "$WORK" && npx electron-builder --mac --universal)

mkdir -p "$GUI/dist"
rm -f "$GUI/dist/"*.dmg "$GUI/dist/"*.zip "$GUI/dist/"*.blockmap
cp "$WORK/dist/"*.dmg "$WORK/dist/"*.zip "$GUI/dist/"
find "$GUI/dist" -name '._*' -delete 2>/dev/null || true
echo "Gotowe:"
ls -la "$GUI/dist/"*.dmg "$GUI/dist/"*.zip
