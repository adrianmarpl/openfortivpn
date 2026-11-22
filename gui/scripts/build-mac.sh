#!/usr/bin/env bash
# Builds openfortivpn Connect.app (+ .dmg/.zip) with the patched openfortivpn
# from this repository bundled in Contents/Resources/bin.
#
# electron-builder breaks on FAT32/exFAT volumes (macOS AppleDouble "._*"
# files), so the build runs in a temporary copy on the system APFS disk.
set -euo pipefail
GUI="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$GUI/.." && pwd)"
BIN="$REPO/openfortivpn"
if [ ! -x "$BIN" ]; then
	echo "Brak $BIN - zbuduj najpierw openfortivpn:"
	echo "  cd $REPO && ./autogen.sh && PKG_CONFIG_PATH=/opt/homebrew/opt/openssl@4/lib/pkgconfig ./configure --prefix=/opt/homebrew --sysconfdir=/opt/homebrew/etc && make"
	exit 1
fi
WORK="$(mktemp -d /tmp/ofvgui-build.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
rsync -a --exclude '._*' --exclude '/dist' --exclude '/vendor' "$GUI/" "$WORK/"
mkdir -p "$WORK/vendor"
cp "$BIN" "$WORK/vendor/openfortivpn"
chmod 755 "$WORK/vendor/openfortivpn"
(cd "$WORK" && CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dmg zip)
mkdir -p "$GUI/dist"
rm -rf "$GUI/dist/mac-arm64" "$GUI/dist/"*.dmg "$GUI/dist/"*.zip
cp -R "$WORK/dist/mac-arm64" "$WORK/dist/"*.dmg "$WORK/dist/"*.zip "$GUI/dist/" 2>/dev/null || true
find "$GUI/dist" -name '._*' -delete 2>/dev/null || true
echo "Gotowe: $GUI/dist"
ls -la "$GUI/dist"
