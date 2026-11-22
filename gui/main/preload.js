'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
	const h = (_e, payload) => cb(payload);
	ipcRenderer.on(channel, h);
	return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('ofv', {
	appInfo: () => ipcRenderer.invoke('app:info'),
	listProfiles: () => ipcRenderer.invoke('profiles:list'),
	saveProfile: (p) => ipcRenderer.invoke('profiles:save', p),
	deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
	profileDefaults: () => ipcRenderer.invoke('profiles:defaults'),
	forgetPassword: (id) => ipcRenderer.invoke('profiles:forgetPassword', id),
	setPassword: (id, pw) => ipcRenderer.invoke('profiles:setPassword', id, pw),
	trustCert: (id, digest) => ipcRenderer.invoke('profiles:trustCert', id, digest),
	preview: (p) => ipcRenderer.invoke('profiles:preview', p),
	importCommand: (t) => ipcRenderer.invoke('import:command', t),
	importConfigFile: () => ipcRenderer.invoke('import:configFile'),
	pickFile: (title) => ipcRenderer.invoke('dialog:pickFile', title),
	getSettings: () => ipcRenderer.invoke('settings:get'),
	saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
	diagnostics: () => ipcRenderer.invoke('diagnostics'),
	connect: (id) => ipcRenderer.invoke('vpn:connect', id),
	disconnect: () => ipcRenderer.invoke('vpn:disconnect'),
	getStatus: () => ipcRenderer.invoke('vpn:status'),
	answerPrompt: (id, value, remember) => ipcRenderer.send('prompt:answer', { id, value, remember }),
	copyLog: () => ipcRenderer.invoke('log:copy'),
	saveLog: () => ipcRenderer.invoke('log:save'),
	openExternal: (url) => ipcRenderer.invoke('shell:open', url),
	onStatus: on('status'),
	onLog: on('log'),
	onLogClear: on('log:clear'),
	onPrompt: on('prompt'),
	onPromptClose: on('prompt:close'),
	onCert: on('cert'),
	onProfilesChanged: on('profiles:changed'),
});
