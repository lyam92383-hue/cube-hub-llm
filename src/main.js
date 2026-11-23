// Cube Hub LLM : le cube de Cube Hub branché sur les conversations de ton IA locale
// (Open WebUI + Ollama sur ton serveur). Adapté de github.com/Harlo9/cube-hub (MIT).
const {
  app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, screen,
  protocol, net, dialog, shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const url = require('url');

const paths = require('./paths');
const stateStore = require('./state');
const { WebUI, ChatStore } = require('./webui');
const { Notifier } = require('./notify');
const { Remote, LOG_FILE } = require('./remote');
const secrets = require('./secrets');

const ROOT = path.join(__dirname, '..');
const LINUX = process.platform === 'linux';
const ICON = path.join(ROOT, 'assets', LINUX ? 'icon.png' : 'icon.ico');
// Sur Ubuntu, Ctrl+Alt+L verrouille parfois l'écran : Ctrl+Alt+K à la place.
const HOTKEY = LINUX ? 'Control+Alt+K' : 'Control+Alt+L';
const HOTKEY_LABEL = LINUX ? 'Ctrl+Alt+K' : 'Ctrl+Alt+L';
const HALO_MARGIN = 20;
const APP_ID = 'com.cubehub.llm';

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
app.setAppUserModelId(APP_ID);

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const state = () => stateStore.get();
let widget = null;
let hub = null;
let welcome = null;
let tray = null;
let quitting = false;
let allChats = []; // toutes les conversations
let folders = [];
let serverStatus = { ok: false, error: null };
let notifier = null;
let remote = null;

// ---------------------------------------------------------------- Clé API (chiffrée par le système : DPAPI sous Windows, trousseau sous Linux)

let apiKey = null;
function readKey() {
  if (process.env.CUBE_LLM_KEY) return process.env.CUBE_LLM_KEY;
  if (apiKey != null) return apiKey;
  apiKey = secrets.read(paths.keyFile) || '';
  return apiKey;
}
function writeKey(key) {
  secrets.write(paths.keyFile, key);
  apiKey = key;
}

const api = new WebUI(() => ({ url: process.env.CUBE_LLM_URL || state().server.url, key: readKey() }));
const store = new ChatStore(api, {
  activeWindowMin: () => state().server.activeWindowMin || 30,
  onChange: (all, f) => {
    allChats = all;
    folders = f;
    const active = all.filter((c) => c.active);
    if (widget && !widget.isDestroyed()) widget.webContents.send('sessions', active);
    if (hub && !hub.isDestroyed()) hub.webContents.send('chats', { chats: all, folders });
    updateTrayMenu(active);
    notifier?.update(all);
  },
  onStatus: (s) => {
    serverStatus = s;
    broadcast('server:status', s);
    if (tray) tray.setToolTip(s.ok ? 'Cube Hub LLM' : `Cube Hub LLM — ${s.error || 'serveur injoignable'}`);
  },
});

// ---------------------------------------------------------------- Démarrage

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const u = new URL(request.url);
    const base = u.host === 'sons' ? paths.soundsDir : ROOT;
    const file = path.join(base, decodeURIComponent(u.pathname));
    if (!path.resolve(file).startsWith(path.resolve(base))) return new Response('interdit', { status: 403 });
    return net.fetch(url.pathToFileURL(file).toString());
  });

  const testing = process.env.CUBE_SNAPSHOT || process.env.CUBE_SCENARIO;
  if (testing) {
    stateStore.save = () => {};
    stateStore.saveNow = () => {};
    state().notifications.windows = false;
    if (process.env.CUBE_LLM_URL) state().server.url = process.env.CUBE_LLM_URL;
  }
  ensureStartMenuShortcut();
  notifier = new Notifier({ getSettings: state, onClick: (s) => openHub({ selectSession: s.id }), log: console.error });
  remote = new Remote({
    notifier,
    getSettings: state,
    save: () => stateStore.save(),
    sessions: () => allChats,
    sendToChat: (chatId, text, onCreated) => store.send(chatId, text, chatId ? null : state().server.defaultModel || allChats.find((c) => c.model)?.model || null, progress, onCreated),
    conversation: (id) => store.conversation(id),
    changed: () => broadcast('remote:status', remote.status()),
  });
  createTray();
  createWidget();
  globalShortcut.register(HOTKEY, toggleWidget);
  screen.on('display-removed', keepWidgetOnScreen);
  screen.on('display-metrics-changed', keepWidgetOnScreen);
  if (api.getServer().url) store.start();
  remote.sync();

  if (process.env.CUBE_SNAPSHOT) return snapshots(process.env.CUBE_SNAPSHOT);
  if (process.env.CUBE_SCENARIO) {
    require('./scenario')({ store, widget, openHub: (o) => openHub(o), getHub: () => hub, api, notifier, remote, state: state() }, process.env.CUBE_SCENARIO, console.log)
      .catch((e) => console.error(e))
      .finally(() => { quitting = true; app.exit(0); });
    return;
  }
  if (!state().server.url || !readKey()) openWelcome();
});

