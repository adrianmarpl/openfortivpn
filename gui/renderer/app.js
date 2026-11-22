'use strict';
/* global ofv */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
	shield: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z"/></svg>',
	shieldOk: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>',
	shieldX: '<svg viewBox="0 0 24 24"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3Z"/><path d="m9.5 9.5 5 5m0-5-5 5"/></svg>',
	power: '<svg viewBox="0 0 24 24"><path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.8 0"/></svg>',
	key: '<svg viewBox="0 0 24 24"><circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/></svg>',
	phone: '<svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>',
	lock: '<svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
	info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
	alert: '<svg viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
	cert: '<svg viewBox="0 0 24 24"><path d="M12 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M8.2 13.9 7 22l5-3 5 3-1.2-8.1"/></svg>',
	chevron: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
	copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
	download: '<svg viewBox="0 0 24 24"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
	trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/></svg>',
	check: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
	x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
	dup: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/></svg>',
};

const STATE_TEXT = {
	idle: 'Rozłączono',
	connecting: 'Łączenie…',
	connected: 'Połączono',
	disconnecting: 'Rozłączanie…',
	error: 'Połączenie nieudane',
};
const STEPS = [
	{ id: 'privileges', label: 'Uprawnienia' },
	{ id: 'tls', label: 'Połączenie TLS' },
	{ id: 'auth', label: 'Logowanie / 2FA' },
	{ id: 'tunnel', label: 'Tunel PPP' },
	{ id: 'connected', label: 'Połączono' },
];

const S = {
	app: {},
	profiles: [],
	selectedId: null,
	tab: 'connect',
	status: { state: 'idle' },
	logs: [],
	showDebug: false,
	logCollapsed: false,
	draft: null,
	draftIsNew: false,
	dirty: false,
	importWarnings: [],
	settings: {},
	lastStage: null,
	certs: {}, // profileId -> cert
};

/* --------------------------------------------------------------------------- */
function toast(text, kind) {
	const el = document.createElement('div');
	el.className = `toast ${kind || ''}`;
	el.textContent = text;
	$('#toast-root').append(el);
	setTimeout(() => el.remove(), 3500);
}

function selected() {
	return S.profiles.find((p) => p.id === S.selectedId) || null;
}

function activeSession() {
	return S.status && ['connecting', 'connected', 'disconnecting'].includes(S.status.state);
}

