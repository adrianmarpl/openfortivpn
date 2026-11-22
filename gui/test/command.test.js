'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildArgs, importCommand, importConfigFile, commandPreview, splitShell } = require('../main/command');
const { LogParser, classifyPrompt } = require('../main/logparser');

test('imports the known-working command line', () => {
	const { profile, warnings } = importCommand(`sudo openfortivpn vpn.example.com:443 \\
  -u jan.kowalski \\
  -v -v \\
  --set-dns=0`);
	assert.equal(profile.host, 'vpn.example.com');
	assert.equal(profile.port, 443);
	assert.equal(profile.username, 'jan.kowalski');
	assert.equal(profile.verbosity, 2);
	assert.equal(profile.dnsMode, 'none');
	assert.deepEqual(warnings, []);
	// and produces the same openfortivpn invocation (plus GUI plumbing)
	const args = buildArgs(profile, { pinentry: '/tmp/x/pin' });
	assert.deepEqual(args, ['vpn.example.com:443', '-c', '/dev/null', '-u', 'jan.kowalski',
		'--pinentry=/tmp/x/pin', '--set-routes=1', '--set-dns=0', '-v', '-v']);
	assert.equal(commandPreview(profile, '/opt/homebrew/bin/openfortivpn'),
		'sudo /opt/homebrew/bin/openfortivpn vpn.example.com:443 -u jan.kowalski --set-routes=1 --set-dns=0 -v -v');
});

test('import handles passwords, otp, unknown flags', () => {
	const { profile, warnings } = importCommand("openfortivpn vpn.x:10443 --username=a -p 'tajne' -o 1 --realm r --no-ftm-push --sni=foo --trusted-cert " + 'ab'.repeat(32));
	assert.equal(profile.port, 10443);
	assert.equal(profile.realm, 'r');
	assert.equal(profile.twoFactor, 'code');
	assert.equal(profile.trustedCerts.length, 1);
	assert.equal(profile.extraArgs, '--sni=foo');
	assert.equal(profile.dnsMode, 'openfortivpn');
	assert.equal(warnings.length, 3);
});

test('import config file', () => {
	const { profile } = importConfigFile('# c\nhost = vpn.y\nport = 8443\nusername = bob\nset-dns = 0\ntrusted-cert = ' + 'cd'.repeat(32));
	assert.equal(profile.host, 'vpn.y');
	assert.equal(profile.port, 8443);
	assert.equal(profile.dnsMode, 'none');
});

test('saml and 2fa modes', () => {
	const saml = buildArgs({ host: 'h', authMethod: 'saml', username: 'ignored', samlPort: 8021 }, { pinentry: '/p' });
	assert.ok(saml.includes('--saml-login=8021'));
	assert.ok(!saml.includes('-u'));
	assert.ok(!saml.some((a) => a.startsWith('--pinentry')));
	const code = buildArgs({ host: 'h', username: 'u', twoFactor: 'code', otpDelay: 3 });
	assert.ok(code.includes('--no-ftm-push'));
	assert.ok(code.includes('--otp-delay=3'));
	const split = buildArgs({ host: 'h', username: 'u', dnsMode: 'split' });
	assert.ok(split.includes('--set-dns=0'));
});

test('shell splitting', () => {
	assert.deepEqual(splitShell(`a 'b c' "d\\"e" f\\ g`), ['a', 'b c', 'd"e', 'f g']);
	assert.throws(() => splitShell("'x"));
});

test('prompt classification', () => {
	assert.equal(classifyPrompt('u_r_h_password'), 'password');
	assert.equal(classifyPrompt('u_r_h_2fa'), 'token');
	assert.equal(classifyPrompt('u_r_h_otp'), 'otp');
});

test('parser recognises ssl errors', () => {
	const p = new LogParser();
	const ev = p.feed('ERROR:  SSL_connect: error:00000000:lib(0)::reason(0) (ssl_error=5, errno=60 Operation timed out)');
	assert.equal(ev[0].error.code, 'tls');
});
