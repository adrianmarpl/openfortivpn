#!/usr/bin/env node
'use strict';
/*
 * Fake openfortivpn for end-to-end tests of the GUI session pipeline.
 * Talks to --pinentry exactly like src/userinput.c does and prints the same
 * log lines as the real client. Scenario via MOCK_SCENARIO:
 *   ok        password + 2FA token, then tunnel up until SIGTERM
 *   otp       password + server OTP prompt (email/SMS style)
 *   cert      certificate not trusted (unless --trusted-cert matches)
 *   badpass   gateway rejects the password
 */
const { spawn } = require('node:child_process');

const DIGEST = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const argv = process.argv.slice(2);
const opt = (name) => {
	const a = argv.find((x) => x.startsWith(`--${name}=`));
	return a ? a.slice(name.length + 3) : null;
};
const scenario = process.env.MOCK_SCENARIO || 'ok';
const log = (lvl, msg) => process.stdout.write(`${lvl.padEnd(8)}${msg}\n`);
const info = (m) => log('INFO:', m);
const error = (m) => log('ERROR:', m);

function esc(s) {
	return s.replace(/[%\n\r]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function pinentry(hint, prompt) {
	return new Promise((resolve) => {
		const p = spawn(opt('pinentry'), [], { stdio: ['pipe', 'pipe', 'inherit'] });
		const cmds = ['SETTITLE VPN Password', 'SETDESC VPN Requires a Password',
			`SETKEYINFO ${esc(hint)}`, `SETPROMPT ${esc(prompt)}`, 'GETPIN'];
		let buf = '';
		let step = -1; // waiting for greeting
		p.stdout.setEncoding('utf8');
		p.stdout.on('data', (d) => {
			buf += d;
			while (buf.includes('\n')) {
				const chunk = buf; // emulate single read() like the C client
				buf = '';
				const first = chunk.split('\n')[0];
				if (step === cmds.length - 1) {
					p.stdin.end();
					if (first.startsWith('D ')) resolve(decodeURIComponent(first.slice(2).replace(/%(?![0-9a-fA-F]{2})/g, '%25')));
					else resolve('');
					return;
				}
				if (!first.startsWith('OK')) { p.stdin.end(); resolve(''); return; }
				step++;
				p.stdin.write(`${cmds[step]}\n`);
			}
		});
	});
}

async function main() {
	const user = argv[argv.indexOf('-u') + 1];
	const host = argv[0].split(':')[0];
	info(`mock openfortivpn, scenario ${scenario}`);
	if (scenario === 'cert' && !argv.includes(`--trusted-cert=${DIGEST}`)) {
		error('Gateway certificate validation failed, and the certificate digest is not in the local whitelist. If you trust it, rerun with:');
		error(`    --trusted-cert ${DIGEST}`);
		error('or add this line to your configuration file:');
		error(`    trusted-cert = ${DIGEST}`);
		error('Gateway certificate:');
		error('    subject:');
		error(`        CN = ${host}`);
		error('    issuer:');
		error('        CN = Fortinet_CA_SSL');
		error('    sha256 digest:');
		error(`        ${DIGEST}`);
		process.exit(1);
	}
	const pass = await pinentry(`${user}__${host}_password`, 'VPN account password: ');
	log('DEBUG:', `got password length ${pass.length}`);
	info('Connected to gateway.');
	if (scenario === 'badpass' || pass !== 'secret pass%') {
		error('Could not authenticate to the gateway. Please make sure tunnel mode is allowed by the gateway, check the realm, etc.');
		process.exit(1);
	}
	let code;
	if (scenario === 'otp') code = await pinentry(`${user}__${host}_otp`, 'Please enter the code sent to your email');
	else code = await pinentry(`${user}__${host}_2fa`, 'Two-factor authentication token: ');
	if (!code) { error('No token specified'); process.exit(1); }
	log('DEBUG:', `POST /remote/logincheck code=${code}&magic=xyz`);
	if (code !== '123456') {
		error('Could not authenticate to the gateway. Please make sure tunnel mode is allowed by the gateway, check the realm, etc.');
		process.exit(1);
	}
	log('DEBUG:', 'Cookie: SVPNCOOKIE=Abc123+/xyz==');
	info('Authenticated.');
	info('Remote gateway has allocated a VPN.');
	info('Got addresses: [10.212.134.5], ns [10.0.0.53, 10.0.0.54], ns_suffix [corp.example]');
	info('Negotiation complete.');
	info('Interface ppp0 is UP.');
	info('Setting new routes...');
	info('Tunnel is up and running.');
	const bye = () => {
		info('Cancelling threads...');
		info('Setting ppp0 interface down.');
		info('Restoring routes...');
		info('Closed connection to gateway.');
		info('Logged out.');
		process.exit(0);
	};
	process.on('SIGTERM', bye);
	process.on('SIGINT', bye);
	setInterval(() => {}, 1000);
}
main();