app.on('second-instance', () => openHub());
app.on('window-all-closed', (e) => e.preventDefault?.());
app.on('before-quit', () => {
  quitting = true;
  stateStore.saveNow();
});
app.on('will-quit', () => globalShortcut.unregisterAll());

function broadcast(channel, data) {
  for (const w of [widget, hub, welcome]) if (w && !w.isDestroyed()) w.webContents.send(channel, data);
}

// Réponse en train de s'écrire : le Hub l'affiche au fur et à mesure.
function progress(chatId, content) {
  if (hub && !hub.isDestroyed()) hub.webContents.send('chat:progress', { chatId, content });
}

function ensureStartMenuShortcut() {
  if (!app.isPackaged || process.platform !== 'win32') return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Cube Hub LLM.lnk');
    const wanted = { target: process.execPath, cwd: path.dirname(process.execPath), appUserModelId: APP_ID, icon: process.execPath, iconIndex: 0, description: 'Cube Hub LLM' };
    let current = null;
    try { current = shell.readShortcutLink(lnk); } catch {}
    if (!current || current.target !== wanted.target || current.appUserModelId !== wanted.appUserModelId) {
      shell.writeShortcutLink(lnk, current ? 'replace' : 'create', wanted);
    }
  } catch (e) {
    console.error('Raccourci du menu Démarrer :', e.message);
  }
}

const pageURL = (name) => `app://local/src/renderer/${name}.html`;
const preload = path.join(__dirname, 'preload.js');

function initData() {
  return {
    sessions: allChats.filter((c) => c.active),
    chats: allChats,
    folders,
    settings: state(),
    server: serverStatus,
    hotkey: HOTKEY_LABEL,
    platform: process.platform,
    customSounds: listCustomSounds(),
    hasKey: !!readKey(),
  };
}

// ---------------------------------------------------------------- Widget

function createWidget() {
  const s = state().widget;
  widget = new BrowserWindow({
    width: 400, height: 140, frame: false, transparent: true, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, maximizable: false,
    minimizable: false, fullscreenable: false, backgroundColor: '#00000000', icon: ICON,
    webPreferences: { preload, backgroundThrottling: false },
  });
  widget.setAlwaysOnTop(true, 'screen-saver');
  widget.setVisibleOnAllWorkspaces(true);
  widget.loadURL(pageURL('widget'));
  widget.webContents.on('did-finish-load', () => {
    widget.webContents.setZoomFactor(s.scale || 1);
    widget.webContents.send('init', initData());
  });
  widget.on('close', (e) => {
    if (!quitting) { e.preventDefault(); setWidgetVisible(false); }
  });
}

function widgetPosition(width, height) {
  const s = state().widget;
  const area = screen.getPrimaryDisplay().workArea;
  if (s.x == null || s.y == null) {
    s.x = area.x + area.width - 24 + HALO_MARGIN;
    s.y = area.y + 24 - HALO_MARGIN;
  }
  return { x: Math.round(s.x - width), y: Math.round(s.y), width, height };
}

ipcMain.on('widget:size', (_e, { width, height }) => {
  if (!widget) return;
  widget.setBounds(widgetPosition(Math.ceil(width), Math.ceil(height)));
  if (!widget.isVisible() && state().widget.visible) widget.showInactive();
});

let drag = null;
ipcMain.on('widget:drag', (_e, { phase }) => {
  if (!widget) return;
  const { x, y } = screen.getCursorScreenPoint();
  if (phase === 'start') {
    const b = widget.getBounds();
    drag = { x, y, bx: b.x, by: b.y, w: b.width, h: b.height };
  } else if (phase === 'move' && drag) {
    widget.setBounds({ x: drag.bx + (x - drag.x), y: drag.by + (y - drag.y), width: drag.w, height: drag.h });
  } else if (phase === 'end' && drag) {
    const b = widget.getBounds();
    state().widget.x = b.x + b.width;
    state().widget.y = b.y;
    stateStore.save();
    drag = null;
  }
});

