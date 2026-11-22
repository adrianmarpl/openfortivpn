'use strict';
/*
 * Turns openfortivpn output lines into structured events.
 * Pure, unit tested.
 */

const STAGES = ['privileges', 'tls', 'auth', 'tunnel', 'connected'];

function stripAnsi(s) {
	return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

function levelOf(line) {
	const m = line.match(/^(ERROR|WARN|INFO|DEBUG):\s/);
	return m ? m[1].toLowerCase() : 'info';
}

/**
 * Hints for well known failures. Returned objects:
 *  { code, title, hint }
 */
const ERROR_PATTERNS = [
	{ re: /Gateway certificate validation failed/, code: 'cert', title: 'Nieznany certyfikat bramy',
		hint: 'Certyfikat serwera nie jest zaufany. Sprawdź odcisk SHA-256 i zaakceptuj go, jeśli się zgadza.' },
	{ re: /Could not authenticate to the gateway|Authentication failed|Received HTTP 401|HTTP_ACCESS_DENIED|permission denied/i,
		code: 'auth', title: 'Logowanie odrzucone',
		hint: 'Sprawdź login, hasło, realm i kod 2FA. Jeżeli hasło jest zapisane, mogło się zmienić.' },
	{ re: /unsupported challenge/, code: 'auth-challenge', title: 'Nieobsługiwane wyzwanie logowania',
		hint: 'Brama żąda metody logowania, której openfortivpn nie obsługuje (np. tylko SAML). Spróbuj trybu SAML.' },
	{ re: /No token specified|No OTP specified|No password given|Failed to get PIN/, code: 'cancelled',
		title: 'Anulowano', hint: 'Nie podano hasła lub kodu.' },
	{ re: /SSL_connect|SSL_read|SSL_write|handshake/i, code: 'tls', title: 'Błąd połączenia TLS',
		hint: 'Spróbuj w Zaawansowanych: „Minimalny TLS 1.2”, „seclevel-1” albo innej listy szyfrów. Sprawdź też, czy port jest poprawny.' },
	{ re: /getaddrinfo|Name or service not known|nodename nor servname/, code: 'dns', title: 'Nie można rozwiązać nazwy bramy',
		hint: 'Sprawdź adres hosta i połączenie z internetem.' },
	{ re: /connect: (Connection refused|Operation timed out|Network is unreachable|No route to host|Connection timed out)/,
		code: 'network', title: 'Brama nieosiągalna', hint: 'Sprawdź adres, port i połączenie sieciowe.' },
	{ re: /not spawned with root privileges/, code: 'root', title: 'Brak uprawnień administratora',
		hint: 'openfortivpn musi działać jako root. Sprawdź metodę uprawnień w Ustawieniach.' },
	{ re: /Timed out waiting for the ppp interface|pppd: .*(exit|terminated)|Peer refused to agree/, code: 'ppp',
		title: 'Tunel PPP nie wstał', hint: 'Sprawdź, czy pppd jest zainstalowany (Linux: apt install ppp) i czy brama pozwala na tryb tunelu.' },
	{ re: /tunnel mode is allowed|Could not get tunnel/i, code: 'tunnel', title: 'Brama odmówiła tunelu',
		hint: 'Konto może nie mieć uprawnień do trybu tunelu albo realm jest niepoprawny.' },
	{ re: /Failed to bind socket to port/, code: 'saml-port', title: 'Port SAML zajęty',
		hint: 'Zmień port SAML w konfiguracji profilu.' },
	{ re: /exec .*: No such file|binary-not-executable/, code: 'binary', title: 'Nie znaleziono openfortivpn',
		hint: 'Zainstaluj openfortivpn (brew install openfortivpn / apt install openfortivpn) lub wskaż ścieżkę w profilu.' },
];

function classifyError(line) {
	for (const p of ERROR_PATTERNS) {
		if (p.re.test(line)) return { code: p.code, title: p.title, hint: p.hint };
	}
	return null;
}

class LogParser {
	constructor() {
		this.reset();
	}

	reset() {
		this.cert = null; // { digest, subject:[], issuer:[] }
		this._certSection = null;
		this.info = { ip: null, dns: [], dnsSuffix: null, iface: null, gateway: null };
		this.firstError = null;
	}

	/** returns an array of events */
	feed(rawLine) {
		const line = stripAnsi(rawLine).replace(/\r$/, '');
		const ev = [];
		const msg = line.replace(/^(ERROR: {2}|WARN: {3}|INFO: {3}|DEBUG: {2})/, '');

		// certificate block
		let m = msg.match(/^\s*--trusted-cert\s+([0-9a-f]{64})/);
		if (m) {
			this.cert = { digest: m[1], subject: [], issuer: [] };
		}
		if (this.cert) {
			if (/^\s{4}subject:/.test(msg)) this._certSection = 'subject';
			else if (/^\s{4}issuer:/.test(msg)) this._certSection = 'issuer';
			else if (/^\s{4}sha256 digest:/.test(msg)) {
				this._certSection = null;
				ev.push({ type: 'cert', cert: this.cert });
			} else if (this._certSection && /^\s{8}\S/.test(msg)) {
				this.cert[this._certSection].push(msg.trim());
			}
		}

		if (/Connected to gateway\./.test(msg)) ev.push({ type: 'stage', stage: 'auth' });
		else if (/Authenticated\./.test(msg)) ev.push({ type: 'stage', stage: 'tunnel', note: 'authenticated' });
		else if (/Remote gateway has allocated a VPN\./.test(msg)) ev.push({ type: 'stage', stage: 'tunnel', note: 'allocated' });
		else if (/Tunnel is up and running\./.test(msg)) ev.push({ type: 'stage', stage: 'connected' });
		else if (/Closed connection to gateway\./.test(msg)) ev.push({ type: 'closed' });

		m = msg.match(/Got addresses: \[([^\]]*)\], ns \[([^\]]*)\](?:, ns_suffix \[([^\]]*)\])?/);
		if (m) {
			this.info.ip = m[1];
			this.info.dns = m[2].split(/[\s,]+/).filter((x) => x && x !== '0.0.0.0');
			this.info.dnsSuffix = m[3] || null;
			ev.push({ type: 'info', info: { ...this.info } });
		}
		m = msg.match(/Interface (\S+) is UP\./);
		if (m) {
			this.info.iface = m[1];
			ev.push({ type: 'info', info: { ...this.info } });
		}
		m = msg.match(/Authenticate at '([^']+)'/);
		if (m) ev.push({ type: 'saml', url: m[1] });
		if (/Delaying OTP/.test(msg)) ev.push({ type: 'note', text: msg.trim() });
		if (/did not answer within|Timed out sending to the gateway|stalled or closed, reconnecting|TLS connection failed, retrying/.test(msg)) {
			ev.push({ type: 'note', text: 'Brama nie odpowiada — ponawianie połączenia…' });
		}

		if (levelOf(line) === 'error') {
			const c = classifyError(msg);
			if (c && !this.firstError) this.firstError = { ...c, line: msg.trim() };
			if (c) ev.push({ type: 'error', error: { ...c, line: msg.trim() } });
		} else if (/exec .*: No such file/.test(msg)) {
			const c = classifyError(msg);
			if (!this.firstError) this.firstError = { ...c, line: msg.trim() };
		}
		return ev;
	}
}

/** Classifies a pinentry request by its key info hint. */
function classifyPrompt(keyinfo, prompt) {
	const k = String(keyinfo || '');
	if (/_password$/.test(k)) return 'password';
	if (/_2fa$/.test(k)) return 'token';
	if (/_otp$/.test(k)) return 'otp';
	if (/token|otp|code|kod/i.test(prompt || '')) return 'token';
	return 'secret';
}

module.exports = { LogParser, STAGES, stripAnsi, levelOf, classifyError, classifyPrompt };
