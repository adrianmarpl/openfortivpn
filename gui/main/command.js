'use strict';
/*
 * Profile <-> openfortivpn command line.
 * Pure functions, no Electron dependency (unit tested in test/).
 */

const DEFAULT_PROFILE = Object.freeze({
	name: 'Nowy profil',
	host: '',
	port: 443,
	realm: '',
	username: '',
	authMethod: 'password', // password | saml | cert
	savePassword: false,
	twoFactor: 'auto', // auto | code | push
	otpPrompt: '',
	otpDelay: 0,
	samlPort: 8020,
	userCert: '',
	userKey: '',
	caFile: '',
	trustedCerts: [],
	insecureSsl: false,
	minTls: '',
	cipherList: '',
	seclevel1: false,
	setRoutes: true,
	halfInternetRoutes: false,
	dnsMode: 'none', // none | openfortivpn | split
	splitDomains: '',
	pppdUsePeerdns: false,
	persistent: 0,
	verbosity: 1,
	binaryPath: '',
	extraArgs: '',
});

function normalizeProfile(p) {
	const out = { ...DEFAULT_PROFILE, ...(p || {}) };
	out.port = clampInt(out.port, 1, 65535, 443);
	out.samlPort = clampInt(out.samlPort, 1, 65535, 8020);
	out.otpDelay = clampInt(out.otpDelay, 0, 600, 0);
	out.persistent = clampInt(out.persistent, 0, 3600, 0);
	out.verbosity = clampInt(out.verbosity, 0, 3, 1);
	out.trustedCerts = Array.isArray(out.trustedCerts)
		? [...new Set(out.trustedCerts.map((c) => String(c).trim().toLowerCase()).filter(isSha256))]
		: [];
	for (const k of ['name', 'host', 'realm', 'username', 'otpPrompt', 'userCert', 'userKey',
		'caFile', 'minTls', 'cipherList', 'splitDomains', 'binaryPath', 'extraArgs']) {
		out[k] = String(out[k] ?? '').trim();
	}
	if (!['password', 'saml', 'cert'].includes(out.authMethod)) out.authMethod = 'password';
	if (!['auto', 'code', 'push'].includes(out.twoFactor)) out.twoFactor = 'auto';
	if (!['none', 'openfortivpn', 'split'].includes(out.dnsMode)) out.dnsMode = 'none';
	if (!['', '1.0', '1.1', '1.2', '1.3'].includes(out.minTls)) out.minTls = '';
	// host may have been typed as host:port or as an URL
	const hp = parseHostPort(out.host);
	if (hp) {
		out.host = hp.host;
		if (hp.port) out.port = hp.port;
	}
	return out;
}

function clampInt(v, min, max, def) {
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n)) return def;
	return Math.min(max, Math.max(min, n));
}

function isSha256(s) {
	return /^[0-9a-f]{64}$/.test(s);
}

function parseHostPort(text) {
	let s = String(text || '').trim();
	if (!s) return null;
	s = s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
	const m = s.match(/^\[?([^\]]+?)\]?(?::(\d{1,5}))?$/);
	if (!m) return { host: s, port: 0 };
	return { host: m[1], port: m[2] ? Number(m[2]) : 0 };
}

function validateProfile(p) {
	const errors = [];
	if (!p.host) errors.push('Podaj adres bramy VPN (host).');
	else if (!/^[A-Za-z0-9.\-:]+$/.test(p.host)) errors.push('Adres bramy zawiera niedozwolone znaki.');
	if (p.authMethod === 'password' && !p.username) errors.push('Podaj nazwę użytkownika.');
	if (p.authMethod === 'cert' && !p.userCert) errors.push('Wskaż plik certyfikatu użytkownika.');
	try {
		splitShell(p.extraArgs);
	} catch (e) {
		errors.push(`Dodatkowe argumenty: ${e.message}`);
	}
	return errors;
}

/**
 * Build the argv passed to openfortivpn (without the binary itself).
 * opts.pinentry - path of the pinentry bridge (omitted for previews)
 */