function fmtDuration(ms) {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`;
}

/* --- sidebar ----------------------------------------------------------------- */
function renderSidebar() {
	const list = $('#profile-list');
	if (!S.profiles.length && !S.draftIsNew) {
		list.innerHTML = '<div class="profile-empty">Brak profili.</div>';
		return;
	}
	const items = S.profiles.map((p) => {
		const st = S.status.profileId === p.id ? S.status.state : 'idle';
		return `<button class="profile-item ${p.id === S.selectedId && !S.draftIsNew ? 'active' : ''}" data-id="${esc(p.id)}">
			<span class="dot ${esc(st)}"></span>
			<span class="pi-text"><div class="pi-name">${esc(p.name || p.host)}</div><div class="pi-host">${esc(p.username ? `${p.username}@` : '')}${esc(p.host)}${p.port && p.port !== 443 ? `:${p.port}` : ''}</div></span>
		</button>`;
	});
	if (S.draftIsNew) {
		items.push(`<button class="profile-item active"><span class="dot"></span><span class="pi-text"><div class="pi-name">${esc(S.draft.name || 'Nowy profil')}</div><div class="pi-host">niezapisany</div></span></button>`);
	}
	list.innerHTML = items.join('');
	$$('.profile-item[data-id]', list).forEach((b) => b.addEventListener('click', () => selectProfile(b.dataset.id)));
}

async function confirmDiscard() {
	if (!S.dirty) return true;
	return confirmModal('Niezapisane zmiany', 'Masz niezapisane zmiany w konfiguracji profilu. Odrzucić je?', 'Odrzuć zmiany');
}

async function selectProfile(id, tab) {
	if (id === S.selectedId && !S.draftIsNew && !tab) return;
	if (!(await confirmDiscard())) return;
	S.selectedId = id;
	S.draftIsNew = false;
	S.dirty = false;
	S.draft = null;
	S.importWarnings = [];
	if (tab) S.tab = tab;
	renderSidebar();
	renderMain();
}

async function newProfile(fromImport, warnings) {
	if (!(await confirmDiscard())) return;
	const defaults = await ofv.profileDefaults();
	S.draft = { ...defaults, ...(fromImport || {}), id: undefined };
	S.draft.trustedCerts = [...(S.draft.trustedCerts || [])];
	S.draftIsNew = true;
	S.dirty = Boolean(fromImport);
	S.importWarnings = warnings || [];
	S.tab = 'config';
	renderSidebar();
	renderMain();
}

/* --- main -------------------------------------------------------------------- */
function renderMain() {
	const main = $('#main');
	const p = S.draftIsNew ? S.draft : selected();
	if (!p) {
		main.innerHTML = `<div class="main-header drag" style="border:0"></div><div class="content">
			<div class="welcome">
				<div class="brand-mark">${ICON.shield}</div>
				<h1>Witaj w openfortivpn Connect</h1>
				<p>Utwórz profil połączenia z bramą FortiGate SSL-VPN albo wklej polecenie, którym łączysz się teraz w terminalu — np. <code>sudo openfortivpn vpn.firma.pl:443 -u jan --set-dns=0</code>.</p>
				<div class="actions">
					<button class="btn primary big" id="w-new">Nowy profil</button>
					<button class="btn big" id="w-import">Importuj z polecenia</button>
				</div>
			</div></div>`;
		$('#w-new').onclick = () => newProfile();
		$('#w-import').onclick = () => openImport();
		return;
	}
	const sub = S.draftIsNew ? 'Nowy profil — uzupełnij i zapisz'
		: `${p.username ? `${p.username} @ ` : ''}${p.host}:${p.port}`;
	main.innerHTML = `
		<div class="main-header drag">
			<div class="main-title"><h1>${esc(p.name || p.host || 'Nowy profil')}</h1><div class="sub">${esc(sub)}</div></div>
			<div class="tabs">
				<button class="tab ${S.tab === 'connect' ? 'active' : ''}" data-tab="connect" ${S.draftIsNew ? 'disabled' : ''}>Połączenie</button>
				<button class="tab ${S.tab === 'config' ? 'active' : ''}" data-tab="config">Konfiguracja</button>
			</div>
		</div>
		<div class="content" id="content"></div>
		<div id="footer-slot"></div>`;
	$$('.tab', main).forEach((t) => t.addEventListener('click', async () => {
		if (t.dataset.tab === S.tab || t.disabled) return;
		if (t.dataset.tab === 'connect' && !(await confirmDiscard())) return;
		if (t.dataset.tab === 'connect') { S.dirty = false; S.draft = null; }
		S.tab = t.dataset.tab;
		renderMain();
	}));
	if (S.tab === 'config' || S.draftIsNew) renderConfig();
	else renderConnect();
}

/* --- connect view --------------------------------------------------------------- */
function renderConnect() {
	const c = $('#content');
	$('#footer-slot').innerHTML = '';
	const p = selected();
	const mine = S.status.profileId === p.id;
	const st = mine ? S.status : { state: 'idle' };
	const busy = activeSession() && !mine;
	const ringIcon = st.state === 'connected' ? ICON.shieldOk : st.state === 'error' ? ICON.shieldX : ICON.shield;

	let actions;
	if (st.state === 'connected' || st.state === 'connecting') {
		actions = `<button class="btn big danger-outline" id="btn-disconnect">${ICON.power}${st.state === 'connecting' ? 'Przerwij' : 'Rozłącz'}</button>`;
	} else if (st.state === 'disconnecting') {
		actions = '<button class="btn big" disabled>Rozłączanie…</button>';
	} else {
		actions = `<button class="btn big primary" id="btn-connect" ${busy ? 'disabled' : ''}>${ICON.power}Połącz</button>`;
	}
	actions += '<button class="btn ghost small" id="btn-edit">Edytuj konfigurację</button>';

	const authLabel = p.authMethod === 'saml' ? 'SAML (przeglądarka)' : p.authMethod === 'cert' ? 'certyfikat' : 'hasło';
	const tfa = p.authMethod === 'saml' ? '' : p.twoFactor === 'push' ? ' + FortiToken push' : p.twoFactor === 'code' ? ' + kod OTP' : ' + 2FA na żądanie';
	const subtitle = st.state === 'connected'
		? `Tunel aktywny przez <code>${esc(p.host)}</code>`
		: busy ? `Aktywne jest inne połączenie (${esc(S.status.profileName)}).`
			: `<code>${esc(p.host)}:${esc(p.port)}</code> · logowanie: ${esc(authLabel + tfa)}`;

	c.innerHTML = `
		<section class="hero">
			<div class="ring ${esc(st.state)}">${ringIcon}</div>
			<div>
				<div class="hero-state">${esc(STATE_TEXT[st.state] || '')}</div>
				<div class="hero-sub">${subtitle}</div>
			</div>
			<div class="hero-actions">${actions}</div>
		</section>
		${renderStepper(st)}
		<div id="banners">${renderBanners(st, p)}</div>
		${st.state === 'connected' ? renderInfo(st) : ''}
		<section class="log-panel ${S.logCollapsed ? 'collapsed' : ''}" id="log-panel">
			<div class="log-head">
				<button class="icon-btn" id="log-toggle" title="Zwiń/rozwiń">${ICON.chevron}</button>
				<span class="title">Dziennik połączenia</span>
				<label><input type="checkbox" id="log-debug" ${S.showDebug ? 'checked' : ''}> DEBUG</label>
				<button class="btn ghost small" id="log-copy">${ICON.copy}Kopiuj</button>
				<button class="btn ghost small" id="log-save">${ICON.download}Zapisz</button>
			</div>
			<div class="log-body" id="log-body"></div>
		</section>`;

	$('#log-toggle').style.transform = S.logCollapsed ? '' : 'rotate(90deg)';
	$('#btn-connect')?.addEventListener('click', () => doConnect(p.id));
	$('#btn-disconnect')?.addEventListener('click', () => ofv.disconnect());
	$('#btn-edit').addEventListener('click', () => { S.tab = 'config'; renderMain(); });
	$('#log-toggle').addEventListener('click', () => { S.logCollapsed = !S.logCollapsed; renderConnect(); });
	$('#log-debug').addEventListener('change', (e) => { S.showDebug = e.target.checked; renderLog(); });
	$('#log-copy').addEventListener('click', async () => { await ofv.copyLog(); toast('Skopiowano dziennik'); });
	$('#log-save').addEventListener('click', async () => { if (await ofv.saveLog()) toast('Zapisano dziennik'); });
	bindBannerActions(p);
	renderLog();
}

function renderStepper(st) {
	if (st.state === 'idle' && !st.stage) return '';
	const idx = STEPS.findIndex((s) => s.id === (st.stage || S.lastStage));
	return `<div class="stepper">${STEPS.map((s, i) => {
		let cls = '';
		if (st.state === 'connected' || i < idx) cls = 'done';
		else if (i === idx && (st.state === 'connecting')) cls = 'active';
		else if (i === idx && st.state === 'error') cls = 'failed';
		return `<div class="step ${cls}"><div class="step-bar"></div><div class="step-label">${esc(s.label)}</div></div>`;
	}).join('')}</div>`;
}

function renderBanners(st, p) {
	const out = [];
	if (st.note && st.state !== 'error') {
		const isPush = /push/.test(st.note);
		out.push(`<div class="banner">${isPush ? ICON.phone : ICON.info}<div><div class="b-title">${esc(st.note)}</div></div></div>`);
	}
	if (st.state === 'error' && st.error) {
		const cert = S.certs[p.id];
		const certBtn = st.error.code === 'cert' && cert ? '<button class="btn small primary" data-act="trust">Sprawdź i zaufaj certyfikatowi</button>' : '';
		const pwBtn = st.error.code === 'auth' && p.hasPassword ? '<button class="btn small" data-act="forget">Usuń zapisane hasło</button>' : '';
		const tlsBtn = st.error.code === 'tls' ? '<button class="btn small" data-act="edit-adv">Ustawienia TLS</button>' : '';
		out.push(`<div class="banner error">${ICON.alert}<div style="flex:1;min-width:0">
			<div class="b-title">${esc(st.error.title)}</div>
			<div class="b-text">${esc(st.error.hint || '')}</div>
			${st.error.line ? `<div class="b-line">${esc(st.error.line)}</div>` : ''}
			<div class="b-actions">${certBtn}<button class="btn small" data-act="retry">Spróbuj ponownie</button>${pwBtn}${tlsBtn}</div>
		</div></div>`);
	}
	if (st.state === 'connected' && p.dnsMode === 'none') {
		out.push(`<div class="banner warn">${ICON.info}<div><div class="b-title">DNS systemu nie został zmieniony (--set-dns=0)</div>
			<div class="b-text">Nazwy wewnętrzne mogą się nie rozwiązywać. Możesz włączyć „Split DNS” w konfiguracji profilu (sekcja Sieć i DNS).</div></div></div>`);
	}
	return out.join('');
}

function bindBannerActions(p) {
	$$('#banners [data-act]').forEach((b) => b.addEventListener('click', async () => {
		const act = b.dataset.act;
		if (act === 'retry') doConnect(p.id);
		if (act === 'trust') openCertModal(p.id, S.certs[p.id]);
		if (act === 'forget') {
			S.profiles = await ofv.forgetPassword(p.id);
			toast('Usunięto zapisane hasło');
			renderConnect();
		}
		if (act === 'edit-adv') { S.tab = 'config'; renderMain(); const d = $('#adv'); if (d) { d.open = true; d.scrollIntoView(); } }
	}));
}

function renderInfo(st) {
	const i = st.info || {};
	const dns = st.dns ? `${st.dns.domains.join(', ')} → ${st.dns.ns.join(', ')}` : (i.dns || []).join(', ') || '—';
	return `<div class="info-grid">
		<div class="info-card"><div class="k">Adres IP</div><div class="v">${esc(i.ip || '—')}</div></div>
		<div class="info-card"><div class="k">Interfejs</div><div class="v">${esc(i.iface || '—')}</div></div>
		<div class="info-card"><div class="k">${st.dns ? 'Split DNS' : 'DNS VPN'}</div><div class="v" title="${esc(dns)}">${esc(dns)}</div></div>
		<div class="info-card"><div class="k">Czas połączenia</div><div class="v" id="uptime">${st.connectedAt ? fmtDuration(Date.now() - st.connectedAt) : '—'}</div></div>
	</div>`;
}

function logLineHtml(l) {
	const t = new Date(l.ts);
	const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
	return `<div class="log-line ${esc(l.level)}"><span class="ts">${ts}</span>${esc(l.text)}</div>`;
}

function renderLog() {
	const body = $('#log-body');
	if (!body) return;
	const lines = S.logs.filter((l) => S.showDebug || l.level !== 'debug');
	body.innerHTML = lines.length ? lines.map(logLineHtml).join('') : '<div class="log-empty">Dziennik pojawi się po rozpoczęciu łączenia.</div>';
	body.scrollTop = body.scrollHeight;
}

function appendLog(l) {
	S.logs.push(l);
	if (S.logs.length > 5000) S.logs.splice(0, S.logs.length - 5000);
	const body = $('#log-body');
	if (!body || (!S.showDebug && l.level === 'debug')) return;
	const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
	$('.log-empty', body)?.remove();
	body.insertAdjacentHTML('beforeend', logLineHtml(l));
	if (atBottom) body.scrollTop = body.scrollHeight;
}

async function doConnect(id) {
	const r = await ofv.connect(id);
	if (!r.ok) {
		toast(r.error, 'error');
	}
}

/* --- config view ------------------------------------------------------------------ */
function field(label, inner, opts = {}) {
	return `<div class="field ${opts.span || 'span-6'}" ${opts.show === false ? 'hidden' : ''}>
		${label ? `<label class="lbl">${esc(label)}</label>` : ''}${inner}${opts.help ? `<div class="help">${opts.help}</div>` : ''}</div>`;
}
const inp = (k, v, attrs = '') => `<input class="input ${attrs.includes('mono') ? 'mono' : ''}" data-k="${k}" value="${esc(v)}" ${attrs.replace('mono', '')}>`;
const chk = (k, v, title, desc) => `<label class="check"><input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}><span><div>${esc(title)}</div>${desc ? `<div class="c-desc">${desc}</div>` : ''}</span></label>`;
function choices(k, value, items) {
	return `<div class="choice-list">${items.map((it) => `<label class="choice ${value === it.v ? 'on' : ''}">
		<input type="radio" name="${k}" data-k="${k}" value="${esc(it.v)}" ${value === it.v ? 'checked' : ''}>
		<span><div class="c-title">${esc(it.t)}</div><div class="c-desc">${it.d}</div></span></label>`).join('')}</div>`;
}

function renderConfig() {
	if (!S.draft) {
		const p = selected();
		S.draft = JSON.parse(JSON.stringify(p));
	}
	const d = S.draft;
	const c = $('#content');
	const mac = S.app.platform === 'darwin';
	const pw = d.authMethod === 'password';

	c.innerHTML = `
		${S.importWarnings.length ? `<div class="banner warn" style="margin:0 0 16px">${ICON.info}<div><div class="b-title">Zaimportowano — sprawdź ustawienia i zapisz profil</div>${S.importWarnings.map((w) => `<div class="b-text">• ${esc(w)}</div>`).join('')}</div></div>` : ''}
		<section class="form-card">
			<h3>Brama VPN</h3><div class="card-sub">Adres bramy FortiGate SSL-VPN, tak jak w <code>openfortivpn host:port</code>.</div>
			<div class="grid">
				${field('Nazwa profilu', inp('name', d.name, 'placeholder="np. Firma"'), { span: 'span-6' })}
				${field('Host', inp('host', d.host, 'placeholder="vpn.firma.pl" spellcheck="false" autocapitalize="off"'), { span: 'span-4' })}
				${field('Port', inp('port', d.port, 'type="number" min="1" max="65535"'), { span: 'span-2' })}
				${field('Realm (opcjonalnie)', inp('realm', d.realm, 'spellcheck="false"'), { span: 'span-3', help: 'Odpowiada <code>--realm</code>, jeśli brama używa ścieżki /remote/login?realm=…' })}
			</div>
		</section>

		<section class="form-card">
			<h3>Logowanie</h3><div class="card-sub">Hasło i kody są przekazywane do openfortivpn przez bezpieczny kanał pinentry — nigdy przez linię poleceń.</div>
			<div class="grid">
				${field('Metoda', `<div class="seg" data-seg="authMethod">
					<button data-v="password" class="${d.authMethod === 'password' ? 'on' : ''}">Login i hasło</button>
					<button data-v="saml" class="${d.authMethod === 'saml' ? 'on' : ''}">SAML / SSO</button>
					<button data-v="cert" class="${d.authMethod === 'cert' ? 'on' : ''}">Certyfikat</button></div>`)}
				${field('Nazwa użytkownika', inp('username', d.username, 'spellcheck="false" autocapitalize="off" placeholder="jan.kowalski"'), { span: 'span-3', show: d.authMethod !== 'saml' })}
				${field('Hasło', `<div class="input-row"><input class="input" type="password" id="pw-input" placeholder="${d.hasPassword ? '•••••••• (zapisane w pęku kluczy)' : 'zostanie zapytane przy łączeniu'}" ${S.app.secureStorage ? '' : 'disabled'}>
					${d.hasPassword ? '<button class="btn small" id="pw-forget" type="button">Usuń</button>' : ''}</div>`,
		{ span: 'span-3', show: pw, help: S.app.secureStorage ? 'Puste = GUI zapyta przy każdym połączeniu. Wpisane hasło trafi do ' + (mac ? 'pęku kluczy macOS.' : 'magazynu kluczy (libsecret).') : 'Magazyn kluczy niedostępny — GUI zapyta o hasło przy łączeniu.' })}
				${field('', chk('savePassword', d.savePassword, 'Zapamiętaj hasło', 'Zapisywane zaszyfrowane w systemowym magazynie kluczy.'), { span: 'span-6', show: pw && S.app.secureStorage })}
				${field('Port nasłuchu SAML', inp('samlPort', d.samlPort, 'type="number"'), { span: 'span-2', show: d.authMethod === 'saml', help: 'GUI otworzy stronę logowania w przeglądarce.' })}
				${field('Certyfikat użytkownika (PEM)', `<div class="input-row">${inp('userCert', d.userCert, 'mono spellcheck="false"')}<button class="btn small" data-pick="userCert" type="button">Wybierz…</button></div>`, { span: 'span-3', show: d.authMethod === 'cert' })}
				${field('Klucz prywatny (PEM)', `<div class="input-row">${inp('userKey', d.userKey, 'mono spellcheck="false"')}<button class="btn small" data-pick="userKey" type="button">Wybierz…</button></div>`, { span: 'span-3', show: d.authMethod === 'cert' })}
			</div>
		</section>

		<section class="form-card" ${d.authMethod === 'saml' ? 'hidden' : ''}>
			<h3>Drugi składnik (2FA / token)</h3><div class="card-sub">Gdy brama zażąda kodu, GUI wyświetli okno z dokładnym komunikatem serwera.</div>
			${choices('twoFactor', d.twoFactor, [
		{ v: 'auto', t: 'Automatycznie', d: 'Jak w terminalu: push FortiToken, jeśli brama go oferuje, w przeciwnym razie pytanie o kod (FortiToken, e-mail, SMS).' },
		{ v: 'code', t: 'Zawsze wpisuj kod z tokena', d: 'Wyłącza push (<code>--no-ftm-push</code>) — wpisujesz 6 cyfr z FortiToken / aplikacji / SMS.' },
		{ v: 'push', t: 'FortiToken Mobile push', d: 'Zatwierdzasz logowanie powiadomieniem na telefonie.' },
	])}
			<div class="grid" style="margin-top:14px">
				${field('Opóźnienie OTP (s)', inp('otpDelay', d.otpDelay, 'type="number" min="0"'), { span: 'span-2', help: '<code>--otp-delay</code> — gdy kod przychodzi z opóźnieniem.' })}
				${field('Początek komunikatu OTP', inp('otpPrompt', d.otpPrompt, 'placeholder="Please"'), { span: 'span-4', help: '<code>--otp-prompt</code> — tylko jeśli brama używa niestandardowego tekstu.' })}
			</div>
		</section>

		<section class="form-card">
			<h3>Certyfikat bramy</h3><div class="card-sub">Jeśli certyfikat nie jest zaufany systemowo, GUI pokaże jego odcisk SHA-256 do akceptacji.</div>
			<div class="grid">
				${field('Zaufane odciski SHA-256 (--trusted-cert)', `<div class="chips" id="cert-chips">${d.trustedCerts.length ? d.trustedCerts.map((x, i) => `<span class="chip">${esc(x.slice(0, 16))}…${esc(x.slice(-8))}<button data-rmcert="${i}" title="Usuń">${ICON.x}</button></span>`).join('') : '<span class="help">brak</span>'}</div>
					<div class="input-row" style="margin-top:8px"><input class="input mono" id="cert-add" placeholder="wklej 64 znaki hex" spellcheck="false"><button class="btn small" id="cert-add-btn" type="button">Dodaj</button></div>`)}
				${field('Plik CA (opcjonalnie)', `<div class="input-row">${inp('caFile', d.caFile, 'mono spellcheck="false"')}<button class="btn small" data-pick="caFile" type="button">Wybierz…</button></div>`, { span: 'span-6' })}
			</div>
		</section>

		<section class="form-card">
			<h3>Sieć i DNS</h3><div class="card-sub">Trasy i serwery nazw przekazywane przez bramę.</div>
			${choices('dnsMode', d.dnsMode, [
		{ v: 'none', t: 'Nie zmieniaj DNS systemu', d: '<code>--set-dns=0</code> — najbezpieczniejsze, tak jak łączysz się teraz.' },
		{ v: 'split', t: 'Split DNS (zalecane)', d: mac ? 'Tylko wskazane domeny przez DNS VPN — pliki <code>/etc/resolver/&lt;domena&gt;</code>, usuwane po rozłączeniu.' : 'Tylko wskazane domeny przez DNS VPN — <code>resolvectl</code> (systemd-resolved) na interfejsie ppp.' },
		{ v: 'openfortivpn', t: 'openfortivpn ustawia DNS', d: '<code>--set-dns=1</code> — zastępuje resolv.conf' + (mac ? ' (na macOS często nie działa poprawnie).' : '.') },
	])}
			<div class="grid" style="margin-top:14px">
				${field('Domeny dla split DNS', inp('splitDomains', d.splitDomains, 'mono placeholder="firma.local, corp.firma.pl" spellcheck="false"'), { span: 'span-6', show: d.dnsMode === 'split', help: 'Rozdziel przecinkami. Puste = domena wyszukiwania przekazana przez bramę (ns_suffix).' })}
				${field('', chk('setRoutes', d.setRoutes, 'Ustaw trasy z bramy', '<code>--set-routes=1</code> — split tunneling wg polityki FortiGate.'), { span: 'span-3' })}
				${field('', chk('halfInternetRoutes', d.halfInternetRoutes, 'Trasy 0.0.0.0/1 + 128.0.0.0/1', '<code>--half-internet-routes</code> zamiast podmiany trasy domyślnej.'), { span: 'span-3' })}
				${field('', chk('pppdUsePeerdns', d.pppdUsePeerdns, 'pppd usepeerdns', '<code>--pppd-use-peerdns=1</code>'), { span: 'span-3' })}
				${field('Automatyczne wznawianie (s)', inp('persistent', d.persistent, 'type="number" min="0"'), { span: 'span-3', help: '<code>--persistent</code> — 0 = wyłączone.' })}
			</div>
		</section>

		<section class="form-card">
			<details class="adv" id="adv">
				<summary>${ICON.chevron}Zaawansowane</summary>
				<div class="grid">
					${field('Plik openfortivpn', `<div class="input-row">${inp('binaryPath', d.binaryPath, 'mono placeholder="automatycznie (np. /opt/homebrew/bin/openfortivpn)" spellcheck="false"')}<button class="btn small" data-pick="binaryPath" type="button">Wybierz…</button></div>`, { span: 'span-6', help: 'Puste = wykryj automatycznie. Możesz wskazać binarkę zbudowaną z tego repozytorium.' })}
					${field('Szczegółowość logu', `<select class="input" data-k="verbosity">${[0, 1, 2, 3].map((v) => `<option value="${v}" ${Number(d.verbosity) === v ? 'selected' : ''}>${['standard', '-v (debug)', '-v -v (szczegóły)', '-v -v -v (wszystko)'][v]}</option>`).join('')}</select>`, { span: 'span-3', help: Number(d.verbosity) >= 3 ? '<span class="caps-warn">Poziom -vvv może wypisywać dane logowania — GUI próbuje je maskować.</span>' : '' })}
					${field('Minimalny TLS', `<select class="input" data-k="minTls">${['', '1.0', '1.1', '1.2', '1.3'].map((v) => `<option value="${v}" ${d.minTls === v ? 'selected' : ''}>${v || 'domyślny'}</option>`).join('')}</select>`, { span: 'span-3' })}
					${field('Lista szyfrów (--cipher-list)', inp('cipherList', d.cipherList, 'mono spellcheck="false"'), { span: 'span-6' })}
					${field('', chk('seclevel1', d.seclevel1, 'Zezwól na starsze szyfrowanie (--seclevel-1)', 'Dla starszych FortiGate z kluczami RSA 1024 / SHA1.'), { span: 'span-3' })}
					${field('', chk('insecureSsl', d.insecureSsl, 'Niezabezpieczony TLS (--insecure-ssl)', 'Ostateczność — wyłącza część zabezpieczeń.'), { span: 'span-3' })}
					${field('Dodatkowe argumenty', inp('extraArgs', d.extraArgs, 'mono placeholder="--sni=vpn.firma.pl --pppd-log=/tmp/pppd.log" spellcheck="false"'), { span: 'span-6', help: 'Przekazywane bez zmian do openfortivpn.' })}
				</div>
			</details>
		</section>

		<section class="form-card">
			<h3>Równoważne polecenie</h3><div class="card-sub">Tak GUI uruchamia openfortivpn (dodatkowo: <code>-c /dev/null</code> i <code>--pinentry</code> do bezpiecznego przekazania hasła i kodów).</div>
			<div class="preview" id="preview">…</div>
			<div class="form-errors" id="form-errors"></div>
		</section>

