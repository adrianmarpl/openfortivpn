'use strict';
/*
 * One VPN session: privilege escalation -> wrapper -> openfortivpn.
 *
 * No Electron dependency; the GUI talks to it via `hooks`:
 *   hooks.askAdminPassword({ attempt })            -> Promise<string|null>
 *   hooks.askSecret({ kind, prompt, keyinfo, ... }) -> Promise<string|null>
 *
 * Emits:
 *   'status' (status object), 'log' ({ ts, level, text }), 'event' (parser event)
 */

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { LogParser, levelOf, classifyPrompt, stripAnsi } = require('./logparser');
const { buildArgs, normalizeProfile } = require('./command');

const SUDO_PROMPT = '[ofvgui-sudo-prompt]';
const HELPER_DIR = path.join(__dirname, '..', 'helper').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');

function pctEsc(s) {
	return String(s).replace(/[%\r\n\t\\]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}
function pctUnesc(s) {
	return String(s || '').replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

class VpnSession extends EventEmitter {
	/**
	 * @param {object} opts
	 *   profile, binary, privilege ('sudo'|'pkexec'|'sudo-nopasswd'|'none'), perl, hooks
	 */
	constructor(opts) {
		super();
		this.profile = normalizeProfile(opts.profile);
		this.binary = opts.binary;
		this.privilege = opts.privilege || 'sudo';
		this.perl = opts.perl || '/usr/bin/perl';
		this.hooks = opts.hooks || {};
		this.parser = new LogParser();
		this.secrets = new Set();
		this.status = {
			state: 'idle', // idle | connecting | connected | disconnecting | error
			stage: null, // privileges | tls | auth | tunnel | connected
			profileId: opts.profile.id,
			profileName: this.profile.name,
			info: null,
			connectedAt: null,
			error: null,
			note: null,
			pid: null,
			dns: null,
		};
		this.userStopped = false;
		this.sudoAttempts = 0;
		this.passwordAnswered = false;
		this.authenticated = false;
		this.wasConnected = false;
		this._stdoutBuf = '';
		this._pendingPrompts = new Set();
	}

	_set(patch) {
		Object.assign(this.status, patch);
		this.emit('status', { ...this.status });
	}

	_log(text, level) {
		let t = stripAnsi(text);
		for (const s of this.secrets) {
			if (s && s.length >= 3) t = t.split(s).join('••••••');
		}
		t = t.replace(/\b(password|credential|code|magic|ftmpush|code2|otp)=([^&\s"]*)/gi, '$1=••••••');
		t = t.replace(/(SVPNCOOKIE=)[^\s;&"]+/g, '$1••••••');
		t = t.replace(/(cookie_str=')[^']*/g, '$1••••••').replace(/('\?'\+')[^']+/g, '$1••••••');
		this.emit('log', { ts: Date.now(), level: level || levelOf(t), text: t });
	}

	async start() {
		this._set({ state: 'connecting', stage: 'privileges', error: null, note: null });
		this._log(`Profil: ${this.profile.name} → ${this.profile.host}:${this.profile.port}`, 'gui');

		try {
			this.tmpDir = fs.mkdtempSync(path.join(os.platform() === 'win32' ? os.tmpdir() : '/tmp', 'ofvgui-'));
			fs.chmodSync(this.tmpDir, 0o700);
			this.socketPath = path.join(this.tmpDir, 'pin.sock');
			const wrapper = path.join(this.tmpDir, 'ofv-wrapper.pl');
			const pinentry = path.join(this.tmpDir, 'ofv-pinentry.pl');
			fs.copyFileSync(path.join(HELPER_DIR, 'ofv-wrapper.pl'), wrapper);
			fs.copyFileSync(path.join(HELPER_DIR, 'ofv-pinentry.pl'), pinentry);
			fs.chmodSync(wrapper, 0o755);
			fs.chmodSync(pinentry, 0o755);
			// pinentry is executed by openfortivpn itself: needs an interpreter line
			const pin = fs.readFileSync(pinentry, 'utf8').replace(/^#!.*\n/, `#!${this.perl}\n`);
			fs.writeFileSync(pinentry, pin, { mode: 0o755 });

			await this._listen();

			const ofvArgs = buildArgs(this.profile, { pinentry });
			const dnsMode = this.profile.dnsMode === 'split' ? 'split' : 'none';
			const domains = this.profile.splitDomains.trim() || '-';
			const wrapperArgv = [this.perl, wrapper, this.socketPath, dnsMode, domains, this.binary, ...ofvArgs];

			this._log(`$ ${['openfortivpn', ...ofvArgs].join(' ')}`, 'gui');
			this._spawn(wrapperArgv);
		} catch (e) {
			this._fail({ code: 'internal', title: 'Nie udało się uruchomić', hint: e.message });
			this._cleanup();
		}
	}

	_spawn(argv) {
		let cmd;
		let args;
		switch (this.privilege) {
		case 'sudo':
			cmd = 'sudo';
			args = ['-S', '-p', SUDO_PROMPT, '--', ...argv];
			break;
		case 'sudo-nopasswd':
			cmd = 'sudo';
			args = ['-n', '--', ...argv];
			break;
		case 'pkexec':
			cmd = 'pkexec';
			args = argv;
			break;
		default:
			cmd = argv[0];
			args = argv.slice(1);
		}
		const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
		const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
		this.child = child;
		child.stdin.on('error', () => {});

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (d) => this._onStdout(d));
		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (d) => this._onStderr(d));
		child.on('error', (e) => {
			this._fail({ code: 'spawn', title: `Nie można uruchomić ${cmd}`, hint: e.message });
		});
		child.on('close', (code, signal) => this._onExit(code, signal));
		if (this.privilege === 'pkexec') this._set({ note: 'Potwierdź uprawnienia administratora w oknie systemowym.' });
	}

	_onStderr(d) {
		let text = d;
		if (text.includes(SUDO_PROMPT)) {
			text = text.split(SUDO_PROMPT).join('');
			this._answerSudo();
		}
		for (const line of text.split(/\r?\n/)) {
			if (!line.trim()) continue;
			if (/is not in the sudoers file|not allowed to execute/.test(line)) {
				this._fail({ code: 'sudoers', title: 'Brak uprawnień sudo',
					hint: 'Twoje konto nie może używać sudo. Na Linuksie wybierz pkexec albo dodaj konto do grupy sudo/admin.' });
			} else if (/a password is required|a terminal is required/.test(line)) {
				this._fail({ code: 'sudo-n', title: 'sudo wymaga hasła',
					hint: 'Tryb „sudo bez hasła” wymaga reguły NOPASSWD. Wybierz „sudo (hasło w aplikacji)”.' });
			} else if (/incorrect password attempts|Sorry, try again/.test(line)) {
				// handled through attempt counter
			}
			this._handleLine(line, true);
		}
	}

	async _answerSudo() {
		this.sudoAttempts += 1;
		if (this.sudoAttempts > 3) return;
		const pw = await (this.hooks.askAdminPassword
			? this.hooks.askAdminPassword({ attempt: this.sudoAttempts })
			: Promise.resolve(null));
		if (!this.child || this.child.exitCode !== null) return;
		if (pw == null) {
			this.userStopped = true;
			this._log('Anulowano podawanie hasła administratora.', 'gui');
			this.child.stdin.end();
			return;
		}
		this.secrets.add(pw);
		this.child.stdin.write(`${pw}\n`);
	}

	_onStdout(d) {
		this._stdoutBuf += d;
		let idx;
		while ((idx = this._stdoutBuf.indexOf('\n')) >= 0) {
			const line = this._stdoutBuf.slice(0, idx);
			this._stdoutBuf = this._stdoutBuf.slice(idx + 1);
			this._handleLine(line, false);
		}
	}

	_handleLine(rawLine, fromStderr) {
		const line = rawLine.replace(/\r$/, '');
		if (!line.trim()) return;
		if (line.startsWith('OFVGUI:')) {
			this._control(line.slice(7).trim().split(' '));
			return;
		}
		this._log(line, fromStderr && !/^(ERROR|WARN|INFO|DEBUG):/.test(line) ? 'warn' : undefined);
		for (const ev of this.parser.feed(line)) {
			this.emit('event', ev);
			if (ev.type === 'stage') {
				if (ev.stage === 'tunnel') this.authenticated = true;
				if (ev.stage === 'connected') {
					this.wasConnected = true;
					this._set({ state: 'connected', stage: 'connected', connectedAt: Date.now(), note: null, error: null });
				} else if (this.status.state === 'connecting') {
					this._set({ stage: ev.stage, note: null });
				}
			} else if (ev.type === 'note' && this.status.state === 'connecting') {
				this._set({ note: ev.text });
			} else if (ev.type === 'info') {
				this._set({ info: ev.info });
			} else if (ev.type === 'saml') {
				this._set({ stage: 'auth', note: 'Zaloguj się w przeglądarce (SAML). Otworzono stronę logowania.' });
			} else if (ev.type === 'closed' && this.status.state === 'connected' && this.profile.persistent > 0) {
				this._set({ state: 'connecting', stage: 'tls', note: 'Połączenie przerwane — ponawianie…', connectedAt: null });
			}
		}
	}

	_control(parts) {
		const [cmd, ...rest] = parts;
		if (cmd === 'PID') {
			this._set({ pid: Number(rest[0]), stage: 'tls', note: null });
			this._log(`Uprawnienia OK, openfortivpn PID ${rest[0]}`, 'gui');
		} else if (cmd === 'DNS') {
			const [what, ns, domains] = rest;
			if (what === 'applied') {
				this._set({ dns: { ns: (ns || '').split(','), domains: (domains || '').split(',') } });
				this._log(`Split DNS: ${domains} → ${ns}`, 'gui');
			} else if (what === 'removed') {
				this._log('Split DNS usunięty.', 'gui');
			} else {
				this._log(`Split DNS: ${rest.join(' ')}`, 'warn');
			}
		} else if (cmd === 'ERROR') {
			this._log(`wrapper: ${rest.join(' ')}`, 'error');
			if (rest[0] === 'binary-not-executable') {
				this.parser.firstError = { code: 'binary', title: 'Nie znaleziono openfortivpn',
					hint: `Plik ${rest[1]} nie istnieje lub nie jest wykonywalny.` };
			}
		} else if (cmd === 'STOPPING') {
			this._set({ state: 'disconnecting', note: 'Rozłączanie…' });
		}
	}

	_listen() {
		return new Promise((resolve, reject) => {
			this.server = net.createServer((sock) => this._onPinentry(sock));
			this.server.on('error', reject);
			this.server.listen(this.socketPath, () => {
				try {
					fs.chmodSync(this.socketPath, 0o600);
				} catch { /* ignore */ }
				resolve();
			});
		});
	}

	_onPinentry(sock) {
		sock.setEncoding('utf8');
		let buf = '';
		let done = false;
		sock.on('error', () => {});
		sock.on('data', async (d) => {
			buf += d;
			const idx = buf.indexOf('\n');
			if (idx < 0 || done) return;
			done = true;
			const [verb, keyinfo, prompt, desc, error] = buf.slice(0, idx).split('\t').map(pctUnesc);
			if (verb !== 'ASK') { sock.end('CANCEL\n'); return; }
			const kind = classifyPrompt(keyinfo, prompt);
			const req = { kind, keyinfo, prompt: (prompt || '').trim(), desc, error, profileId: this.status.profileId };
			this._pendingPrompts.add(sock);
			this._set({ stage: 'auth', note: kind === 'password' ? null : 'Brama prosi o kod uwierzytelniania dwuskładnikowego.' });
			this._log(`Brama prosi o: ${kind === 'password' ? 'hasło' : `kod (${req.prompt || kind})`}`, 'gui');
			let answer = null;
			try {
				answer = await (this.hooks.askSecret ? this.hooks.askSecret(req) : null);
			} catch { answer = null; }
			this._pendingPrompts.delete(sock);
			if (answer == null) {
				this._log('Anulowano.', 'gui');
				sock.end('CANCEL\n');
				return;
			}
			this.secrets.add(answer);
			if (kind === 'password') {
				this.passwordAnswered = true;
				this._schedulePushHint();
			} else {
				this._set({ note: 'Weryfikacja kodu…' });
			}
			sock.end(`PIN\t${pctEsc(answer)}\n`);
		});
	}

	_schedulePushHint() {
		if (this.profile.twoFactor === 'code') return;
		const delay = this.profile.twoFactor === 'push' ? 300 : 4000;
		setTimeout(() => {
			if (!this.authenticated && this.status.state === 'connecting' && this._pendingPrompts.size === 0) {
				this._set({ note: 'Jeśli używasz FortiToken Mobile — zatwierdź powiadomienie push na telefonie.' });
			}
		}, delay).unref?.();
	}

	stop() {
		if (!this.child || this.child.exitCode !== null) return;
		this.userStopped = true;
		this._set({ state: 'disconnecting', note: 'Rozłączanie…' });
		for (const s of this._pendingPrompts) s.end('CANCEL\n');
		try {
			this.child.stdin.write('stop\n');
		} catch { /* ignore */ }
		clearTimeout(this._killTimer);
		this._killTimer = setTimeout(() => {
			if (this.child && this.child.exitCode === null) {
				try { this.child.stdin.end(); } catch { /* ignore */ }
				if (this.privilege === 'none') this.child.kill('SIGKILL');
			}
		}, 30000);
		this._killTimer.unref?.();
	}

	/** resolves when the process has exited */
	waitForExit(timeoutMs = 25000) {
		if (!this.child || this.child.exitCode !== null || this._exited) return Promise.resolve();
		return new Promise((resolve) => {
			const t = setTimeout(resolve, timeoutMs);
			this.once('exit', () => { clearTimeout(t); resolve(); });
		});
	}

	_fail(err) {
		if (this.status.state === 'error') return;
		this._set({ state: 'error', error: err, note: null });
	}

	_onExit(code, signal) {
		this._exited = true;
		if (this._stdoutBuf) this._handleLine(this._stdoutBuf, false);
		this._stdoutBuf = '';
		clearTimeout(this._killTimer);
		this._log(`Proces zakończony (kod ${code ?? signal}).`, 'gui');

		if (this.status.state !== 'error') {
			if (this.userStopped) {
				this._set({ state: 'idle', stage: null, connectedAt: null, note: null, info: null, dns: null, pid: null });
			} else {
				let err = this.parser.firstError;
				if (!err && this.privilege === 'pkexec' && (code === 126 || code === 127)) {
					err = { code: 'pkexec', title: 'Nie przyznano uprawnień', hint: 'Okno uwierzytelniania zostało zamknięte lub odmówiono dostępu.' };
				}
				if (!err && this.privilege === 'sudo' && this.sudoAttempts > 0 && !this.status.pid) {
					err = { code: 'sudo-password', title: 'Błędne hasło administratora', hint: 'sudo odrzuciło hasło.' };
				}
				if (!err && this.wasConnected) {
					err = { code: 'dropped', title: 'Połączenie zostało przerwane', hint: 'Tunel został zamknięty przez bramę lub sieć.' };
				}
				if (!err) {
					err = { code: 'exit', title: `openfortivpn zakończył działanie (kod ${code ?? signal})`, hint: 'Szczegóły w dzienniku poniżej.' };
				}
				this._set({ state: 'error', error: err, connectedAt: null, note: null, pid: null });
			}
		} else {
			this._set({ connectedAt: null, pid: null });
		}
		this._cleanup();
		this.emit('exit', { code, signal });
	}

	_cleanup() {
		try { this.server?.close(); } catch { /* ignore */ }
		if (this.tmpDir) {
			try { fs.rmSync(this.tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}
}

module.exports = { VpnSession, SUDO_PROMPT, HELPER_DIR };
