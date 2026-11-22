'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { VpnSession } = require('../main/session');

const MOCK = path.join(__dirname, 'mock-openfortivpn.js');
fs.chmodSync(MOCK, 0o755);

function run(scenario, { answers = {}, profile = {}, stopWhenConnected = true } = {}) {
	process.env.MOCK_SCENARIO = scenario;
	const prompts = [];
	const logs = [];
	const states = [];
	const events = [];
	const s = new VpnSession({
		profile: { id: 'p1', name: 'Test', host: 'vpn.example.com', port: 443, username: 'jan', ...profile },
		binary: MOCK,
		privilege: 'none',
		hooks: {
			askSecret: async (req) => { prompts.push(req); return answers[req.kind] ?? null; },
		},
	});
	s.on('log', (l) => logs.push(l.text));
	s.on('event', (e) => events.push(e));
	s.on('status', (st) => {
		states.push(st.state + (st.stage ? `/${st.stage}` : ''));
		if (st.state === 'connected' && stopWhenConnected) setTimeout(() => s.stop(), 50);
	});
	return new Promise((resolve) => {
		s.on('exit', () => resolve({ s, prompts, logs, states, events }));
		s.start();
	});
}

test('password + 2FA token -> connected -> clean disconnect', async () => {
	const r = await run('ok', { answers: { password: 'secret pass%', token: '123456' } });
	assert.deepEqual(r.prompts.map((p) => p.kind), ['password', 'token']);
	assert.equal(r.prompts[1].prompt, 'Two-factor authentication token:');
	assert.ok(r.states.includes('connected/connected'), r.states.join(' '));
	assert.equal(r.s.status.state, 'idle');
	assert.equal(r.s.status.error, null);
	// secrets never reach the log
	const all = r.logs.join('\n');
	assert.ok(!all.includes('123456'), 'OTP leaked into log');
	assert.ok(!all.includes('secret pass%'), 'password leaked into log');
	assert.ok(all.includes('Logged out.'));
	assert.ok(!all.includes('Abc123'), 'session cookie leaked into log');
	const info = r.events.filter((e) => e.type === 'info').pop().info;
	assert.equal(info.ip, '10.212.134.5');
	assert.deepEqual(info.dns, ['10.0.0.53', '10.0.0.54']);
	assert.equal(info.iface, 'ppp0');
});

test('server OTP prompt (email/SMS) is relayed with its text', async () => {
	const r = await run('otp', { answers: { password: 'secret pass%', otp: '123456' } });
	assert.deepEqual(r.prompts.map((p) => p.kind), ['password', 'otp']);
	assert.equal(r.prompts[1].prompt, 'Please enter the code sent to your email');
	assert.equal(r.s.status.state, 'idle');
});

test('wrong token -> auth error', async () => {
	const r = await run('ok', { answers: { password: 'secret pass%', token: '000000' } });
	assert.equal(r.s.status.state, 'error');
	assert.equal(r.s.status.error.code, 'auth');
});

test('cancelling the token prompt -> cancelled error', async () => {
	const r = await run('ok', { answers: { password: 'secret pass%' } });
	assert.equal(r.s.status.state, 'error');
	assert.equal(r.s.status.error.code, 'cancelled');
});

test('untrusted certificate is reported with digest, trusting it connects', async () => {
	const r = await run('cert');
	const cert = r.events.find((e) => e.type === 'cert');
	assert.ok(cert, 'no cert event');
	assert.match(cert.cert.digest, /^[0-9a-f]{64}$/);
	assert.deepEqual(cert.cert.subject, ['CN = vpn.example.com']);
	assert.deepEqual(cert.cert.issuer, ['CN = Fortinet_CA_SSL']);
	assert.equal(r.s.status.error.code, 'cert');

	const r2 = await run('cert', { answers: { password: 'secret pass%', token: '123456' },
		profile: { trustedCerts: [cert.cert.digest] } });
	assert.ok(r2.states.includes('connected/connected'));
});

test('missing binary is reported', async () => {
	process.env.MOCK_SCENARIO = 'ok';
	const s = new VpnSession({ profile: { id: 'x', host: 'h', username: 'u' }, binary: '/nonexistent/openfortivpn', privilege: 'none' });
	await new Promise((resolve) => { s.on('exit', resolve); s.start(); });
	assert.equal(s.status.state, 'error');
	assert.equal(s.status.error.code, 'binary');
});