`;
	$('#footer-slot').innerHTML = `<div class="footer-bar">
			${S.draftIsNew ? '' : `<button class="btn ghost small" id="btn-delete">${ICON.trash}Usuń profil</button><button class="btn ghost small" id="btn-dup">${ICON.dup}Duplikuj</button>`}
			<span class="spacer"></span>
			<span class="dirty" id="dirty-flag">${S.dirty ? 'Niezapisane zmiany' : ''}</span>
			<button class="btn" id="btn-cancel">Anuluj</button>
			<button class="btn primary" id="btn-save">${ICON.check}Zapisz</button>
			${S.draftIsNew ? '' : '<button class="btn primary" id="btn-save-connect">Zapisz i połącz</button>'}
		</div>`;

	bindConfig();
	updatePreview();
}

function markDirty() {
	S.dirty = true;
	const f = $('#dirty-flag');
	if (f) f.textContent = 'Niezapisane zmiany';
}

let previewTimer = null;
function updatePreview() {
	clearTimeout(previewTimer);
	previewTimer = setTimeout(async () => {
		const r = await ofv.preview(S.draft);
		const el = $('#preview');
		if (!el) return;
		el.textContent = r.text || '';
		$('#form-errors').textContent = (r.errors || []).join(' ');
	}, 120);
}

function bindConfig() {
	const c = $('#content');
	const f = $('#footer-slot');
	const rerenderKeys = new Set(['authMethod', 'twoFactor', 'dnsMode', 'savePassword', 'verbosity']);
	c.querySelectorAll('[data-k]').forEach((el) => {
		const k = el.dataset.k;
		const handler = () => {
			let v;
			if (el.type === 'checkbox') v = el.checked;
			else if (el.type === 'radio') { if (!el.checked) return; v = el.value; }
			else if (el.type === 'number' || k === 'verbosity') v = el.value === '' ? '' : Number(el.value);
			else v = el.value;
			S.draft[k] = v;
			markDirty();
			if (k === 'name' && S.draftIsNew) renderSidebar();
			if (rerenderKeys.has(k)) {
				const y = c.scrollTop;
				renderConfig();
				c.scrollTop = y;
			} else updatePreview();
		};
		el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio' ? 'change' : 'input', handler);
	});
	$$('[data-seg] button', c).forEach((b) => b.addEventListener('click', () => {
		S.draft[b.closest('[data-seg]').dataset.seg] = b.dataset.v;
		markDirty();
		const y = c.scrollTop;
		renderConfig();
		c.scrollTop = y;
	}));
	$$('[data-pick]', c).forEach((b) => b.addEventListener('click', async () => {
		const f = await ofv.pickFile('Wybierz plik');
		if (!f) return;
		S.draft[b.dataset.pick] = f;
		markDirty();
		const y = c.scrollTop;
		renderConfig();
		c.scrollTop = y;
	}));
	$$('[data-rmcert]', c).forEach((b) => b.addEventListener('click', () => {
		S.draft.trustedCerts.splice(Number(b.dataset.rmcert), 1);
		markDirty();
		renderConfig();
	}));
	$('#cert-add-btn').addEventListener('click', () => {
		const v = $('#cert-add').value.trim().toLowerCase().replace(/[:\s]/g, '');
		if (!/^[0-9a-f]{64}$/.test(v)) { toast('Odcisk SHA-256 to 64 znaki hex', 'error'); return; }
		if (!S.draft.trustedCerts.includes(v)) S.draft.trustedCerts.push(v);
		markDirty();
		renderConfig();
	});
	$('#pw-input')?.addEventListener('input', () => {
		markDirty();
		if ($('#pw-input').value && !S.draft.savePassword) {
			S.draft.savePassword = true;
			const cb = $('[data-k="savePassword"]');
			if (cb) cb.checked = true;
		}
	});
	$('#pw-forget')?.addEventListener('click', async () => {
		S.profiles = await ofv.forgetPassword(S.draft.id);
		S.draft.hasPassword = false;
		S.draft.savePassword = false;
		toast('Usunięto zapisane hasło');
		renderConfig();
	});
	$('#btn-cancel').addEventListener('click', () => {
		S.dirty = false;
		S.draft = null;
		S.importWarnings = [];
		if (S.draftIsNew) {
			S.draftIsNew = false;
			S.tab = 'connect';
			renderSidebar();
		} else S.tab = 'connect';
		renderMain();
	});
	$('#btn-save').addEventListener('click', () => saveDraft(false));
	$('#btn-save-connect')?.addEventListener('click', () => saveDraft(true));
	$('#btn-delete')?.addEventListener('click', async () => {
		if (!(await confirmModal('Usunąć profil?', `Profil „${S.draft.name}” i zapisane hasło zostaną usunięte.`, 'Usuń'))) return;
		const r = await ofv.deleteProfile(S.draft.id);
		if (!r.ok) { toast(r.error, 'error'); return; }
		S.dirty = false;
		S.draft = null;
		S.profiles = await ofv.listProfiles();
		S.selectedId = S.profiles[0]?.id || null;
		S.tab = 'connect';
		renderSidebar();
		renderMain();
	});
	$('#btn-dup')?.addEventListener('click', () => {
		const copy = { ...S.draft, name: `${S.draft.name} (kopia)`, hasPassword: false, savePassword: false };
		delete copy.id;
		S.dirty = false;
		newProfile(copy);
	});
}

async function saveDraft(andConnect) {
	const pwValue = $('#pw-input')?.value || '';
	const r = await ofv.saveProfile(S.draft);
	if (r.errors?.length && andConnect) {
		toast(r.errors.join(' '), 'error');
	}
	if (pwValue && r.profile.savePassword) {
		const ok = await ofv.setPassword(r.profile.id, pwValue);
		if (!ok.ok) toast('Nie udało się zapisać hasła w magazynie kluczy', 'error');
	}
	S.profiles = await ofv.listProfiles();
	S.selectedId = r.profile.id;
	if (S.draftIsNew) S.tab = 'connect';
	S.draftIsNew = false;
	S.dirty = false;
	S.draft = null;
	S.importWarnings = [];
	toast(r.errors?.length ? `Zapisano (uwaga: ${r.errors.join(' ')})` : 'Zapisano profil');
	if (andConnect && !r.errors?.length) {
		S.tab = 'connect';
		renderSidebar();
		renderMain();
		doConnect(r.profile.id);
		return;
	}
	renderSidebar();
	renderMain();
}

/* --- modals ---------------------------------------------------------------------- */
let modalQueue = Promise.resolve();

function openModal(html, { wide = false, onMount, dismissable = true } = {}) {
	const root = $('#modal-root');
	const wrap = document.createElement('div');
	wrap.className = 'modal-backdrop';
	wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
	root.append(wrap);
	const close = () => wrap.remove();
	if (dismissable) {
		wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) wrap.dispatchEvent(new CustomEvent('dismiss')); });
	}
	onMount?.(wrap, close);
	const first = wrap.querySelector('[autofocus]') || wrap.querySelector('input, button');
	setTimeout(() => first?.focus(), 30);
	return { el: wrap, close };
}

function confirmModal(title, text, okLabel) {
	return new Promise((resolve) => {
		openModal(`<div class="modal-icon warn">${ICON.alert}</div><h2>${esc(title)}</h2><div class="m-text">${esc(text)}</div>
			<div class="m-actions"><button class="btn" data-x="no">Anuluj</button><button class="btn primary" data-x="yes" autofocus>${esc(okLabel || 'OK')}</button></div>`, {
			onMount: (el, close) => {
				const done = (v) => { close(); resolve(v); };
				el.querySelector('[data-x="no"]').onclick = () => done(false);
				el.querySelector('[data-x="yes"]').onclick = () => done(true);
				el.addEventListener('dismiss', () => done(false));
				el.addEventListener('keydown', (e) => { if (e.key === 'Escape') done(false); });
			},
		});
	});
}

const openPrompts = new Map();

function showPrompt(req) {
	let icon; let title; let text; let inputHtml; let extra = '';
	if (req.kind === 'admin') {
		icon = `<div class="modal-icon info">${ICON.lock}</div>`;
		title = 'Hasło administratora';
		text = `openfortivpn wymaga uprawnień root (tworzy interfejs ppp i trasy). Podaj hasło swojego konta${S.app.platform === 'darwin' ? ' macOS' : ''} (sudo).`;
		inputHtml = '<input class="input" type="password" id="p-val" autofocus autocomplete="current-password">';
		if (req.attempt > 1) extra += '<div class="form-errors">Hasło niepoprawne — spróbuj ponownie.</div>';
	} else if (req.kind === 'password') {
		icon = `<div class="modal-icon">${ICON.key}</div>`;
		title = 'Hasło do VPN';
		text = `Konto <b>${esc(req.username || '')}</b> na <code>${esc(req.host || '')}</code>`;
		inputHtml = '<input class="input" type="password" id="p-val" autofocus autocomplete="current-password">';
		if (req.rejected) extra += '<div class="form-errors">Poprzednio zapisane hasło zostało odrzucone przez bramę.</div>';
	} else {
		icon = `<div class="modal-icon">${ICON.phone}</div>`;
		title = 'Kod uwierzytelniania dwuskładnikowego';
		const serverPrompt = req.prompt && !/^Two-factor authentication token:?$/.test(req.prompt) ? req.prompt : '';
		text = serverPrompt
			? `Brama: „${esc(serverPrompt)}”`
			: 'Wpisz aktualny kod z FortiToken / aplikacji uwierzytelniającej lub kod z SMS / e-maila.';
		inputHtml = '<input class="input otp-input" id="p-val" autofocus inputmode="numeric" autocomplete="one-time-code" spellcheck="false" placeholder="••••••">';
		extra += '<div class="help" style="font-size:12px;color:var(--text-3);margin-top:8px">Kod jest ważny krótko — wpisz go od razu. Wysyłany jest tylko do openfortivpn przez kanał pinentry.</div>';
	}
	const remember = req.canRemember
		? `<label class="check" style="margin-top:12px"><input type="checkbox" id="p-rem" ${req.remember ? 'checked' : ''}><span>Zapamiętaj w ${S.app.platform === 'darwin' ? 'pęku kluczy' : 'magazynie kluczy'}</span></label>` : '';

	const m = openModal(`${icon}<h2>${esc(title)}</h2><div class="m-text">${text}${req.profileName ? ` <span style="color:var(--text-3)">· ${esc(req.profileName)}</span>` : ''}</div>
		<form id="p-form">${inputHtml}${extra}${remember}
		<div class="m-actions"><button class="btn" type="button" data-x="cancel">Anuluj</button><button class="btn primary" type="submit">Kontynuuj</button></div></form>`, {
		dismissable: false,
		onMount: (el, close) => {
			const finish = (value) => {
				openPrompts.delete(req.id);
				close();
				ofv.answerPrompt(req.id, value, el.querySelector('#p-rem')?.checked);
			};
			el.querySelector('#p-form').addEventListener('submit', (e) => {
				e.preventDefault();
				const v = el.querySelector('#p-val').value;
				if (!v) { el.querySelector('#p-val').focus(); return; }
				finish(req.kind === 'password' || req.kind === 'admin' ? v : v.trim());
			});
			el.querySelector('[data-x="cancel"]').onclick = () => finish(null);
			el.addEventListener('keydown', (e) => { if (e.key === 'Escape') finish(null); });
		},
	});
	openPrompts.set(req.id, m);
}

function openCertModal(profileId, cert) {
	const p = S.profiles.find((x) => x.id === profileId);
	const pretty = cert.digest.match(/.{2}/g).join(':');
	openModal(`<div class="modal-icon warn">${ICON.cert}</div><h2>Nieznany certyfikat bramy</h2>
		<div class="m-text">Certyfikat <code>${esc(p?.host || '')}</code> nie jest zaufany przez system. Porównaj odcisk z tym, który podał administrator VPN — akceptuj tylko, jeśli się zgadza.</div>
		<div class="kv">
			<div class="k">Podmiot</div><div class="v">${esc(cert.subject.join(', ') || '—')}</div>
			<div class="k">Wystawca</div><div class="v">${esc(cert.issuer.join(', ') || '—')}</div>
		</div>
		<div style="margin-top:12px" class="lbl">Odcisk SHA-256</div>
		<div class="fingerprint">${esc(pretty)}</div>
		<div class="m-actions"><button class="btn" data-x="no">Anuluj</button><button class="btn primary" data-x="yes">Zaufaj i połącz</button></div>`, {
		wide: true,
		onMount: (el, close) => {
			el.querySelector('[data-x="no"]').onclick = close;
			el.addEventListener('dismiss', close);
			el.querySelector('[data-x="yes"]').onclick = async () => {
				close();
				await ofv.trustCert(profileId, cert.digest);
				S.profiles = await ofv.listProfiles();
				delete S.certs[profileId];
				toast('Dodano zaufany certyfikat');
				doConnect(profileId);
			};
		},
	});
}

function openImport() {
	openModal(`<div class="modal-icon info">${ICON.download}</div><h2>Importuj konfigurację</h2>
		<div class="m-text">Wklej polecenie, którym łączysz się w terminalu. Hasło i kod OTP nie są importowane — GUI zapyta o nie bezpiecznie.</div>
		<textarea class="input" id="imp-text" rows="5" spellcheck="false" autofocus placeholder="sudo openfortivpn vpn.firma.pl:443 \\
  -u jan.kowalski \\
  -v -v \\
  --set-dns=0"></textarea>
		<div class="form-errors" id="imp-err"></div>
		<div class="m-actions"><button class="btn ghost" data-x="file" style="margin-right:auto">Plik config…</button><button class="btn" data-x="no">Anuluj</button><button class="btn primary" data-x="yes">Importuj</button></div>`, {
		wide: true,
		onMount: (el, close) => {
			el.querySelector('[data-x="no"]').onclick = close;
			el.addEventListener('dismiss', close);
			el.querySelector('[data-x="yes"]').onclick = async () => {
				const r = await ofv.importCommand(el.querySelector('#imp-text').value);
				if (!r.ok) { el.querySelector('#imp-err').textContent = r.error; return; }
				close();
				newProfile(r.profile, r.warnings);
			};
			el.querySelector('[data-x="file"]').onclick = async () => {
				const r = await ofv.importConfigFile();
				if (r.canceled) return;
				if (!r.ok) { el.querySelector('#imp-err').textContent = r.error; return; }
				close();
				newProfile(r.profile, r.warnings);
			};
		},
	});
}

async function openSettings() {
	const s = await ofv.getSettings();
	const linux = S.app.platform === 'linux';
	const opts = [
		{ v: 'sudo', t: 'sudo — hasło w aplikacji', d: 'GUI pyta o hasło konta i przekazuje je do sudo. Działa na macOS i Linux.' },
		...(linux ? [{ v: 'pkexec', t: 'pkexec (polkit)', d: 'Systemowe okno uwierzytelniania Ubuntu/Debian.' }] : []),
		{ v: 'sudo-nopasswd', t: 'sudo bez hasła', d: 'Wymaga reguły NOPASSWD w /etc/sudoers.d dla /usr/bin/perl — tylko dla zaawansowanych.' },
	];
	openModal(`<div class="modal-icon info">${ICON.lock}</div><h2>Ustawienia</h2>
		<div class="lbl" style="margin:6px 0 8px;font-weight:600">Uprawnienia administratora</div>
		${choices('privilege', s.privilege, opts)}
		<div style="margin-top:14px">
			${chk('rememberAdminPassword', s.rememberAdminPassword && s.secureStorage, 'Zapamiętaj hasło administratora', s.secureStorage ? 'Zaszyfrowane w magazynie kluczy systemu.' : 'Magazyn kluczy niedostępny.')}
			${chk('closeToTray', s.closeToTray, S.app.platform === 'darwin' ? 'Zamknięcie okna chowa aplikację do paska menu' : 'Zamknięcie okna chowa aplikację do zasobnika', S.app.platform === 'darwin' ? 'Aplikacja znika z Docka i działa dalej jako ikona w pasku menu (połączenie pozostaje aktywne). Zakończ ją z menu ikony lub ⌘Q.' : 'Połączenie pozostaje aktywne; zakończ aplikację z menu ikony w zasobniku.')}
			${chk('notifications', s.notifications, 'Powiadomienia systemowe', 'O połączeniu, rozłączeniu i prośbie o kod 2FA.')}
		</div>
		<div class="m-actions"><button class="btn" data-x="no">Anuluj</button><button class="btn primary" data-x="yes">Zapisz</button></div>`, {
		onMount: (el, close) => {
			if (!s.secureStorage) el.querySelector('[data-k="rememberAdminPassword"]').disabled = true;
			el.querySelectorAll('.choice input').forEach((r) => r.addEventListener('change', () => {
				el.querySelectorAll('.choice').forEach((c) => c.classList.toggle('on', c.querySelector('input').checked));
			}));
			el.querySelector('[data-x="no"]').onclick = close;
			el.addEventListener('dismiss', close);
			el.querySelector('[data-x="yes"]').onclick = async () => {
				const next = {
					privilege: el.querySelector('input[name="privilege"]:checked')?.value || s.privilege,
					rememberAdminPassword: el.querySelector('[data-k="rememberAdminPassword"]').checked,
					closeToTray: el.querySelector('[data-k="closeToTray"]').checked,
					notifications: el.querySelector('[data-k="notifications"]').checked,
				};
				S.settings = await ofv.saveSettings(next);
				close();
				toast('Zapisano ustawienia');
			};
		},
	});
}

async function openDiagnostics() {
	const m = openModal('<h2>Diagnostyka</h2><div class="m-text">Sprawdzanie…</div>', { wide: true });
	const d = await ofv.diagnostics();
	m.el.querySelector('.modal').innerHTML = `<div class="modal-icon info">${ICON.check}</div><h2>Diagnostyka</h2>
		<div class="m-text">Elementy potrzebne do połączenia (${esc(d.platform === 'darwin' ? 'macOS' : 'Linux')}).</div>
		<div class="diag-list">${d.checks.map((c) => `<div class="diag-item"><span class="${c.ok ? (c.optional ? 'opt' : 'ok') : 'bad'}">${c.ok ? ICON.check : ICON.x}</span>
			<div style="min-width:0"><div class="d-label">${esc(c.label)}</div><div class="d-detail">${esc(c.detail)}</div></div></div>`).join('')}</div>
		<div class="m-actions"><button class="btn primary" data-x="ok">Zamknij</button></div>`;
	m.el.querySelector('[data-x="ok"]').onclick = m.close;
	m.el.addEventListener('dismiss', m.close);
}

/* --- live updates ------------------------------------------------------------------ */
function onStatus(st) {
	const prevState = S.status.state;
	S.status = st;
	if (st.stage) S.lastStage = st.stage;
	renderSidebar();
	if (S.tab === 'connect' && !S.draftIsNew && selected()) {
		if (st.profileId !== S.selectedId && st.state === 'connecting' && prevState !== 'connecting') {
			S.selectedId = st.profileId;
			renderSidebar();
			renderMain();
		} else renderConnect();
	}
}

async function init() {
	S.app = await ofv.appInfo();
	document.body.classList.toggle('mac', S.app.platform === 'darwin');
	S.settings = await ofv.getSettings();
	S.profiles = await ofv.listProfiles();
	const { status, log } = await ofv.getStatus();
	S.status = status;
	S.logs = log || [];
	S.selectedId = (status.profileId && S.profiles.some((p) => p.id === status.profileId) ? status.profileId : null)
		|| (S.profiles.some((p) => p.id === S.settings.lastProfileId) ? S.settings.lastProfileId : S.profiles[0]?.id) || null;

	$('#btn-new').onclick = () => newProfile();
	$('#btn-import').onclick = openImport;
	$('#btn-settings').onclick = openSettings;
	$('#btn-diag').onclick = openDiagnostics;

	ofv.onStatus(onStatus);
	ofv.onLog(appendLog);
	ofv.onLogClear(() => { S.logs = []; S.lastStage = null; renderLog(); });
	ofv.onPrompt((req) => { modalQueue = modalQueue.then(() => showPrompt(req)); });
	ofv.onPromptClose(({ id }) => { openPrompts.get(id)?.close(); openPrompts.delete(id); });
	ofv.onCert(({ profileId, cert }) => {
		S.certs[profileId] = cert;
		if (S.selectedId === profileId) openCertModal(profileId, cert);
	});
	ofv.onProfilesChanged((list) => {
		S.profiles = list;
		renderSidebar();
	});

	setInterval(() => {
		const u = $('#uptime');
		if (u && S.status.connectedAt) u.textContent = fmtDuration(Date.now() - S.status.connectedAt);
	}, 1000);

	renderSidebar();
	renderMain();
}

init();