ipcMain.on('widget:ignore-mouse', (_e, ignore) => {
  // Sous Linux, une fenêtre qui laisse passer les clics ne reçoit plus la souris du tout :
  // le widget resterait impossible à cliquer.
  if (LINUX) return;
  if (widget && !widget.isDestroyed()) widget.setIgnoreMouseEvents(ignore, { forward: true });
});

function keepWidgetOnScreen() {
  if (!widget) return;
  const b = widget.getBounds();
  const visible = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x + b.width > a.x + 40 && b.x < a.x + a.width - 40 && b.y + 40 < a.y + a.height && b.y + b.height > a.y;
  });
  if (!visible) {
    state().widget.x = null;
    state().widget.y = null;
    widget.setBounds(widgetPosition(b.width, b.height));
    stateStore.save();
  }
}

function setWidgetVisible(visible) {
  state().widget.visible = visible;
  stateStore.save();
  if (!widget) return;
  if (visible) widget.showInactive();
  else widget.hide();
  broadcast('settings', state());
  updateTrayMenu();
}
const toggleWidget = () => setWidgetVisible(!(widget && widget.isVisible()));

function setWidgetScale(scale) {
  state().widget.scale = scale;
  stateStore.save();
  if (widget) widget.webContents.setZoomFactor(scale);
  broadcast('settings', state());
}

