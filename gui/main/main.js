'use strict';
const {
	app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, Notification, safeStorage, clipboard,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Store } = require('./store');
const { VpnSession } = require('./session');
const platform = require('./platform');
const command = require('./command');

const ASSETS = path.join(__dirname, '..', 'assets');
// Testing hooks (never set in normal use)
const TEST_PRIVILEGE = (!app.isPackaged && process.env.OFVGUI_PRIVILEGE) || null;
const TEST_BINARY = (!app.isPackaged && process.env.OFVGUI_BINARY) || null;

let win = null;
let tray = null;
let store = null;
let session = null;
let status = { state: 'idle' };
let logBuffer = [];
let quitting = false;
const pendingPrompts = new Map();
const rejectedPasswords = new Set(); // profile ids whose saved password was refused

// isolated profile directory for tests (dev builds only)
if (!app.isPackaged && process.env.OFVGUI_USER_DATA) app.setPath('userData', process.env.OFVGUI_USER_DATA);

if (!app.requestSingleInstanceLock()) {
	app.quit();
}
app.on('second-instance', () => showWindow());

/* --------------------------------------------------------------------------- */
function send(channel, payload) {
	if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function showWindow() {
	if (!win || win.isDestroyed()) createWindow();
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
	if (process.platform === 'darwin') app.dock?.show();
}

function notify(title, body) {
	if (!store.getSettings().notifications || !Notification.isSupported()) return;
	const n = new Notification({ title, body, silent: false });
	n.on('click', showWindow);
	n.show();
}

function createWindow() {
	const isMac = process.platform === 'darwin';
	win = new BrowserWindow({
		width: 1080,
		height: 720,
		minWidth: 860,
		minHeight: 580,
		show: false,
		title: 'openfortivpn Connect',
		backgroundColor: '#0f1115',
		titleBarStyle: isMac ? 'hiddenInset' : 'default',
		trafficLightPosition: { x: 16, y: 18 },
		icon: path.join(ASSETS, 'icon.png'),
		autoHideMenuBar: true,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
	win.once('ready-to-show', () => win.show());
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:\/\//.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});
	win.webContents.on('will-navigate', (e) => e.preventDefault());
	win.on('close', (e) => {
		if (quitting) return;
		// closing the window keeps the app running in the menu bar / tray only
		// (macOS: also removed from the Dock); quit from the tray menu or Cmd+Q
		if (store.getSettings().closeToTray && tray) {
			e.preventDefault();
			win.hide();
			if (process.platform === 'darwin') app.dock?.hide();
		}
	});
}

/* --- tray ------------------------------------------------------------------ */
function trayImage(state) {
	const name = state === 'connected' ? 'tray-on' : (state === 'connecting' || state === 'disconnecting') ? 'tray-busy' : 'tray-off';
	const file = path.join(ASSETS, process.platform === 'darwin' ? `${name}Template.png` : `${name}.png`);
	const img = nativeImage.createFromPath(file);
	if (process.platform === 'darwin') img.setTemplateImage(true);
	return img;
}

function createTray() {
	try {
		tray = new Tray(trayImage('idle'));
	} catch {
		tray = null;
		return;
	}
	tray.setToolTip('openfortivpn Connect');
	tray.on('click', () => { if (process.platform !== 'darwin') showWindow(); });
	updateTray();
}

const STATE_LABEL = {
	idle: 'Rozłączono',
	connecting: 'Łączenie…',
	connected: 'Połączono',
	disconnecting: 'Rozłączanie…',
	error: 'Błąd połączenia',
};

function updateTray() {
	if (!tray) return;
	tray.setImage(trayImage(status.state));
	const active = session && ['connecting', 'connected', 'disconnecting'].includes(status.state);
	const header = status.profileName && status.state !== 'idle'
		? `${STATE_LABEL[status.state]} — ${status.profileName}` : STATE_LABEL[status.state] || '';
	const profiles = store.listProfiles();
	const template = [
		{ label: header, enabled: false },
		...(status.state === 'connected' && status.info?.ip ? [{ label: `IP: ${status.info.ip}`, enabled: false }] : []),
		{ type: 'separator' },
		...(active
			? [{ label: 'Rozłącz', click: () => disconnect() }]
			: profiles.length
				? profiles.map((p) => ({ label: `Połącz: ${p.name}`, click: () => connect(p.id) }))
				: [{ label: 'Brak profili — otwórz okno', click: showWindow }]),
		{ type: 'separator' },
		{ label: 'Pokaż okno', click: showWindow },
		{ label: 'Zakończ', click: () => app.quit() },
	];
	tray.setContextMenu(Menu.buildFromTemplate(template));
	tray.setToolTip(`openfortivpn Connect — ${header}`);
	if (process.platform === 'darwin') tray.setTitle(status.state === 'connected' ? ' VPN' : '');
}

/* --- prompts ---------------------------------------------------------------- */
function askRenderer(req) {
	return new Promise((resolve) => {
		const id = crypto.randomUUID();
		pendingPrompts.set(id, resolve);
		showWindow();
		if (req.kind !== 'admin' && req.kind !== 'password') {
			notify('Wymagany kod 2FA', req.prompt || 'Podaj kod z tokena');
		}
		send('prompt', { id, ...req });
	});
}

function cancelAllPrompts() {
	for (const [id, resolve] of pendingPrompts) {
		resolve(null);
		send('prompt:close', { id });
	}
	pendingPrompts.clear();
}

/* --- session ---------------------------------------------------------------- */
function connect(profileId) {
	if (session && ['connecting', 'connected', 'disconnecting'].includes(status.state)) {
		return { ok: false, error: 'Najpierw zakończ bieżące połączenie.' };
	}
	const profile = store.getProfile(profileId);
	if (!profile) return { ok: false, error: 'Nie znaleziono profilu.' };
	const errors = command.validateProfile(profile);
	if (errors.length) return { ok: false, error: errors.join(' ') };

	const settings = store.getSettings();
	const binary = TEST_BINARY || platform.findBinary(profile.binaryPath);
	if (!binary) {
		return { ok: false, error: profile.binaryPath
			? `Plik ${profile.binaryPath} nie istnieje lub nie jest wykonywalny.`
			: 'Nie znaleziono openfortivpn. Zainstaluj go (brew install openfortivpn / sudo apt install openfortivpn) albo wskaż ścieżkę w profilu → Zaawansowane.' };
	}
	const perl = platform.findPerl();
	if (!perl) return { ok: false, error: 'Brak /usr/bin/perl — wymagany przez helper uprawnień.' };

	store.saveSettings({ lastProfileId: profileId });
	logBuffer = [];
	send('log:clear');
	const logDir = path.join(app.getPath('userData'), 'logs');
	let logFile = null;
	try {
		fs.mkdirSync(logDir, { recursive: true });
		logFile = path.join(logDir, 'last-session.log');
		fs.writeFileSync(logFile, '', { mode: 0o600 });
	} catch { logFile = null; }
	let usedSavedPassword = false;

	session = new VpnSession({
		profile,
		binary,
		perl,
		privilege: TEST_PRIVILEGE || settings.privilege,
		hooks: {
			askAdminPassword: async ({ attempt }) => {
				const s = store.getSettings();
				if (attempt === 1 && s.rememberAdminPassword) {
					const saved = store.getSecret('admin', 'password');
					if (saved) return saved;
				}
				if (attempt > 1) store.deleteSecret('admin', 'password');
				const ans = await askRenderer({ kind: 'admin', attempt, profileName: profile.name,
					canRemember: store.secureStorageAvailable(), remember: s.rememberAdminPassword });
				if (!ans) return null;
				if (ans.remember && store.secureStorageAvailable()) {
					store.saveSettings({ rememberAdminPassword: true });
					store.setSecret('admin', 'password', ans.value);
				}
				return ans.value;
			},
			askSecret: async (req) => {
				const current = store.getProfile(profileId) || profile;
				if (req.kind === 'password' && current.savePassword && !rejectedPasswords.has(profileId)) {
					const saved = store.getSecret(profileId, 'password');
					if (saved) { usedSavedPassword = true; return saved; }
				}
				const ans = await askRenderer({
					...req,
					profileName: current.name,
					username: current.username,
					host: current.host,
					twoFactor: current.twoFactor,
					canRemember: req.kind === 'password' && store.secureStorageAvailable(),
					remember: req.kind === 'password' && current.savePassword,
					rejected: req.kind === 'password' && rejectedPasswords.has(profileId),
				});
				if (!ans) return null;
				if (req.kind === 'password') {
					rejectedPasswords.delete(profileId);
					if (ans.remember && store.secureStorageAvailable()) {
						store.setSecret(profileId, 'password', ans.value);
						if (!current.savePassword) store.saveProfile({ ...current, savePassword: true });
					} else if (!ans.remember && current.savePassword) {
						store.saveProfile({ ...current, savePassword: false });
					}
					send('profiles:changed', store.listProfiles());
				}
				return ans.value;
			},
		},
	});
	const mySession = session;
	session.on('status', (st) => {
		if (mySession !== session) return;
		const prev = status.state;
		status = st;
		if (st.state === 'error' && st.error?.code === 'auth' && usedSavedPassword) {
			rejectedPasswords.add(profileId);
			st.error = { ...st.error, hint: `${st.error.hint} Zapisane hasło zostało odrzucone — przy następnym połączeniu GUI zapyta o nowe.` };
		}
		if (st.state !== prev) {
			if (st.state === 'connected') notify('VPN połączony', `${st.profileName}${st.info?.ip ? ` — IP ${st.info.ip}` : ''}`);
			else if (st.state === 'error') notify('VPN: błąd', st.error?.title || 'Połączenie nieudane');
			else if (st.state === 'idle' && prev === 'disconnecting') notify('VPN rozłączony', st.profileName || '');
			if (st.state === 'error' || st.state === 'idle') cancelAllPrompts();
		}
		send('status', st);
		updateTray();
	});
	session.on('log', (l) => {
		logBuffer.push(l);
		if (logFile) {
			try { fs.appendFileSync(logFile, `${new Date(l.ts).toISOString()} [${l.level}] ${l.text}\n`); } catch { /* ignore */ }
		}
		if (logBuffer.length > 5000) logBuffer.splice(0, logBuffer.length - 5000);
		send('log', l);
	});
	session.on('event', (ev) => {
		if (ev.type === 'saml') shell.openExternal(ev.url);
		if (ev.type === 'cert') send('cert', { profileId, cert: ev.cert });
	});
	session.start();
	return { ok: true };
}

function disconnect() {
	cancelAllPrompts();
	if (session) session.stop();
	return { ok: true };
}

/* --- IPC ---------------------------------------------------------------------- */
function registerIpc() {
	ipcMain.handle('app:info', async () => ({
		platform: process.platform,
		version: app.getVersion(),
		secureStorage: store.secureStorageAvailable(),
		testMode: Boolean(TEST_PRIVILEGE || TEST_BINARY),
	}));
	ipcMain.handle('profiles:list', () => store.listProfiles());
	ipcMain.handle('profiles:save', (_e, p) => {
		const errors = command.validateProfile(command.normalizeProfile(p));
		const saved = store.saveProfile(p);
		updateTray();
		return { profile: { ...saved, hasPassword: store.hasSecret(saved.id, 'password') }, errors };
	});
	ipcMain.handle('profiles:delete', (_e, id) => {
		if (session && status.profileId === id && status.state !== 'idle' && status.state !== 'error') {
			return { ok: false, error: 'Nie można usunąć aktywnego profilu.' };
		}
		store.deleteProfile(id);
		updateTray();
		return { ok: true };
	});
	ipcMain.handle('profiles:defaults', () => ({ ...command.DEFAULT_PROFILE }));
	ipcMain.handle('profiles:forgetPassword', (_e, id) => {
		store.deleteSecret(id, 'password');
		const p = store.getProfile(id);
		if (p) store.saveProfile({ ...p, savePassword: false });
		return store.listProfiles();
	});
	ipcMain.handle('profiles:setPassword', (_e, id, pw) => {
		if (!pw) return { ok: false };
		const ok = store.setSecret(id, 'password', pw);
		if (ok) {
			const p = store.getProfile(id);
			if (p) store.saveProfile({ ...p, savePassword: true });
			rejectedPasswords.delete(id);
		}
		return { ok };
	});
	ipcMain.handle('profiles:trustCert', (_e, id, digest) => {
		if (!/^[0-9a-f]{64}$/.test(digest)) return null;
		const p = store.addTrustedCert(id, digest);
		send('profiles:changed', store.listProfiles());
		return p;
	});
	ipcMain.handle('profiles:preview', (_e, p) => {
		try {
			const bin = TEST_BINARY || platform.findBinary(p.binaryPath) || p.binaryPath || 'openfortivpn';
			return { ok: true, text: command.commandPreview(p, bin), errors: command.validateProfile(command.normalizeProfile(p)) };
		} catch (e) {
			return { ok: false, text: '', errors: [e.message] };
		}
	});
	ipcMain.handle('import:command', (_e, text) => {
		try {
			return { ok: true, ...command.importCommand(text) };
		} catch (e) {
			return { ok: false, error: e.message };
		}
	});
	ipcMain.handle('import:configFile', async () => {
		const r = await dialog.showOpenDialog(win, {
			title: 'Wybierz plik konfiguracyjny openfortivpn',
			defaultPath: fs.existsSync('/opt/homebrew/etc/openfortivpn') ? '/opt/homebrew/etc/openfortivpn' : '/etc/openfortivpn',
			properties: ['openFile', 'showHiddenFiles'],
		});
		if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
		try {
			const text = fs.readFileSync(r.filePaths[0], 'utf8');
			return { ok: true, ...command.importConfigFile(text) };
		} catch (e) {
			return { ok: false, error: `Nie można odczytać pliku: ${e.message}` };
		}
	});
	ipcMain.handle('dialog:pickFile', async (_e, title) => {
		const r = await dialog.showOpenDialog(win, { title, properties: ['openFile', 'showHiddenFiles'] });
		return r.canceled ? null : r.filePaths[0];
	});
	ipcMain.handle('settings:get', () => store.getSettings());
	ipcMain.handle('settings:save', (_e, s) => store.saveSettings(s));
	ipcMain.handle('diagnostics', () => platform.diagnostics(store.getSettings()));
	ipcMain.handle('vpn:connect', (_e, id) => connect(id));
	ipcMain.handle('vpn:disconnect', () => disconnect());
	ipcMain.handle('vpn:status', () => ({ status, log: logBuffer }));
	ipcMain.on('prompt:answer', (_e, { id, value, remember }) => {
		const resolve = pendingPrompts.get(id);
		if (!resolve) return;
		pendingPrompts.delete(id);
		resolve(value == null ? null : { value: String(value), remember: Boolean(remember) });
	});
	ipcMain.handle('log:copy', () => {
		clipboard.writeText(logBuffer.map((l) => `${new Date(l.ts).toISOString()} ${l.text}`).join('\n'));
		return true;
	});
	ipcMain.handle('log:save', async () => {
		const r = await dialog.showSaveDialog(win, { defaultPath: `openfortivpn-${Date.now()}.log` });
		if (r.canceled || !r.filePath) return false;
		fs.writeFileSync(r.filePath, logBuffer.map((l) => `${new Date(l.ts).toISOString()} ${l.text}`).join('\n'));
		return true;
	});
	ipcMain.handle('shell:open', (_e, url) => {
		if (/^https?:\/\//.test(url)) shell.openExternal(url);
	});
}

/* --- lifecycle ------------------------------------------------------------------ */
app.whenReady().then(() => {
	store = new Store(app.getPath('userData'), safeStorage);
	registerIpc();
	createWindow();
	createTray();
	app.on('activate', showWindow);
	if (!app.isPackaged && process.env.OFVGUI_E2E_SCRIPT) {
		require(process.env.OFVGUI_E2E_SCRIPT)({ app, win, getStatus: () => status });
	}
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin' && !tray) app.quit();
});

app.on('before-quit', async (e) => {
	if (quitting) return;
	if (session && ['connecting', 'connected', 'disconnecting'].includes(status.state)) {
		e.preventDefault();
		quitting = true;
		disconnect();
		await session.waitForExit(25000);
		app.quit();
		return;
	}
	quitting = true;
});
