'use strict';
/*
 * Profiles and settings in <userData>/profiles.json, secrets encrypted with
 * Electron safeStorage (macOS Keychain / libsecret or KWallet on Linux).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { normalizeProfile } = require('./command');

const DEFAULT_SETTINGS = {
	privilege: process.platform === 'linux' ? 'pkexec' : 'sudo', // sudo | pkexec | sudo-nopasswd
	rememberAdminPassword: false,
	closeToTray: true,
	notifications: true,
	lastProfileId: null,
};

class Store {
	constructor(dir, safeStorage) {
		this.dir = dir;
		this.file = path.join(dir, 'profiles.json');
		this.secretsFile = path.join(dir, 'secrets.json');
		this.safeStorage = safeStorage;
		this.data = { version: 1, profiles: [], settings: { ...DEFAULT_SETTINGS } };
		this.secrets = {};
		this._load();
	}

	_load() {
		try {
			const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
			this.data.profiles = (d.profiles || []).map((p) => ({ ...normalizeProfile(p), id: p.id || crypto.randomUUID() }));
			this.data.settings = { ...DEFAULT_SETTINGS, ...(d.settings || {}) };
		} catch { /* first run */ }
		try {
			this.secrets = JSON.parse(fs.readFileSync(this.secretsFile, 'utf8'));
		} catch { this.secrets = {}; }
	}

	_write(file, obj) {
		fs.mkdirSync(this.dir, { recursive: true });
		const tmp = `${file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, file);
	}

	_save() {
		this._write(this.file, this.data);
	}

	listProfiles() {
		return this.data.profiles.map((p) => ({ ...p, hasPassword: this.hasSecret(p.id, 'password') }));
	}

	getProfile(id) {
		return this.data.profiles.find((p) => p.id === id) || null;
	}

	saveProfile(p) {
		const norm = { ...normalizeProfile(p), id: p.id || crypto.randomUUID() };
		const i = this.data.profiles.findIndex((x) => x.id === norm.id);
		if (i >= 0) this.data.profiles[i] = norm;
		else this.data.profiles.push(norm);
		if (!norm.savePassword) this.deleteSecret(norm.id, 'password');
		this._save();
		return norm;
	}

	deleteProfile(id) {
		this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
		this.deleteSecret(id, 'password');
		this._save();
	}

	addTrustedCert(id, digest) {
		const p = this.getProfile(id);
		if (!p) return null;
		p.trustedCerts = [...new Set([...(p.trustedCerts || []), digest])];
		return this.saveProfile(p);
	}

	getSettings() {
		return { ...this.data.settings, secureStorage: this.secureStorageAvailable() };
	}

	saveSettings(s) {
		const { secureStorage, ...rest } = s;
		this.data.settings = { ...this.data.settings, ...rest };
		if (!this.data.settings.rememberAdminPassword) this.deleteSecret('admin', 'password');
		this._save();
		return this.getSettings();
	}

	/* --- secrets ----------------------------------------------------------- */
	secureStorageAvailable() {
		try {
			if (!this.safeStorage?.isEncryptionAvailable()) return false;
			if (process.platform === 'linux' && this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') return false;
			return true;
		} catch { return false; }
	}

	setSecret(id, kind, value) {
		if (!this.secureStorageAvailable()) return false;
		this.secrets[`${id}:${kind}`] = this.safeStorage.encryptString(value).toString('base64');
		this._write(this.secretsFile, this.secrets);
		return true;
	}

	getSecret(id, kind) {
		const v = this.secrets[`${id}:${kind}`];
		if (!v || !this.secureStorageAvailable()) return null;
		try {
			return this.safeStorage.decryptString(Buffer.from(v, 'base64'));
		} catch { return null; }
	}

	hasSecret(id, kind) {
		return Boolean(this.secrets[`${id}:${kind}`]);
	}

	deleteSecret(id, kind) {
		const k = `${id}:${kind}`;
		if (k in this.secrets) {
			delete this.secrets[k];
			this._write(this.secretsFile, this.secrets);
		}
	}
}

module.exports = { Store, DEFAULT_SETTINGS };