let mouseTimer = null;
ipcMain.on('widget:follow-mouse', (_e, on) => {
  clearInterval(mouseTimer);
  mouseTimer = null;
  if (!on) return;
  mouseTimer = setInterval(() => {
    if (!widget || widget.isDestroyed() || !widget.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = widget.getContentBounds();
    widget.webContents.send('mouse', { x: p.x - b.x, y: p.y - b.y });
  }, 1000 / 30);
});

ipcMain.on('widget:menu', () => {
  const scale = state().widget.scale || 1;
  Menu.buildFromTemplate([
    { label: 'Ouvrir Cube Hub LLM', click: () => openHub() },
    { label: 'Ouvrir Open WebUI', click: () => openWebUI() },
    { label: `Masquer le widget (${HOTKEY_LABEL})`, click: () => setWidgetVisible(false) },
    { type: 'separator' },
    {
      label: 'Taille du widget',
      submenu: [1, 0.9, 0.8, 0.7, 0.6].map((v) => ({
        label: `${Math.round(v * 100)} %`, type: 'radio', checked: Math.abs(v - scale) < 0.01, click: () => setWidgetScale(v),
      })),
    },
    { label: 'Réglages…', click: () => openHub({ settings: true }) },
    { type: 'separator' },
    { label: 'Quitter Cube Hub LLM', click: () => app.quit() },
  ]).popup({ window: widget });
});

ipcMain.on('widget:collapsed', (_e, collapsed) => {
  state().widget.collapsed = collapsed;
  stateStore.save();
});

ipcMain.on('tray:image', (_e, { dataURL, mood }) => {
  if (!tray) return;
  const img = nativeImage.createFromDataURL(dataURL);
  if (!img.isEmpty()) tray.setImage(img);
  const label = { working: 'ton IA écrit', waiting: 'erreur', done: 'réponse prête', celebrating: 'réponse prête', sleeping: 'au repos' }[mood] || '';
  tray.setToolTip(serverStatus.ok || !state().server.url ? `Cube Hub LLM — ${label}` : `Cube Hub LLM — ${serverStatus.error || 'serveur injoignable'}`);
});

// ---------------------------------------------------------------- Zone de notification

function createTray() {
  const img = nativeImage.createFromPath(path.join(ROOT, 'assets', 'frames', 'menubar', 'Sommeil', '10_dort.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(ICON) : img.resize({ width: 20, height: 20 }));
  tray.setToolTip('Cube Hub LLM');
  tray.on('click', () => tray.popUpContextMenu());
  tray.on('double-click', () => openHub());
  updateTrayMenu();
}

const statusLabel = { working: 'écrit', waiting: 'erreur', done: 'prête' };
const statusEmoji = { working: '🔵', waiting: '🟠', done: '🟢' };

function updateTrayMenu(active = allChats.filter((c) => c.active)) {
  if (!tray) return;
  const items = !state().server.url
    ? [{ label: 'Serveur non réglé…', click: () => openWelcome() }]
    : !serverStatus.ok && serverStatus.error
      ? [{ label: `⚠️ ${serverStatus.error}`.slice(0, 80), enabled: false }]
      : active.length
        ? active.slice(0, 10).map((s) => ({ label: `${statusEmoji[s.status]}  ${s.projectName} — ${statusLabel[s.status]}`.slice(0, 80), click: () => openHub({ selectSession: s.id }) }))
        : [{ label: 'Aucune conversation récente', enabled: false }];
  tray.setContextMenu(Menu.buildFromTemplate([
    ...items,
    { type: 'separator' },
    { label: 'Ouvrir Cube Hub LLM', click: () => openHub() },
    { label: 'Nouvelle conversation', click: () => openHub({ newChat: true }) },
    { label: 'Ouvrir Open WebUI', click: () => openWebUI() },
    { label: `${widget && widget.isVisible() ? 'Masquer' : 'Afficher'} le widget (${HOTKEY_LABEL})`, click: toggleWidget },
    { label: 'Réglages…', click: () => openHub({ settings: true }) },
    { type: 'separator' },
    { label: 'Quitter Cube Hub LLM', click: () => app.quit() },
  ]));
}

function openWebUI(chatId) {
  const base = (state().server.url || '').replace(/\/+$/, '');
  if (/^https?:\/\//.test(base)) shell.openExternal(chatId ? `${base}/c/${encodeURIComponent(chatId)}` : base);
}

// ---------------------------------------------------------------- Hub

function openHub(opts = {}) {
  const hasCmd = opts.select || opts.settings || opts.selectSession || opts.newChat;
  if (hub && !hub.isDestroyed()) {
    if (hub.isMinimized()) hub.restore();
    hub.show();
    hub.focus();
    if (hasCmd) hub.webContents.send('hub:command', opts);
    return;
  }
  const b = state().hub.bounds || {};
  hub = new BrowserWindow({
    width: b.width || 1100, height: b.height || 720, x: b.x, y: b.y, minWidth: 760, minHeight: 480,
    backgroundColor: '#000000', title: 'Cube Hub LLM', icon: ICON, show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0a0b', symbolColor: '#e0e0e0', height: 44 },
    webPreferences: { preload, backgroundThrottling: false },
  });
  hub.loadURL(pageURL('hub'));
  hub.once('ready-to-show', () => hub.show());
  hub.webContents.on('did-finish-load', () => {
    hub.webContents.send('init', initData());
    if (hasCmd) hub.webContents.send('hub:command', opts);
  });
  hub.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error('[hub]', message); });
  // Les liens des réponses s'ouvrent dans le navigateur.
  hub.webContents.setWindowOpenHandler(({ url: link }) => {
    if (/^https?:\/\//.test(link)) shell.openExternal(link);
    return { action: 'deny' };
  });
  const saveBounds = () => {
    if (!hub.isMaximized() && !hub.isMinimized()) { state().hub.bounds = hub.getBounds(); stateStore.save(); }
  };
  hub.on('resize', saveBounds);
  hub.on('move', saveBounds);
  hub.on('closed', () => { hub = null; });
}

ipcMain.on('open-hub', (_e, opts) => openHub(opts || {}));
ipcMain.on('open-webui', (_e, chatId) => openWebUI(chatId));
ipcMain.on('widget:toggle', toggleWidget);
ipcMain.on('widget:set-scale', (_e, v) => setWidgetScale(v));

ipcMain.handle('state:update', (_e, patch) => {
  const s = state();
  for (const [k, v] of Object.entries(patch)) {
    if (['hub', 'sounds', 'widget', 'notifications', 'telegram', 'server'].includes(k)) Object.assign(s[k], v);
  }
  stateStore.save();
  broadcast('settings', s);
  return s;
});

ipcMain.handle('confirm', async (_e, { message, detail, ok }) => {
  const r = await dialog.showMessageBox(hub || widget, {
    type: 'question', buttons: [ok || 'OK', 'Annuler'], defaultId: 0, cancelId: 1, message, detail,
  });
  return r.response === 0;
});

ipcMain.handle('popup-menu', (_e, items) => new Promise((resolve) => {
  let chosen = null;
  const build = (list) => list.map((it) => {
    if (it.type === 'separator') return { type: 'separator' };
    if (it.submenu) return { label: it.label, submenu: build(it.submenu) };
    return { label: it.label, enabled: it.enabled !== false, type: it.checked != null ? 'checkbox' : 'normal', checked: !!it.checked, click: () => { chosen = it.id; } };
  });
  Menu.buildFromTemplate(build(items)).popup({ window: hub || widget, callback: () => setTimeout(() => resolve(chosen), 0) });
}));

// ---------------------------------------------------------------- Conversations

ipcMain.handle('chat:get', async (_e, id) => {
  if (!store.details.has(id)) await store.refresh(id).catch(() => {});
  return store.conversation(id);
});
ipcMain.handle('chat:send', async (_e, { chatId, text, model }) => {
  try {
    const id = await store.send(chatId || null, text, model || null, progress, (newId) => {
      if (hub && !hub.isDestroyed()) hub.webContents.send('chat:created', newId);
    });
    return { ok: true, chatId: id };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('chat:move', async (_e, { chatId, folderId }) => {
  try {
    await api.moveToFolder(chatId, folderId);
    await store.refresh(chatId);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('models', async () => {
  try { return { ok: true, models: await api.models() }; } catch (e) { return { ok: false, error: e.message, models: [] }; }
});
ipcMain.handle('ollama:ps', () => api.ollamaPs());

// ---------------------------------------------------------------- Serveur

/** Teste une adresse et une clé sans les enregistrer. */
ipcMain.handle('server:test', async (_e, { url: u, key }) => {
  const test = new WebUI(() => ({ url: normalizeURL(u), key: key || readKey() }));
  try {
    const version = await test.version().catch(() => null);
    const me = await test.me();
    const models = await test.models().catch(() => []);
    return { ok: true, version: version?.version || '?', user: me.name || me.email || '', models: models.map((m) => m.id) };
  } catch (e) {
    return { ok: false, error: e.name === 'TimeoutError' ? 'Le serveur ne répond pas (adresse, port, pare-feu ?).' : e.cause?.code === 'ECONNREFUSED' ? 'Connexion refusée : Open WebUI tourne-t-il sur ce port ?' : e.message };
  }
});
ipcMain.handle('server:save', async (_e, { url: u, key, defaultModel, activeWindowMin }) => {
  const s = state().server;
  if (u != null) s.url = normalizeURL(u);
  if (key) writeKey(key.trim());
  if (defaultModel != null) s.defaultModel = defaultModel;
  if (activeWindowMin) s.activeWindowMin = activeWindowMin;
  state().welcomeDone = true;
  stateStore.save();
  if (u != null || key) store.reset();
  broadcast('settings', state());
  updateTrayMenu();
  return { ok: true, hasKey: !!readKey() };
});
ipcMain.handle('server:status', () => ({ ...serverStatus, url: state().server.url, hasKey: !!readKey() }));

function normalizeURL(u) {
  let v = String(u || '').trim().replace(/\/+$/, '');
  if (v && !/^https?:\/\//i.test(v)) v = 'http://' + v;
  return v;
}

// ---------------------------------------------------------------- Réglages divers

// Lancement à l'ouverture de session : réglage de Windows, ou fichier ~/.config/autostart sous Linux.
const AUTOSTART = path.join(require('os').homedir(), '.config', 'autostart', 'cube-hub-llm.desktop');
ipcMain.handle('login-item:get', () => (LINUX ? fs.existsSync(AUTOSTART) : app.getLoginItemSettings().openAtLogin));
ipcMain.handle('login-item:set', (_e, on) => {
  if (!LINUX) {
    app.setLoginItemSettings({ openAtLogin: !!on });
    return app.getLoginItemSettings().openAtLogin;
  }
  try {
    if (on) {
      fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
      const exec = process.env.APPIMAGE || process.execPath;
      fs.writeFileSync(AUTOSTART, ['[Desktop Entry]', 'Type=Application', 'Name=Cube Hub LLM', `Exec="${exec}"`, 'Icon=cube-hub-llm', 'X-GNOME-Autostart-enabled=true', ''].join('\n'));
    } else {
      fs.rmSync(AUTOSTART, { force: true });
    }
  } catch (e) {
    console.error('Démarrage automatique :', e.message);
  }
  return fs.existsSync(AUTOSTART);
});
ipcMain.on('sounds:open-folder', () => {
  fs.mkdirSync(paths.soundsDir, { recursive: true });
  shell.openPath(paths.soundsDir);
});
ipcMain.on('open-url', (_e, link) => {
  if (/^https:\/\//.test(link)) shell.openExternal(link);
});

function listCustomSounds() {
  const out = {};
  try {
    for (const f of fs.readdirSync(paths.soundsDir)) {
      const m = /^(bosse|fini|attente|dodo)\.(wav|mp3|m4a|ogg|aiff?)$/i.exec(f);
      if (m) out[m[1].toLowerCase()] = 'app://sons/' + encodeURIComponent(f);
    }
  } catch {}
  return out;
}

// ---------------------------------------------------------------- Telegram

ipcMain.handle('telegram:status', () => notifier.status());
ipcMain.handle('telegram:connect', async (_e, token) => {
  try {
    const botName = await notifier.connect(token);
    startChatDetection();
    return { ok: true, botName };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('telegram:detect', () => { startChatDetection(); return true; });
ipcMain.handle('telegram:disconnect', () => {
  notifier.disconnect();
  Object.assign(state().telegram, { enabled: false, chatId: null, chatName: '' });
  state().telegram.commands.enabled = false;
  stateStore.save();
  remote.sync();
  broadcast('settings', state());
  return true;
});
ipcMain.handle('telegram:test', async () => {
  try {
    await notifier.send('🧊 <b>Cube Hub LLM</b> est bien relié à Telegram. Tu recevras ici les réponses de ton IA quand tu n\'es pas devant ton PC.');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

function startChatDetection() {
  notifier.detectChat((chat) => {
    if (chat) {
      Object.assign(state().telegram, { chatId: chat.id, chatName: chat.name, enabled: true });
      stateStore.save();
      notifier.send('🧊 <b>Cube Hub LLM</b> : c\'est relié ! Tu recevras ici les réponses de ton IA.').catch(() => {});
      remote.sync();
    }
    broadcast('settings', state());
    broadcast('telegram:detected', chat);
  });
}

ipcMain.handle('remote:status', () => remote.status());
ipcMain.handle('remote:setup-begin', () => remote.beginSetup());
ipcMain.handle('remote:setup-confirm', (_e, code) => {
  const r = remote.confirmSetup(code);
  if (r.ok) {
    state().telegram.commands.enabled = true;
    stateStore.save();
    remote.sync();
    broadcast('settings', state());
  }
  return r;
});
ipcMain.handle('remote:remove-code', () => {
  remote.removeSecret();
  broadcast('settings', state());
  return remote.status();
});
ipcMain.handle('remote:set', (_e, { enabled }) => {
  if (enabled != null) state().telegram.commands.enabled = !!enabled;
  stateStore.save();
  remote.sync();
  broadcast('settings', state());
  return remote.status();
});
ipcMain.handle('remote:lock', () => { remote.lock('depuis le PC'); return remote.status(); });
ipcMain.on('remote:open-log', () => {
  if (!fs.existsSync(LOG_FILE)) { fs.mkdirSync(paths.baseDir, { recursive: true }); fs.writeFileSync(LOG_FILE, ''); }
  shell.openPath(LOG_FILE);
});

// ---------------------------------------------------------------- Bienvenue (connexion au serveur)

function openWelcome() {
  if (welcome && !welcome.isDestroyed()) { welcome.focus(); return; }
  welcome = new BrowserWindow({
    width: 600, height: 700, resizable: false, maximizable: false, minimizable: false,
    title: 'Bienvenue dans Cube Hub LLM', icon: ICON, backgroundColor: '#0a0a0b', autoHideMenuBar: true,
    webPreferences: { preload },
  });
  welcome.setMenu(null);
  welcome.loadURL(pageURL('welcome'));
  welcome.webContents.on('did-finish-load', () => welcome.webContents.send('init', initData()));
  welcome.on('closed', () => {
    welcome = null;
    state().welcomeDone = true;
    stateStore.save();
  });
}
ipcMain.on('welcome:close', () => welcome && welcome.close());
ipcMain.on('welcome:open', () => openWelcome());

// ---------------------------------------------------------------- Captures de vérification

async function snapshots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (win, name) => fs.writeFileSync(path.join(dir, name), (await win.webContents.capturePage()).toPNG());
  await wait(4000);
  await shot(widget, 'widget.png');
  openHub();
  await wait(3500);
  await shot(hub, 'hub.png');
  for (const p of ['server', 'telegram']) {
    hub.webContents.send('hub:command', { settings: true, settingsPage: p });
    await wait(1200);
    hub.webContents.invalidate();
    await wait(300);
    await shot(hub, `settings-${p}.png`);
  }
  openWelcome();
  await wait(2500);
  welcome.webContents.invalidate();
  await wait(500);
  await shot(welcome, 'welcome.png');
  quitting = true;
  app.exit(0);
}
