'use strict';
/*
 * Drives the real Electron UI against the mock openfortivpn.
 * Run: npm run e2e  (writes screenshots to $OFVGUI_SHOTS)
 */
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ app, win, getStatus }) => {
	const shots = process.env.OFVGUI_SHOTS;
	fs.mkdirSync(shots, { recursive: true });
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	const js = (code) => win.webContents.executeJavaScript(code);
	const shot = async (name) => {
		await sleep(400);
		const img = await win.webContents.capturePage();
		fs.writeFileSync(path.join(shots, `${name}.png`), img.toPNG());
	};
	const waitFor = async (code, ms = 15000) => {
		const t = Date.now();
		while (Date.now() - t < ms) {
			if (await js(code)) return true;
			await sleep(100);
		}
		throw new Error(`timeout: ${code}`);
	};
	const result = { steps: [] };
	const step = (s) => { result.steps.push(s); console.log('E2E', s); };
	try {
		await new Promise((r) => (win.webContents.isLoading() ? win.webContents.once('did-finish-load', r) : r()));
		await sleep(800);
		await shot('01-welcome');

		// import the known working command
		await js(`document.querySelector('#w-import').click()`);
		await waitFor(`!!document.querySelector('#imp-text')`);
		await js(`document.querySelector('#imp-text').value = 'sudo openfortivpn sslvpn.example.pl:443 \\\\\\n  -u jan.kowalski \\\\\\n  -v -v \\\\\\n  --set-dns=0'`);
		await shot('02-import');
		await js(`document.querySelector('[data-x="yes"]').click()`);
		await waitFor(`!!document.querySelector('#btn-save')`);
		await shot('03-config');
		step('imported: ' + await js(`document.querySelector('#preview').textContent`));
		await js(`document.querySelector('#btn-save').click()`);
		await waitFor(`!!document.querySelector('#btn-connect')`);
		await shot('04-profile');

		// connect: password prompt
		await js(`document.querySelector('#btn-connect').click()`);
		await waitFor(`!!document.querySelector('#p-val')`);
		await shot('05-password');
		await js(`document.querySelector('#p-val').value = 'secret pass%'; document.querySelector('#p-form').requestSubmit()`);
		step('password sent');
		// token prompt
		await waitFor(`!!document.querySelector('.otp-input')`);
		await shot('06-token');
		await js(`document.querySelector('#p-val').value = '123456'; document.querySelector('#p-form').requestSubmit()`);
		step('token sent');
		await waitFor(`document.querySelector('.hero-state')?.textContent === 'Połączono'`);
		await sleep(1200);
		await shot('07-connected');
		step('connected: ' + JSON.stringify(getStatus().info));
		const log = await js(`document.querySelector('#log-body').innerText`);
		if (log.includes('123456') || log.includes('secret pass')) throw new Error('secret leaked into log view');

		// disconnect
		await js(`document.querySelector('#btn-disconnect').click()`);
		await waitFor(`document.querySelector('.hero-state')?.textContent === 'Rozłączono'`);
		await shot('08-disconnected');
		step('disconnected');

		// certificate flow
		process.env.MOCK_SCENARIO = 'cert';
		await js(`document.querySelector('#btn-connect').click()`);
		await waitFor(`!!document.querySelector('.fingerprint')`);
		await shot('09-cert');
		await js(`[...document.querySelectorAll('[data-x="yes"]')].pop().click()`);
		await waitFor(`!!document.querySelector('#p-val')`);
		await js(`document.querySelector('#p-val').value = 'secret pass%'; document.querySelector('#p-form').requestSubmit()`);
		await waitFor(`!!document.querySelector('.otp-input')`);
		await js(`document.querySelector('#p-val').value = '999999'; document.querySelector('#p-form').requestSubmit()`);
		await waitFor(`document.querySelector('.hero-state')?.textContent === 'Połączenie nieudane'`);
		await shot('10-auth-error');
		step('cert trusted + wrong token -> error shown');

		// settings & diagnostics
		await js(`document.querySelector('#btn-edit').click()`);
		await sleep(300);
		await js(`document.querySelector('#content').scrollTop = 600`);
		await shot('11-config-2fa');
		await js(`document.querySelector('#btn-settings').click()`);
		await shot('12-settings');
		result.ok = true;
	} catch (e) {
		result.ok = false;
		result.error = e.stack;
		await shot('99-failure').catch(() => {});
	}
	fs.writeFileSync(path.join(shots, 'result.json'), JSON.stringify(result, null, 2));
	console.log('E2E RESULT', JSON.stringify(result));
	app.exit(result.ok ? 0 : 1);
};
