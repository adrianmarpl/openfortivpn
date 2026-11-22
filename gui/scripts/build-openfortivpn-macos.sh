#!/usr/bin/env bash
#
# Builds a self-contained, universal (arm64 + x86_64) openfortivpn for macOS
# with OpenSSL linked statically, so it runs on any Mac (macOS 11+) without
# Homebrew or any other external library. Output: gui/vendor/openfortivpn
#
# Usage: gui/scripts/build-openfortivpn-macos.sh
#
set -euo pipefail

OPENSSL_VERSION="${OPENSSL_VERSION:-3.5.9}"
MACOS_MIN="${MACOS_MIN:-11.0}"
GUI="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$GUI/.." && pwd)"
WORK="${WORK:-/tmp/ofv-static-build}"   # must be on APFS (not FAT32/exFAT)
JOBS="$(sysctl -n hw.ncpu)"

mkdir -p "$WORK"
cd "$WORK"

# --- OpenSSL source (verified) ---------------------------------------------------
TARBALL="openssl-$OPENSSL_VERSION.tar.gz"
URL="https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/$TARBALL"
if [ ! -f "$TARBALL" ]; then
	curl -fsSL -o "$TARBALL" "$URL"
	curl -fsSL -o "$TARBALL.sha256" "$URL.sha256"
fi
expected="$(awk '{print $1}' "$TARBALL.sha256")"
actual="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
if [ "$expected" != "$actual" ]; then
	echo "OpenSSL checksum mismatch: $actual != $expected" >&2
	exit 1
fi
echo "OpenSSL $OPENSSL_VERSION sha256 OK"

build_openssl() {
	local arch="$1" target="$2" prefix="$WORK/openssl-$1"
	[ -f "$prefix/lib/libssl.a" ] && return
	rm -rf "src-openssl-$arch" && mkdir "src-openssl-$arch"
	tar -xzf "$TARBALL" -C "src-openssl-$arch" --strip-components=1
	(
		cd "src-openssl-$arch"
		# openssldir=/private/etc/ssl -> uses the macOS system CA bundle /etc/ssl/cert.pem
		./Configure "$target" no-shared no-tests no-docs no-module \
			--prefix="$prefix" --openssldir=/private/etc/ssl \
			-mmacosx-version-min="$MACOS_MIN" >/dev/null
		make -j"$JOBS" build_libs >/dev/null
		make install_dev >/dev/null
	)
}

build_ofv() {
	local arch="$1" host="$2" prefix="$WORK/openssl-$1" out="$WORK/ofv-$1"
	rm -rf "$out" && mkdir -p "$out"
	rsync -a --exclude '._*' --exclude '.git' --exclude 'gui' --exclude '*.o' \
		--exclude '/openfortivpn' --exclude '/config.status' --exclude '/config.log' \
		--exclude '/Makefile' --exclude '/autom4te.cache' "$REPO/" "$out/src/"
	(
		cd "$out/src"
		[ -x configure ] || ./autogen.sh >/dev/null
		CC="clang -arch $arch -mmacosx-version-min=$MACOS_MIN" \
		PKG_CONFIG_PATH="$prefix/lib/pkgconfig" \
		OPENSSL_CFLAGS="-I$prefix/include" \
		OPENSSL_LIBS="$prefix/lib/libssl.a $prefix/lib/libcrypto.a" \
		./configure --host="$host" --build="$(uname -m)-apple-darwin" \
			--prefix=/usr/local --sysconfdir=/etc \
			--with-pppd=/usr/sbin/pppd --with-netstat=/usr/sbin/netstat \
			--disable-proc --disable-resolvconf >/dev/null
		make -j"$JOBS" >/dev/null
	)
	cp "$out/src/openfortivpn" "$WORK/openfortivpn-$arch"
}

echo "Building OpenSSL (arm64)…";  build_openssl arm64  darwin64-arm64-cc
echo "Building OpenSSL (x86_64)…"; build_openssl x86_64 darwin64-x86_64-cc
echo "Building openfortivpn (arm64)…";  build_ofv arm64  aarch64-apple-darwin
echo "Building openfortivpn (x86_64)…"; build_ofv x86_64 x86_64-apple-darwin

mkdir -p "$GUI/vendor"
lipo -create -output "$GUI/vendor/openfortivpn" "$WORK/openfortivpn-arm64" "$WORK/openfortivpn-x86_64"
chmod 755 "$GUI/vendor/openfortivpn"
codesign --force --sign - "$GUI/vendor/openfortivpn"

echo
lipo -info "$GUI/vendor/openfortivpn"
echo "Linked libraries:"
otool -L "$GUI/vendor/openfortivpn" | tail -n +2
if otool -L "$GUI/vendor/openfortivpn" | grep -qE '/opt/homebrew|/usr/local|libssl|libcrypto'; then
	echo "ERROR: binary still depends on external libraries" >&2
	exit 1
fi
echo "OK: $GUI/vendor/openfortivpn is self-contained"
