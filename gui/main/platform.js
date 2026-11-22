'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function isExecutable(p) {
	try {
		fs.accessSync(p, fs.constants.X_OK);
		return fs.statSync(p).isFile();
	} catch { return false; }
}

function candidateBinaries() {
	const list = [];
	// patched binary shipped inside the packaged app (Resources/bin)
	if (process.resourcesPath) list.push(path.join(process.resourcesPath, 'bin', 'openfortivpn'));
	list.push(
		'/opt/homebrew/bin/openfortivpn',
		'/usr/local/bin/openfortivpn',
		'/usr/bin/openfortivpn',
		'/usr/sbin/openfortivpn',
		'/opt/local/bin/openfortivpn',
	);
	// binary built from this repository (./configure && make)
	const repo = path.resolve(__dirname, '..', '..', 'openfortivpn');
	if (!repo.includes('app.asar')) list.push(repo);
	return list;
}

function findBinary(preferred) {
	if (preferred) return isExecutable(preferred) ? preferred : null;
	return candidateBinaries().find(isExecutable) || null;
}

function binaryVersion(bin) {
	return new Promise((resolve) => {
		if (!bin) return resolve(null);
		execFile(bin, ['--version'], { timeout: 3000 }, (err, stdout, stderr) => {
			const out = `${stdout || ''}${stderr || ''}`.trim();
			resolve(err && !out ? null : out.split('\n')[0]);
		});
	});
}

async function detectBinaries() {
	const found = [];
	for (const p of candidateBinaries()) {
		if (isExecutable(p)) found.push({ path: p, version: await binaryVersion(p) });
	}
	return found;
}

function findPerl() {
	return ['/usr/bin/perl', '/bin/perl', '/usr/local/bin/perl', '/opt/homebrew/bin/perl'].find(isExecutable) || null;
}

function hasCommand(name) {
	return ['/usr/bin', '/bin', '/usr/sbin', '/sbin', '/usr/local/bin'].some((d) => isExecutable(path.join(d, name)));
}

async function diagnostics(settings) {
	const bins = await detectBinaries();
	const checks = [];
	checks.push({
		id: 'binary',
		ok: bins.length > 0,
		label: 'openfortivpn',
		detail: bins.length ? bins.map((b) => `${b.path} (${b.version || '?'})`).join(', ')
			: (process.platform === 'darwin' ? 'Nie znaleziono. Zainstaluj: brew install openfortivpn' : 'Nie znaleziono. Zainstaluj: sudo apt install openfortivpn'),
	});
	const perl = findPerl();
	checks.push({ id: 'perl', ok: Boolean(perl), label: 'Perl (helper)', detail: perl || 'Brak /usr/bin/perl — zainstaluj perl.' });
	if (process.platform === 'linux') {
		checks.push({ id: 'pppd', ok: hasCommand('pppd'), label: 'pppd', detail: hasCommand('pppd') ? 'zainstalowany' : 'Brak pppd: sudo apt install ppp' });
		checks.push({ id: 'pkexec', ok: hasCommand('pkexec') || settings.privilege !== 'pkexec', label: 'pkexec (polkit)',
			detail: hasCommand('pkexec') ? 'dostępny' : 'Brak pkexec: sudo apt install pkexec lub wybierz sudo w Ustawieniach' });
		checks.push({ id: 'resolvectl', ok: true, optional: true, label: 'resolvectl (split DNS)',
			detail: hasCommand('resolvectl') ? 'dostępny' : 'brak — split DNS niedostępny (systemd-resolved)' });
	} else {
		checks.push({ id: 'pppd', ok: isExecutable('/usr/sbin/pppd'), label: 'pppd', detail: isExecutable('/usr/sbin/pppd') ? '/usr/sbin/pppd' : 'Brak /usr/sbin/pppd' });
	}
	checks.push({ id: 'sudo', ok: hasCommand('sudo') || settings.privilege === 'pkexec', label: 'sudo', detail: hasCommand('sudo') ? 'dostępne' : 'brak' });
	return { checks, binaries: bins, platform: process.platform };
}

module.exports = { findBinary, detectBinaries, binaryVersion, findPerl, diagnostics, isExecutable };