function buildArgs(profile, opts = {}) {
	const p = normalizeProfile(profile);
	const a = [`${p.host}:${p.port}`];

	// isolate from any system wide /etc/openfortivpn/config
	if (opts.isolateConfig !== false) a.push('-c', '/dev/null');

	if (p.authMethod === 'saml') {
		a.push(`--saml-login=${p.samlPort}`);
	} else if (p.username) {
		a.push('-u', p.username);
	}
	if (p.realm) a.push(`--realm=${p.realm}`);

	if (p.authMethod !== 'saml') {
		if (opts.pinentry) a.push(`--pinentry=${opts.pinentry}`);
		if (p.twoFactor === 'code') a.push('--no-ftm-push');
		if (p.otpPrompt) a.push(`--otp-prompt=${p.otpPrompt}`);
		if (p.otpDelay > 0) a.push(`--otp-delay=${p.otpDelay}`);
	}

	if (p.userCert) a.push(`--user-cert=${p.userCert}`);
	if (p.userKey) a.push(`--user-key=${p.userKey}`);
	if (p.caFile) a.push(`--ca-file=${p.caFile}`);
	for (const c of p.trustedCerts) a.push(`--trusted-cert=${c}`);
	if (p.insecureSsl) a.push('--insecure-ssl');
	if (p.minTls) a.push(`--min-tls=${p.minTls}`);
	if (p.cipherList) a.push(`--cipher-list=${p.cipherList}`);
	if (p.seclevel1) a.push('--seclevel-1');

	a.push(`--set-routes=${p.setRoutes ? 1 : 0}`);
	if (p.halfInternetRoutes) a.push('--half-internet-routes=1');
	a.push(`--set-dns=${p.dnsMode === 'openfortivpn' ? 1 : 0}`);
	if (p.pppdUsePeerdns) a.push('--pppd-use-peerdns=1');
	if (p.persistent > 0) a.push(`--persistent=${p.persistent}`);

	for (let i = 0; i < p.verbosity; i++) a.push('-v');
	a.push(...splitShell(p.extraArgs));
	return a;
}

function shellQuote(s) {
	s = String(s);
	if (s === '') return "''";
	if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function commandPreview(profile, binary) {
	const args = buildArgs(profile, { isolateConfig: false });
	return ['sudo', binary || 'openfortivpn', ...args].map(shellQuote).join(' ');
}

/** Minimal POSIX-like word splitting (quotes, backslashes, line continuations). */
function splitShell(text) {
	const s = String(text || '');
	const out = [];
	let cur = '';
	let has = false;
	let i = 0;
	while (i < s.length) {
		const ch = s[i];
		if (ch === '\\') {
			if (s[i + 1] === '\n') { i += 2; continue; }
			if (i + 1 < s.length) { cur += s[i + 1]; has = true; i += 2; continue; }
			i++; continue;
		}
		if (ch === "'") {
			const end = s.indexOf("'", i + 1);
			if (end < 0) throw new Error('niezamknięty cudzysłów \'');
			cur += s.slice(i + 1, end); has = true; i = end + 1; continue;
		}
		if (ch === '"') {
			let j = i + 1;
			while (j < s.length && s[j] !== '"') {
				if (s[j] === '\\' && j + 1 < s.length && '"\\$`'.includes(s[j + 1])) { cur += s[j + 1]; j += 2; continue; }
				cur += s[j]; j++;
			}
			if (j >= s.length) throw new Error('niezamknięty cudzysłów "');
			has = true; i = j + 1; continue;
		}
		if (/\s/.test(ch)) {
			if (has) { out.push(cur); cur = ''; has = false; }
			i++; continue;
		}
		cur += ch; has = true; i++;
	}
	if (has) out.push(cur);
	return out;
}

/* ----------------------------------------------------------------------------
 * Import: from a shell command (e.g. "sudo openfortivpn host:443 -u x --set-dns=0")
 * or from an openfortivpn config file ("key = value").
 * Returns { profile, warnings }.
 */
const BOOL = (v) => !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());

function applyOption(p, key, val, warnings, extra) {
	switch (key) {
	case 'host': { const hp = parseHostPort(val); if (hp) { p.host = hp.host; if (hp.port) p.port = hp.port; } break; }
	case 'port': p.port = Number(val); break;
	case 'u': case 'username': p.username = val; break;
	case 'p': case 'password':
		warnings.push('Hasło z polecenia/pliku nie zostało zaimportowane — wpisz je w GUI (zostanie zapisane w pęku kluczy).');
		break;
	case 'o': case 'otp':
		warnings.push('Jednorazowy kod OTP pominięto — GUI zapyta o niego podczas łączenia.');
		break;
	case 'realm': p.realm = val; break;
	case 'otp-prompt': p.otpPrompt = val; break;
	case 'otp-delay': p.otpDelay = Number(val); break;
	case 'no-ftm-push': if (val === undefined || BOOL(val)) p.twoFactor = 'code'; break;
	case 'saml-login': p.authMethod = 'saml'; if (val) p.samlPort = Number(val); break;
	case 'user-cert': p.userCert = val; if (!p.username) p.authMethod = 'cert'; break;
	case 'user-key': p.userKey = val; break;
	case 'ca-file': p.caFile = val; break;
	case 'trusted-cert': p.trustedCerts.push(val); break;
	case 'insecure-ssl': p.insecureSsl = val === undefined ? true : BOOL(val); break;
	case 'min-tls': p.minTls = val; break;
	case 'cipher-list': p.cipherList = val; break;
	case 'seclevel-1': p.seclevel1 = val === undefined ? true : BOOL(val); break;
	case 'set-routes': p.setRoutes = BOOL(val ?? '1'); break;
	case 'half-internet-routes': p.halfInternetRoutes = BOOL(val ?? '1'); break;
	case 'set-dns': p.dnsMode = BOOL(val ?? '1') ? 'openfortivpn' : 'none'; break;
	case 'pppd-use-peerdns': p.pppdUsePeerdns = BOOL(val ?? '1'); break;
	case 'persistent': p.persistent = Number(val); break;
	case 'c': case 'config':
		warnings.push(`Plik konfiguracyjny ${val} — zaimportuj go osobno opcją „Importuj plik config”.`);
		break;
	case 'pinentry': break; // GUI provides its own
	default:
		extra.push(val === undefined ? `--${key}` : `--${key}=${val}`);
		warnings.push(`Opcja --${key} przeniesiona do „Dodatkowe argumenty”.`);
	}
}

