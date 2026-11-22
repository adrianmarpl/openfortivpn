'use strict';
// electron-builder afterPack hook: ad-hoc sign the macOS app (no Apple
// Developer ID needed). Without any signature, an app downloaded from the
// internet is reported by Gatekeeper as "damaged"; with an ad-hoc signature
// the user can open it via right click -> Open / "Open Anyway".
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
	if (context.electronPlatformName !== 'darwin') return;
	// universal builds pack x64 and arm64 into *-temp dirs first and merge them
	// afterwards; only the merged app may be signed (signatures must match)
	if (/-temp$/.test(context.appOutDir)) return;
	const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
	execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
	execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
	console.log(`  • ad-hoc signed ${path.basename(app)} (${context.arch})`);
};