const SHORT_WITH_ARG = new Set(['u', 'p', 'o', 'c']);
const LONG_WITH_ARG = new Set(['username', 'password', 'otp', 'realm', 'otp-prompt', 'otp-delay',
	'user-cert', 'user-key', 'ca-file', 'trusted-cert', 'min-tls', 'cipher-list', 'set-routes',
	'half-internet-routes', 'set-dns', 'pppd-use-peerdns', 'persistent', 'config', 'pinentry',
	'pppd-log', 'pppd-plugin', 'pppd-ipparam', 'pppd-ifname', 'pppd-call', 'pppd-accept-remote',
	'ifname', 'sni', 'cookie', 'use-resolvconf', 'use-syslog', 'pppd-no-peerdns']);
const OPTIONAL_ARG = new Set(['saml-login', 'set-routes', 'set-dns', 'half-internet-routes', 'pppd-use-peerdns']);

function importCommand(text) {
	const warnings = [];
	const p = { ...DEFAULT_PROFILE, trustedCerts: [] };
	const extra = [];
	let words = splitShell(text);
	while (words.length && /^(sudo|doas|pkexec|-[A-Za-z]+|env|exec)$/.test(words[0])) words.shift();
	if (!words.length || !/openfortivpn$/.test(words[0])) {
		throw new Error('Polecenie powinno zawierać „openfortivpn”.');
	}
	if (words[0].startsWith('/')) p.binaryPath = words[0];
	words = words.slice(1);
	let verbosity = 0;

	for (let i = 0; i < words.length; i++) {
		const w = words[i];
		if (w === '--') continue;
		if (w.startsWith('--')) {
			const eq = w.indexOf('=');
			const key = eq > 0 ? w.slice(2, eq) : w.slice(2);
			let val = eq > 0 ? w.slice(eq + 1) : undefined;
			if (key === 'verbose') { verbosity++; continue; }
			if (val === undefined && LONG_WITH_ARG.has(key)) {
				if (!OPTIONAL_ARG.has(key)) val = words[++i];
				else if (/^[01]$/.test(words[i + 1] || '')) val = words[++i];
			}
			applyOption(p, key, val, warnings, extra);
		} else if (/^-[A-Za-z]/.test(w)) {
			if (/^-v+$/.test(w)) { verbosity += w.length - 1; continue; }
			if (w === '-q') { continue; }
			const key = w[1];
			let val = w.length > 2 ? w.slice(2) : undefined;
			if (SHORT_WITH_ARG.has(key) && val === undefined) val = words[++i];
			applyOption(p, key, val, warnings, extra);
		} else if (!p.host) {
			applyOption(p, 'host', w, warnings, extra);
		} else {
			warnings.push(`Nieznany argument „${w}” pominięto.`);
		}
	}
	p.verbosity = Math.min(3, verbosity);
	p.extraArgs = extra.map(shellQuote).join(' ');
	if (p.host) p.name = p.host;
	const profile = normalizeProfile(p);
	if (!/--set-dns/.test(text)) {
		// openfortivpn defaults to set-dns=1 when the flag is absent
		profile.dnsMode = 'openfortivpn';
	}
	return { profile, warnings };
}

function importConfigFile(text) {
	const warnings = [];
	const p = { ...DEFAULT_PROFILE, trustedCerts: [], dnsMode: 'openfortivpn' };
	const extra = [];
	for (const raw of String(text).split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith('#')) continue;
		const eq = line.indexOf('=');
		if (eq < 0) { warnings.push(`Pominięto linię: ${line}`); continue; }
		const key = line.slice(0, eq).trim();
		const val = line.slice(eq + 1).trim();
		applyOption(p, key, val, warnings, extra);
	}
	p.extraArgs = extra.map(shellQuote).join(' ');
	if (p.host) p.name = p.host;
	return { profile: normalizeProfile(p), warnings };
}

module.exports = {
	DEFAULT_PROFILE,
	normalizeProfile,
	validateProfile,
	buildArgs,
	commandPreview,
	shellQuote,
	splitShell,
	importCommand,
	importConfigFile,
	parseHostPort,
};
