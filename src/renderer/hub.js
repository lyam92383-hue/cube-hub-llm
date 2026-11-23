// La fenêtre Cube Hub LLM : tes conversations Open WebUI rangées par dossiers, avec le cube,
// et une vue de chat pour les lire et les continuer.
import { Cube, CUBE_CSS, COLORS, loadFrames } from './common/cube.js';
import { play, configureSounds } from './common/sounds.js';
import { LONG, SHORT, ago, tokens, escapeHTML } from './common/format.js';
import { renderMarkdown } from './common/markdown.js';

const $ = (id) => document.getElementById(id);
const style = document.createElement('style');
style.textContent = CUBE_CSS;
document.head.appendChild(style);

// Couleurs des dossiers (comme les thèmes de Cube Hub) : ni bleu, ni vert, ni orange.
const FOLDER_COLORS = ['#A78BFA', '#F472B6', '#F5C542', '#E879F9', '#E11D48', '#D6C7A1', '#8E8E93'];
const PAGE_SIZE = 40;

let settings = null;
let chats = [];
let folders = [];
let server = { ok: false, error: null };
let selected = null; // id de la conversation, ou 'new'
let hotkey = 'Ctrl+Alt+L';
let linux = false;
let models = [];
let search = '';
let shown = PAGE_SIZE;
let ready = false;
const queued = [];
const rowEls = new Map();
let headerCube = null;
let placeholderCube = null;
let conversation = null; // conversation affichée
let sending = false;

const hubState = () => settings.hub;
const saveHub = () => window.cube.invoke('state:update', { hub: settings.hub });

// ------------------------------------------------------------ Démarrage

window.cube.on('init', async (data) => {
  await loadFrames();
  settings = data.settings;
  chats = data.chats || [];
  folders = data.folders || [];
  server = data.server || server;
  hotkey = data.hotkey;
  linux = data.platform === 'linux';
  configureSounds(settings.sounds, data.customSounds);
  selected = hubState().selected;
  render();
  loadModels();
  setInterval(render, 30_000);
  ready = true;
  queued.splice(0).forEach(runCommand);
});
window.cube.on('chats', (d) => {
  chats = d.chats;
  folders = d.folders;
  render();
});
window.cube.on('server:status', (s) => {
  server = s;
  render();
  if (s.ok && !models.length) loadModels();
});
window.cube.on('settings', (s) => {
  const urlChanged = settings && settings.server.url !== s.server.url;
  settings = s;
  configureSounds(s.sounds);
  renderToolbar();
  if (urlChanged) { models = []; loadModels(); }
  if (!$('modal').hidden && page !== 'server') renderSettings();
});
window.cube.on('hub:command', (cmd) => (ready ? runCommand(cmd) : queued.push(cmd)));
window.cube.on('chat:progress', ({ chatId, content }) => {
  if (conversation && conversation.id === chatId) updateLiveAnswer(content);
});
window.cube.on('chat:created', (id) => {
  if (selected === 'new') {
    selected = id;
    hubState().selected = id;
    saveHub();
  }
});

function runCommand(cmd) {
  if (cmd.selectSession) select(cmd.selectSession);
  if (cmd.newChat) select('new');
  if (cmd.settingsPage) page = cmd.settingsPage;
  if (cmd.settings) openSettings();
  if (cmd.closeSettings) closeSettings();
}

async function loadModels() {
  if (!settings?.server.url) return;
  const r = await window.cube.invoke('models');
  if (r.ok) {
    models = r.models;
    renderComposer();
  }
}

// ------------------------------------------------------------ Liste

const folderName = (id) => folders.find((f) => f.id === id)?.name;
const folderColor = (id) => FOLDER_COLORS[Math.max(0, folders.findIndex((f) => f.id === id)) % FOLDER_COLORS.length];

function render() {
  if (!settings) return;
  renderList();
  renderServerLine();
  renderMain();
  renderToolbar();
}

function renderList() {
  const list = $('list');
  const scroll = list.scrollTop;
  list.innerHTML = '';
  if (!settings.server.url) return;
  const q = search.trim().toLowerCase();
  const visible = chats.filter((c) => !q || c.projectName.toLowerCase().includes(q) || (c.currentTask || '').toLowerCase().includes(q));
  const limited = q ? visible : visible.slice(0, shown);
  const sections = [];
  const pinned = limited.filter((c) => c.pinned);
  if (pinned.length) sections.push({ key: 'pinned', name: '📌 Épinglées', color: '#8E8E93', rows: pinned });
  for (const f of folders) {
    const rows = limited.filter((c) => !c.pinned && c.folderId === f.id);
    if (rows.length) sections.push({ key: f.id, folderId: f.id, name: f.name, color: folderColor(f.id), rows });
  }
  const loose = limited.filter((c) => !c.pinned && (!c.folderId || !folderName(c.folderId)));
  if (loose.length) sections.push({ key: 'loose', folderId: null, name: 'Sans dossier', rows: loose, plain: true });

  const seen = new Set();
  for (const sec of sections) {
    const collapsed = !!hubState().collapsed[sec.key];
    const el = document.createElement('div');
    el.className = 'section' + (sec.plain ? ' no-theme' : '') + (collapsed ? ' collapsed' : '');
    if (!sec.plain) el.style.setProperty('--theme', sec.color);
    el.innerHTML = `<div class="section-head">${sec.plain ? '' : '<span class="tdot"></span>'}
        <span>${escapeHTML(sec.name)}</span><span class="count">${sec.rows.length}</span>
        <svg class="chev" viewBox="0 0 20 20"><path d="M6 8l4 4 4-4"/></svg></div><div class="panel"></div>`;
    const head = el.querySelector('.section-head');
    head.onclick = () => {
      hubState().collapsed[sec.key] = !collapsed;
      saveHub();
      render();
    };
    if (sec.key !== 'pinned') setupDrop(head, sec.folderId);
    const panel = el.querySelector('.panel');
    for (const c of sec.rows) {
      seen.add(c.id);
      panel.appendChild(rowElement(c));
    }
    list.appendChild(el);
  }
  for (const [k, v] of rowEls) {
    if (!seen.has(k)) {
      v.cube.destroy();
      rowEls.delete(k);
    }
  }
  if (!chats.length && server.ok) {
    list.insertAdjacentHTML('beforeend', '<div class="note" style="padding:14px 20px">Aucune conversation pour l\'instant.</div>');
  }
  if (!q && visible.length > shown) {
    const more = document.createElement('button');
    more.className = 'text-btn show-more';
    more.textContent = `Afficher plus (${visible.length - shown})`;
    more.onclick = () => { shown += PAGE_SIZE; render(); };
    list.appendChild(more);
  }
  const add = document.createElement('button');
  add.className = 'new-card';
  add.innerHTML = `<span class="plus"><svg viewBox="0 0 20 20"><path d="M10 4v12M4 10h12"/></svg></span>
    <span><div class="t1">Nouvelle conversation</div><div class="t2">Avec un modèle de ton serveur</div></span>`;
  add.onclick = () => select('new');
  list.appendChild(add);
  list.scrollTop = scroll;
}

function rowElement(c) {
  let item = rowEls.get(c.id);
  if (!item) {
    const wrap = document.createElement('div');
    wrap.className = 'row-wrap';
    wrap.innerHTML = `<div class="row" draggable="true"><div class="cube-host"></div>
      <div class="row-text"><div class="row-name"></div><div class="row-detail"></div><div class="row-detail row-task"></div></div></div>`;
    const row = wrap.querySelector('.row');
    const cube = new Cube(wrap.querySelector('.cube-host'), { height: 40 });
    item = { wrap, row, cube, id: c.id };
    rowEls.set(c.id, item);
    row.addEventListener('click', () => select(item.id));
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); rowMenu(item.id); });
    row.addEventListener('dragstart', (e) => {
      dragId = item.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id);
      requestAnimationFrame(() => row.classList.add('dragging'));
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      row.classList.remove('dragging');
      document.querySelectorAll('.section-head.drop').forEach((h) => h.classList.remove('drop'));
    });
  }
  const recent = c.active;
  item.row.classList.toggle('selected', c.id === selected);
  item.row.classList.toggle('asleep', !recent);
  item.row.style.setProperty('--state', recent ? COLORS[c.status] : '#8E8E93');
  item.wrap.querySelector('.row-name').textContent = c.projectName;
  const st = recent || c.status !== 'done' ? `<span class="st-${c.status}">${SHORT[c.status]}</span><span class="sep">·</span>` : '';
  item.wrap.querySelector('.row-detail').innerHTML = `${st}${c.model ? `<span class="model">${escapeHTML(c.model)}</span><span class="sep">·</span>` : ''}${escapeHTML(ago(c.updatedAt))}`;
  const task = item.wrap.querySelector('.row-task');
  task.textContent = c.currentTask || '';
  task.hidden = !c.currentTask;
  item.cube.setMood(recent || c.status !== 'done' ? c.status : 'sleeping');
  return item.wrap;
}

let dragId = null;
function setupDrop(head, folderId) {
  head.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    head.classList.add('drop');
  });
  head.addEventListener('dragleave', () => head.classList.remove('drop'));
  head.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    head.classList.remove('drop');
    moveTo(dragId, folderId);
  });
}

async function moveTo(chatId, folderId) {
  const r = await window.cube.invoke('chat:move', { chatId, folderId });
  if (!r.ok) window.cube.invoke('confirm', { message: 'Impossible de déplacer la conversation.', detail: r.error, ok: 'OK' });
}

async function rowMenu(id) {
  const c = chats.find((x) => x.id === id);
  if (!c) return;
  const choice = await window.cube.invoke('popup-menu', [
    {
      label: 'Déplacer vers',
      submenu: [
        ...folders.map((f) => ({ id: 'folder:' + f.id, label: f.name, checked: c.folderId === f.id })),
        { type: 'separator' },
        { id: 'folder:', label: 'Sans dossier', checked: !c.folderId },
      ],
    },
    { id: 'webui', label: 'Ouvrir dans Open WebUI' },
    { id: 'copy', label: 'Copier la dernière réponse' },
  ]);
  if (!choice) return;
  if (choice.startsWith('folder:')) moveTo(id, choice.slice(7) || null);
  if (choice === 'webui') window.cube.send('open-webui', id);
  if (choice === 'copy') {
    const conv = await window.cube.invoke('chat:get', id);
    const last = [...(conv?.messages || [])].reverse().find((m) => m.role === 'assistant');
    if (last) navigator.clipboard.writeText(last.content);
  }
}

function renderServerLine() {
  const el = $('serverLine');
  const url = settings.server.url;
  const color = !url ? '#8E8E93' : server.ok ? '#3FBF6E' : '#E5671A';
  const text = !url ? 'Serveur pas réglé — cliquer ici' : server.ok ? url.replace(/^https?:\/\//, '') : server.error || 'Connexion…';
  el.innerHTML = `<span class="server-dot" style="background:${color}"></span><span class="server-text">${escapeHTML(text)}</span>`;
  el.title = url ? `${url}\n${server.ok ? 'Connecté' : server.error || ''}` : '';
  el.onclick = () => { page = 'server'; openSettings(); };
}

// ------------------------------------------------------------ Conversation

async function select(id) {
  selected = id;
  hubState().selected = id;
  saveHub();
  conversation = null;
  render();
  if (id && id !== 'new') {
    conversation = await window.cube.invoke('chat:get', id);
    if (selected === id) renderMessages(true);
  }
  $('input').focus();
}

let renderedKey = '';
function renderMain() {
  const header = $('header');
  const ph = $('placeholder');
  if (!settings.server.url) {
    header.hidden = true;
    $('composer').hidden = true;
    $('messages').innerHTML = '';
    showPlaceholder('sleeping', 'Connecte ton serveur', 'Indique l\'adresse de ton Open WebUI (par exemple http://192.168.1.50:3000) et ta clé API pour voir tes conversations.',
      [['Connecter mon serveur', () => { page = 'server'; openSettings(); }, true]]);
    return;
  }
  $('composer').hidden = false;
  if (selected === 'new') {
    header.hidden = false;
    setHeader('new', 'sleeping', 'Nouvelle conversation', `<span class="st-closed">choisis un modèle et écris ta question</span>`, '');
    $('messages').innerHTML = '';
    showPlaceholder(null, 'Nouvelle conversation', 'Elle sera enregistrée dans ton Open WebUI, comme si tu l\'avais commencée là-bas.');
    renderComposer();
    return;
  }
  const c = chats.find((x) => x.id === selected);
  if (!c) {
    header.hidden = true;
    $('messages').innerHTML = '';
    if (!server.ok && server.error) {
      showPlaceholder('waiting', 'Serveur injoignable', server.error, [['Vérifier les réglages', () => { page = 'server'; openSettings(); }, true]]);
    } else {
      showPlaceholder('sleeping', chats.length ? 'Choisis une conversation' : 'Aucune conversation', 'Tes conversations Open WebUI apparaissent à gauche, rangées par dossiers.',
        [['Nouvelle conversation', () => select('new'), true]]);
    }
    renderComposer();
    return;
  }
  header.hidden = false;
  const parts = [`<span class="st-${c.status}">${LONG[c.status]}</span>`];
  if (c.model) parts.push(escapeHTML(c.model));
  parts.push(`${c.messageCount} messages`);
  if (c.contextTokens) parts.push(escapeHTML(tokens(c.contextTokens)));
  parts.push(escapeHTML(ago(c.updatedAt)));
  const folder = c.folderId && folderName(c.folderId) ? `<span class="tdot" style="background:${folderColor(c.folderId)}"></span> ${escapeHTML(folderName(c.folderId))}` : '';
  setHeader(c.id, c.active || c.status !== 'done' ? c.status : 'sleeping', c.projectName, parts.join('<span class="sep">·</span>'), folder);
  ph.innerHTML = '';
  placeholderCube?.destroy();
  placeholderCube = null;
  // La conversation a changé sur le serveur (réponse finie, écrite ailleurs…) : on la relit.
  const key = `${c.id}|${c.updatedAt}|${c.status}|${c.messageCount}`;
  if (key !== renderedKey && conversation?.id === c.id && c.status !== 'working') {
    renderedKey = key;
    window.cube.invoke('chat:get', c.id).then((conv) => {
      if (conv && selected === conv.id) {
        conversation = conv;
        renderMessages(false);
      }
    });
  }
  renderComposer();
}

function setHeader(key, mood, title, statusHTML, sub) {
  const header = $('header');
  const html = `<div class="h-cube"></div><div class="h-text">
      <div class="h-name">${escapeHTML(title)}</div>
      <div class="h-status">${statusHTML}</div>
      ${sub ? `<div class="h-folder" style="display:flex;align-items:center;gap:6px">${sub}</div>` : ''}
    </div>
    ${key !== 'new' ? `<div class="h-actions">
      <button class="icon-btn" id="hWebui" title="Ouvrir dans Open WebUI"><svg viewBox="0 0 20 20"><path d="M8 4H5.5A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16h9a1.5 1.5 0 0 0 1.5-1.5V12M11 4h5v5M16 4l-7 7"/></svg></button>
      <button class="icon-btn" id="hMenu" title="Plus"><svg viewBox="0 0 20 20"><circle cx="5" cy="10" r="1"/><circle cx="10" cy="10" r="1"/><circle cx="15" cy="10" r="1"/></svg></button>
    </div>` : ''}`;
  const k = `${key}|${html}`;
  if (header.dataset.key !== k) {
    header.dataset.key = k;
    headerCube?.destroy();
    header.innerHTML = html;
    headerCube = new Cube(header.querySelector('.h-cube'), { height: 50 });
    if ($('hWebui')) $('hWebui').onclick = () => window.cube.send('open-webui', key);
    if ($('hMenu')) $('hMenu').onclick = () => rowMenu(key);
  }
  headerCube.setMood(mood);
}

function showPlaceholder(mood, title, text, buttons = []) {
  const ph = $('placeholder');
  ph.innerHTML = `${mood ? '<div class="ph-cube"></div>' : ''}<div class="p-title">${escapeHTML(title)}</div>
    <div class="p-text">${escapeHTML(text)}</div><div class="p-buttons"></div>`;
  buttons.forEach(([label, fn, primary]) => {
    const b = document.createElement('button');
    b.className = 'btn' + (primary ? ' primary' : '');
    b.textContent = label;
    b.onclick = fn;
    ph.querySelector('.p-buttons').appendChild(b);
  });
  placeholderCube?.destroy();
  placeholderCube = null;
  if (mood) {
    placeholderCube = new Cube(ph.querySelector('.ph-cube'), { height: 120 });
    placeholderCube.setMood(mood);
  }
}

function messageHTML(m, i) {
  if (m.role === 'user') return `<div class="msg user" data-i="${i}"><div class="bubble">${escapeHTML(m.content)}</div></div>`;
  const meta = [m.model && escapeHTML(m.model), m.tokens && escapeHTML(tokens(m.tokens))].filter(Boolean).join(' · ');
  return `<div class="msg assistant" data-i="${i}"><div class="avatar"></div><div class="body">
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      <div class="text${m.done ? '' : ' cursor'}">${renderMarkdown(m.content)}</div>
      ${m.error ? `<div class="error">⚠️ ${escapeHTML(m.error)}</div>` : ''}</div></div>`;
}

function renderMessages(scrollToEnd) {
  const box = $('messages');
  if (!conversation) { box.innerHTML = ''; return; }
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = conversation.messages.map(messageHTML).join('') || '<div class="note" style="text-align:center">Conversation vide.</div>';
  // Petit cube à côté de chaque réponse.
  box.querySelectorAll('.msg.assistant .avatar').forEach((a, n, all) => {
    const cube = new Cube(a, { height: 30 });
    const last = n === all.length - 1;
    const msg = conversation.messages.filter((m) => m.role === 'assistant')[n];
    cube.setMood(!msg?.done ? 'working' : msg?.error ? 'waiting' : last ? 'done' : 'done');
  });
  wireCopyButtons(box);
  if (scrollToEnd || atEnd) box.scrollTop = box.scrollHeight;
}

function wireCopyButtons(root) {
  root.querySelectorAll('pre .copy').forEach((b) => {
    b.onclick = () => {
      navigator.clipboard.writeText(b.parentElement.querySelector('code').textContent);
      b.textContent = 'Copié';
      setTimeout(() => { b.textContent = 'Copier'; }, 1200);
    };
  });
}

let refetching = false;
/** Réponse en train de s'écrire : seul le dernier message est redessiné. */
function updateLiveAnswer(content) {
  if (!conversation) return;
  const msgs = conversation.messages;
  let last = msgs[msgs.length - 1];
  if (!last || last.role !== 'assistant' || last.done) {
    // Message envoyé d'ailleurs (Telegram…) : on relit la conversation avec la question.
    if (!refetching) {
      refetching = true;
      window.cube.invoke('chat:get', conversation.id).then((conv) => {
        refetching = false;
        if (conv && conversation && conv.id === conversation.id) {
          conversation = conv;
          renderMessages(true);
        }
      });
    }
    return;
  }
  last.content = content;
  last.done = false;
  const box = $('messages');
  const el = box.querySelector('.msg.assistant:last-child .text');
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (el) {
    el.innerHTML = renderMarkdown(content);
    el.classList.add('cursor');
    wireCopyButtons(el);
  } else {
    renderMessages(true);
  }
  if (atEnd) box.scrollTop = box.scrollHeight;
}

// ------------------------------------------------------------ Écrire

function renderComposer() {
  const sel = $('model');
  const c = chats.find((x) => x.id === selected);
  const current = sel.value;
  const wanted = selected === 'new' ? current || settings.server.defaultModel : c?.model;
  const ids = models.map((m) => m.id);
  if (wanted && !ids.includes(wanted)) ids.unshift(wanted);
  const key = ids.join('|');
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.innerHTML = ids.length ? ids.map((id) => `<option value="${escapeHTML(id)}">${escapeHTML(id)}</option>`).join('') : '<option value="">(aucun modèle)</option>';
  }
  if (wanted && sel.dataset.chat !== String(selected)) {
    sel.value = wanted;
  }
  sel.dataset.chat = String(selected);
  const working = c?.status === 'working';
  $('composerHint').textContent = sending || working ? 'Ton IA écrit…' : server.ok ? '' : 'Serveur injoignable';
  $('sendBtn').disabled = sending || working || !server.ok;
  $('composer').classList.toggle('disabled', !selected || (!c && selected !== 'new'));
}

async function send() {
  const input = $('input');
  const text = input.value.trim();
  if (!text || sending) return;
  const chatId = selected === 'new' ? null : selected;
  const model = $('model').value;
  if (!model) return;
  sending = true;
  input.value = '';
  autoGrow();
  if (!conversation || selected === 'new') conversation = { id: chatId, title: text, messages: [] };
  conversation.messages.push({ role: 'user', content: text });
  conversation.messages.push({ role: 'assistant', content: '', model, done: false });
  $('placeholder').innerHTML = '';
  placeholderCube?.destroy();
  placeholderCube = null;
  renderMessages(true);
  renderComposer();
  const r = await window.cube.invoke('chat:send', { chatId, text, model });
  sending = false;
  if (r.chatId || chatId) {
    const id = r.chatId || chatId;
    selected = id;
    hubState().selected = id;
    saveHub();
    conversation = await window.cube.invoke('chat:get', id);
    renderMessages(true);
  }
  if (!r.ok && !r.chatId) {
    const last = conversation.messages[conversation.messages.length - 1];
    last.done = true;
    last.error = r.error;
    renderMessages(true);
  }
  render();
}

function autoGrow() {
  const t = $('input');
  t.style.height = 'auto';
  t.style.height = Math.min(200, t.scrollHeight) + 'px';
}
$('input').addEventListener('input', autoGrow);
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$('sendBtn').onclick = send;
$('search').addEventListener('input', (e) => { search = e.target.value; renderList(); });

// ------------------------------------------------------------ Barre d'outils

const volumeIcon = (v) => {
  const waves = v <= 0 ? '<path d="M13 8l4 4M17 8l-4 4"/>'
    : v < 0.34 ? '<path d="M12.5 8.5a2.5 2.5 0 0 1 0 3"/>'
      : v < 0.67 ? '<path d="M12.5 8.5a2.5 2.5 0 0 1 0 3"/><path d="M14.5 6.5a5.3 5.3 0 0 1 0 7"/>'
        : '<path d="M12.5 8.5a2.5 2.5 0 0 1 0 3"/><path d="M14.5 6.5a5.3 5.3 0 0 1 0 7"/><path d="M16.5 4.8a8 8 0 0 1 0 10.4"/>';
  return `<path d="M3.5 8h2.5l3.5-3v10L6 12H3.5z"/>${waves}`;
};
function renderToolbar() {
  if (!settings) return;
  $('widgetBtn').classList.toggle('on', !!settings.widget.visible);
  $('volumeIcon').innerHTML = volumeIcon(settings.sounds.master);
  $('masterVolume').value = settings.sounds.master;
  $('webuiBtn').hidden = !settings.server.url;
}
$('widgetBtn').onclick = () => window.cube.send('widget:toggle');
$('webuiBtn').onclick = () => window.cube.send('open-webui', selected && selected !== 'new' ? selected : null);
$('volumeBtn').onclick = (e) => {
  e.stopPropagation();
  $('volumePopover').hidden = !$('volumePopover').hidden;
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#volumePopover')) $('volumePopover').hidden = true;
});
$('masterVolume').oninput = (e) => {
  settings.sounds.master = Number(e.target.value);
  $('volumeIcon').innerHTML = volumeIcon(settings.sounds.master);
  window.cube.invoke('state:update', { sounds: { master: settings.sounds.master } });
};
$('masterVolume').onchange = () => { configureSounds(settings.sounds); play('fini'); };
$('settingsBtn').onclick = openSettings;
$('newBtn').onclick = () => select('new');
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.key.toLowerCase() === 'n') { e.preventDefault(); select('new'); }
  if (e.ctrlKey && e.key.toLowerCase() === 'f') { e.preventDefault(); $('search').focus(); }
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); }
  if (e.key === 'Escape' && !$('modal').hidden) closeSettings();
});

// ------------------------------------------------------------ Réglages

const PAGES = [
  { id: 'server', label: 'Serveur', color: '#30B0C7', icon: '<rect x="4" y="4" width="12" height="5" rx="1.5"/><rect x="4" y="11" width="12" height="5" rx="1.5"/><path d="M7 6.5h.1M7 13.5h.1"/>' },
  { id: 'general', label: 'Général', color: '#8E8E93', icon: '<circle cx="10" cy="10" r="2.6"/><path d="M10 3v2M10 15v2M3 10h2M15 10h2"/>' },
  { id: 'widget', label: 'Widget', color: '#5E5CE6', icon: '<rect x="3.5" y="6" width="13" height="9" rx="2.5"/>' },
  { id: 'sounds', label: 'Sons', color: '#FF2D55', icon: '<path d="M4 8h2.5l3.5-3v10L6.5 12H4z"/><path d="M13 7.5a3.5 3.5 0 0 1 0 5"/>' },
  { id: 'notifications', label: 'Notifications', color: '#FF375F', icon: '<path d="M6 13V9a4 4 0 0 1 8 0v4l1.5 2h-11z"/><path d="M8.5 17h3"/>' },
  { id: 'telegram', label: 'Telegram', color: '#2AABEE', icon: '<path d="M3.5 9.5l12-5-2 11-4-3-2 3v-4l6-5"/>' },
  { id: 'about', label: 'À propos', color: '#0A84FF', icon: '<circle cx="10" cy="10" r="6.5"/><path d="M10 9v4.5M10 6.5v.2"/>' },
];
let page = 'server';

function openSettings() {
  $('modal').hidden = false;
  renderSettings();
}
function closeSettings() {
  $('modal').hidden = true;
}
$('closeSettings').onclick = closeSettings;
$('modal').addEventListener('mousedown', (e) => { if (e.target === $('modal')) closeSettings(); });

function renderSettings() {
  $('settingsNav').innerHTML = PAGES.map((p) => `<button class="nav-item ${p.id === page ? 'active' : ''}" data-page="${p.id}">
      <span class="nav-icon" style="background:${p.color}"><svg viewBox="0 0 20 20">${p.icon}</svg></span>${p.label}</button>`).join('');
  $('settingsNav').querySelectorAll('.nav-item').forEach((b) => {
    b.onclick = () => { page = b.dataset.page; renderSettings(); };
  });
  const el = $('settingsPage');
  ({ server: pageServer, general: pageGeneral, widget: pageWidget, sounds: pageSounds, notifications: pageNotifications, telegram: pageTelegram, about: pageAbout })[page](el);
}

const toggle = (id, on, attrs = '') => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''} ${attrs}><span></span></label>`;

async function pageServer(el) {
  const s = settings.server;
  const st = await window.cube.invoke('server:status');
  el.innerHTML = `<h2>Serveur</h2>
    <div class="group">
      <div class="line"><div class="l-label">Adresse d'Open WebUI
          <div class="l-sub">Celle que tu ouvres dans le navigateur, par exemple http://192.168.1.50:3000</div>
          <input type="text" id="sUrl" value="${escapeHTML(s.url)}" placeholder="http://192.168.1.50:3000" spellcheck="false" style="width:100%;margin-top:8px"></div></div>
      <div class="line"><div class="l-label">Clé API
          <div class="l-sub">Dans Open WebUI : ton profil → Réglages → Compte → Clés API → Créer. Elle commence par « sk- » et est chiffrée sur cet ordinateur.</div>
          <input type="password" id="sKey" placeholder="${st.hasKey ? '•••••••• (déjà enregistrée, laisse vide pour la garder)' : 'sk-…'}" spellcheck="false" style="width:100%;margin-top:8px"></div></div>
      <div class="line"><div class="l-label"><div class="l-sub" id="sMsg">${st.url ? (st.ok ? '🟢 Connecté.' : `🟠 ${escapeHTML(st.error || 'Connexion…')}`) : ''}</div></div>
        <button class="btn" id="sTest">Tester</button><button class="btn primary" id="sSave">Enregistrer</button></div>
    </div>
    <div class="group">
      <div class="line"><div class="l-label">Modèle par défaut<div class="l-sub">Pour les nouvelles conversations (et /nouveau depuis Telegram).</div></div>
        <select id="sModel">${['', ...models.map((m) => m.id)].map((id) => `<option value="${escapeHTML(id)}" ${id === s.defaultModel ? 'selected' : ''}>${id ? escapeHTML(id) : '—'}</option>`).join('')}</select></div>
      <div class="line"><div class="l-label">Une conversation reste dans le widget<div class="l-sub">après son dernier message</div></div>
        <select id="sWindow">${[10, 30, 60, 180, 720].map((m) => `<option value="${m}" ${m === s.activeWindowMin ? 'selected' : ''}>${m < 60 ? m + ' min' : m / 60 + ' h'}</option>`).join('')}</select></div>
    </div>
    <div class="group" id="ollamaBox"><div class="line"><div class="l-label l-sub">Modèles chargés par Ollama…</div></div></div>
    <p class="note">Ton PC doit pouvoir joindre le serveur : même réseau local, ou un VPN comme Tailscale.
      Si ça ne marche pas, vérifie que le port d'Open WebUI est ouvert dans le pare-feu d'Ubuntu (<code>sudo ufw allow 3000</code>). Si Cube Hub LLM tourne sur le serveur lui-même, mets <code>http://localhost:3000</code>.</p>`;
  const msg = (t) => { $('sMsg').innerHTML = t; };
  $('sTest').onclick = async () => {
    msg('Test…');
    const r = await window.cube.invoke('server:test', { url: $('sUrl').value, key: $('sKey').value.trim() });
    msg(r.ok ? `🟢 Ça marche : Open WebUI ${escapeHTML(r.version)}, compte ${escapeHTML(r.user)}, ${r.models.length} modèle(s).` : `🔴 ${escapeHTML(r.error)}`);
  };
  $('sSave').onclick = async () => {
    msg('Test…');
    const r = await window.cube.invoke('server:test', { url: $('sUrl').value, key: $('sKey').value.trim() });
    if (!r.ok) {
      const go = await window.cube.invoke('confirm', { message: 'Le serveur ne répond pas comme prévu.', detail: `${r.error}\n\nEnregistrer quand même ?`, ok: 'Enregistrer' });
      if (!go) { msg(`🔴 ${escapeHTML(r.error)}`); return; }
    }
    await window.cube.invoke('server:save', { url: $('sUrl').value, key: $('sKey').value.trim() || null });
    $('sKey').value = '';
    msg(r.ok ? '🟢 Enregistré et connecté.' : '🟠 Enregistré.');
    models = [];
    loadModels();
  };
  $('sModel').onchange = (e) => window.cube.invoke('server:save', { defaultModel: e.target.value });
  $('sWindow').onchange = (e) => window.cube.invoke('server:save', { activeWindowMin: Number(e.target.value) });
  const ps = await window.cube.invoke('ollama:ps');
  if (!$('ollamaBox')) return;
  $('ollamaBox').innerHTML = ps == null
    ? '<div class="line"><div class="l-label">Ollama<div class="l-sub">Les modèles chargés ne sont visibles qu\'avec un compte administrateur d\'Open WebUI.</div></div></div>'
    : `<div class="line"><div class="l-label">Ollama<div class="l-sub">${ps.length ? 'Modèles chargés en mémoire :' : 'Aucun modèle chargé en ce moment.'}</div></div></div>` +
      ps.map((m) => `<div class="line"><div class="l-label">${escapeHTML(m.name)}<div class="l-sub">${(m.size_vram / 1e9).toFixed(1)} Go en mémoire vidéo${m.expires_at ? ` · libéré dans ${Math.max(0, Math.round((Date.parse(m.expires_at) - Date.now()) / 60000))} min` : ''}</div></div></div>`).join('');
}

async function pageGeneral(el) {
  const login = await window.cube.invoke('login-item:get');
  el.innerHTML = `<h2>Général</h2>
    <div class="group">
      <div class="line"><div class="l-label">Ouvrir Cube Hub LLM à l'ouverture de session</div>${toggle('login', login)}</div>
      <div class="line"><div class="l-label">Afficher / masquer le widget<div class="l-sub">Depuis n'importe quelle app</div></div>
        <span class="badge ok" style="background:#2c2c2e;color:#fff">${escapeHTML(hotkey)}</span></div>
    </div>
    <div class="group">
      <div class="line"><div class="l-label">Raccourcis du Hub<div class="l-sub">Ctrl+N : nouvelle conversation · Ctrl+F : rechercher · Entrée : envoyer · Maj+Entrée : aller à la ligne</div></div></div>
    </div>`;
  $('login').onchange = (e) => window.cube.invoke('login-item:set', e.target.checked);
}

function pageWidget(el) {
  const w = settings.widget;
  el.innerHTML = `<h2>Widget</h2>
    <div class="group">
      <div class="line"><div class="l-label">Afficher le widget<div class="l-sub">${escapeHTML(hotkey)} le montre ou le cache depuis n'importe quelle app.</div></div>
        ${toggle('wVisible', w.visible)}</div>
      <div class="line"><div class="l-label">Taille</div>
        <select id="wScale">${[1, 0.9, 0.8, 0.7, 0.6].map((v) => `<option value="${v}" ${Math.abs(v - w.scale) < 0.01 ? 'selected' : ''}>${Math.round(v * 100)} %</option>`).join('')}</select></div>
    </div>
    <div class="note">Le cube est bleu quand ton IA écrit, vert quand la réponse est prête (ses yeux suivent ta souris),
      orange en cas d'erreur, et il s'endort quand aucune conversation n'est récente.<br><br>
      Clic : replier / déplier · double-clic : ouvrir la conversation · clic sur une petite carte : la passer devant · glisser : déplacer · clic droit : menu.</div>`;
  $('wVisible').onchange = () => window.cube.send('widget:toggle');
  $('wScale').onchange = (e) => window.cube.send('widget:set-scale', Number(e.target.value));
}

function pageSounds(el) {
  const s = settings.sounds;
  const line = (id, label, sub) => `<div class="line"><div class="l-label">${label}<div class="l-sub">${sub}</div></div>
      <input type="range" min="0" max="1" step="0.01" value="${s[id]}" data-sound="${id}">
      <button class="icon-btn" data-test="${id}" title="Écouter"><svg viewBox="0 0 20 20"><path d="M7 5l8 5-8 5z"/></svg></button></div>`;
  el.innerHTML = `<h2>Sons</h2>
    <div class="group"><div class="line"><div class="l-label">Volume général</div>
      <input type="range" min="0" max="1" step="0.01" value="${s.master}" data-sound="master"></div></div>
    <div class="group">
      ${line('bosse', 'Ton IA se met à écrire', 'Dans la conversation de devant')}
      ${line('fini', 'Réponse prête', 'La réponse est terminée')}
      ${line('attente', 'Erreur', 'La réponse a échoué')}
      ${line('dodo', 'Le cube s\'endort', 'Plus de conversation récente')}
    </div>
    <div class="note">Pour tes propres sons : des fichiers nommés bosse, fini, attente ou dodo (.wav, .mp3, .m4a, .ogg)
      dans <a id="soundsFolder">${linux ? '~/.cube-hub-llm/Sons' : '%USERPROFILE%\\.cube-hub-llm\\Sons'}</a>, puis relance l'app.</div>`;
  el.querySelectorAll('input[data-sound]').forEach((input) => {
    input.oninput = () => {
      settings.sounds[input.dataset.sound] = Number(input.value);
      configureSounds(settings.sounds);
      window.cube.invoke('state:update', { sounds: { [input.dataset.sound]: Number(input.value) } });
      renderToolbar();
    };
  });
  el.querySelectorAll('[data-test]').forEach((b) => { b.onclick = () => play(b.dataset.test, { force: true }); });
  $('soundsFolder').onclick = () => window.cube.send('sounds:open-folder');
}

const EVENT_LABELS = [
  ['done', 'Réponse prête', 'Avec le début de la réponse'],
  ['waiting', 'Erreur', 'La réponse a échoué ou ne s\'est pas terminée'],
];

function pageNotifications(el) {
  const n = settings.notifications;
  el.innerHTML = `<h2>Notifications</h2>
    <div class="group"><div class="line"><div class="l-label">Bulles de notification
        <div class="l-sub">Un clic ouvre la conversation.</div></div>${toggle('nWin', n.windows)}</div></div>
    <div class="group">${EVENT_LABELS.map(([k, label, sub]) => `<div class="line"><div class="l-label">${label}<div class="l-sub">${sub}</div></div>
        ${toggle('nEv-' + k, n.windowsEvents[k], n.windows ? '' : 'disabled')}</div>`).join('')}</div>
    <div class="note">Pour être prévenu sur ton téléphone quand tu n'es pas devant le PC, va dans Telegram.</div>`;
  const save = () => window.cube.invoke('state:update', { notifications: settings.notifications });
  $('nWin').onchange = (e) => { n.windows = e.target.checked; save(); renderSettings(); };
  for (const [k] of EVENT_LABELS) $('nEv-' + k).onchange = (e) => { n.windowsEvents[k] = e.target.checked; save(); };
}

let tgDetected = null;
window.cube.on('telegram:detected', (chat) => {
  tgDetected = chat ? 'ok' : 'timeout';
  if (!$('modal').hidden && page === 'telegram') renderSettings();
});
window.cube.on('remote:status', () => {
  if (!$('modal').hidden && page === 'telegram' && $('remoteBox') && !$('setupCode')) renderRemote($('remoteBox'));
});

async function pageTelegram(el) {
  const tg = settings.telegram;
  el.innerHTML = '<h2>Telegram</h2><div class="note">Chargement…</div>';
  const st = await window.cube.invoke('telegram:status');
  if (page !== 'telegram') return;
  const save = () => window.cube.invoke('state:update', { telegram: settings.telegram });
  if (!st.connected) {
    el.innerHTML = `<h2>Telegram</h2>
      <p class="note">Reçois les réponses de ton IA sur ton téléphone, et continue tes conversations depuis Telegram.</p>
      <div class="group">
        <div class="line"><div class="l-label">1. Crée un bot
          <div class="l-sub">Dans Telegram, écris à <a id="tgFather">@BotFather</a>, envoie <b>/newbot</b> et choisis un nom. Il te donne un <b>token</b>.</div></div></div>
        <div class="line"><div class="l-label">2. Colle le token ici
          <div class="l-sub">Il est chiffré sur cet ordinateur et ne le quitte jamais (sauf vers Telegram).</div>
          <div style="display:flex;gap:8px;margin-top:8px"><input type="text" id="tgToken" placeholder="123456789:AA…" spellcheck="false" style="flex:1">
          <button class="btn primary" id="tgConnect">Connecter</button></div>
          <div class="l-sub" id="tgMsg"></div></div></div>
      </div>`;
    $('tgFather').onclick = () => window.cube.send('open-url', 'https://t.me/BotFather');
    $('tgConnect').onclick = async () => {
      $('tgMsg').textContent = 'Vérification…';
      const r = await window.cube.invoke('telegram:connect', $('tgToken').value);
      if (!r.ok) { $('tgMsg').textContent = r.error; return; }
      tgDetected = null;
      renderSettings();
    };
    return;
  }
  const linked = !!tg.chatId;
  el.innerHTML = `<h2>Telegram</h2>
    <div class="group">
      <div class="line"><div class="l-label">Bot <b>@${escapeHTML(st.botName || '?')}</b>
          <div class="l-sub">${st.error ? escapeHTML(st.error) : linked ? `Relié à ta conversation${tg.chatName ? ` (${escapeHTML(tg.chatName)})` : ''}.` : ''}</div></div>
        <button class="btn danger" id="tgOff">Déconnecter</button></div>
      ${linked ? '' : `<div class="line"><div class="l-label">3. Envoie un message à ton bot
          <div class="l-sub">${tgDetected === 'timeout' ? 'Aucun message reçu. Envoie « bonjour » à ton bot, puis réessaie.'
            : st.detecting ? 'J\'attends ton message… (envoie « bonjour » à ton bot)' : 'Envoie-lui « bonjour » dans Telegram.'}</div></div>
          <button class="btn" id="tgDetect">${st.detecting ? 'En attente…' : 'Chercher'}</button></div>`}
    </div>
    ${linked ? `<div class="group">
      <div class="line"><div class="l-label">Envoyer les notifications sur Telegram</div>${toggle('tgOn', tg.enabled)}</div>
      ${EVENT_LABELS.map(([k, label]) => `<div class="line"><div class="l-label">${label}</div>${toggle('tgEv-' + k, tg.events[k])}</div>`).join('')}
    </div>
    <div class="group">
      <div class="line"><div class="l-label">Seulement quand je suis absent
          <div class="l-sub">Envoyé quand tu n'as pas touché la souris ni le clavier depuis :</div></div>
        <select id="tgDelay">${[60, 180, 300, 600].map((s) => `<option value="${s}" ${s === tg.awayDelay ? 'selected' : ''}>${s / 60} min</option>`).join('')}</select></div>
      <div class="line"><div class="l-label">Toujours envoyer<div class="l-sub">Même quand tu es devant le PC.</div></div>${toggle('tgAlways', tg.always)}</div>
    </div>
    <button class="btn" id="tgTest">Envoyer un message test</button> <span class="note" id="tgMsg"></span>
    <h2 style="margin-top:26px">Discuter depuis Telegram</h2>
    <div id="remoteBox"><div class="note">Chargement…</div></div>` : ''}`;
  $('tgOff').onclick = async () => {
    const ok = await window.cube.invoke('confirm', { message: 'Déconnecter Telegram ?', detail: 'Le token est effacé de ce PC.', ok: 'Déconnecter' });
    if (!ok) return;
    await window.cube.invoke('telegram:disconnect');
    renderSettings();
  };
  $('tgDetect')?.addEventListener('click', async () => {
    tgDetected = null;
    await window.cube.invoke('telegram:detect');
    renderSettings();
  });
  if (!linked) return;
  $('tgOn').onchange = (e) => { tg.enabled = e.target.checked; save(); };
  for (const [k] of EVENT_LABELS) $('tgEv-' + k).onchange = (e) => { tg.events[k] = e.target.checked; save(); };
  $('tgDelay').onchange = (e) => { tg.awayDelay = Number(e.target.value); save(); };
  $('tgAlways').onchange = (e) => { tg.always = e.target.checked; save(); };
  $('tgTest').onclick = async () => {
    $('tgMsg').textContent = 'Envoi…';
    const r = await window.cube.invoke('telegram:test');
    $('tgMsg').textContent = r.ok ? 'Envoyé ! Regarde ton téléphone.' : r.error;
  };
  renderRemote($('remoteBox'));
}

async function renderRemote(box) {
  const st = await window.cube.invoke('remote:status');
  if (!box.isConnected) return;
  const c = settings.telegram.commands;
  if (!st.configured) {
    box.innerHTML = `<p class="note">Réponds aux messages de ton bot pour continuer une conversation, ou envoie <b>/nouveau</b> pour en commencer une :
        ton IA répond directement sur Telegram. Pour que personne d'autre ne puisse le faire, il faut d'abord déverrouiller avec un code à 6 chiffres
        de ton app d'authentification (Google Authenticator, Microsoft Authenticator, 2FAS…).</p>
      <button class="btn primary" id="setupBegin">Configurer le code de déverrouillage</button>`;
    $('setupBegin').onclick = async () => {
      const s = await window.cube.invoke('remote:setup-begin');
      box.innerHTML = `<div class="group"><div class="line" style="align-items:flex-start;gap:16px">
          <img src="${s.qr}" width="160" height="160" style="border-radius:8px;flex:none" alt="QR code">
          <div class="l-label">1. Scanne ce QR code avec ton app d'authentification
            <div class="l-sub">Ou saisis la clé à la main : <code style="user-select:all">${escapeHTML(s.secret)}</code></div>
            <div style="margin-top:12px">2. Tape le code à 6 chiffres qu'elle affiche</div>
            <div style="display:flex;gap:8px;margin-top:8px"><input type="text" id="setupCode" maxlength="7" placeholder="123 456" style="width:110px">
              <button class="btn primary" id="setupOk">Valider</button></div>
            <div class="l-sub" id="setupMsg"></div></div></div></div>`;
      $('setupCode').focus();
      const ok = async () => {
        const r = await window.cube.invoke('remote:setup-confirm', $('setupCode').value);
        if (!r.ok) { $('setupMsg').textContent = r.error; return; }
        renderRemote(box);
      };
      $('setupOk').onclick = ok;
      $('setupCode').onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    };
    return;
  }
  const until = st.unlockedUntil ? new Date(st.unlockedUntil).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
  box.innerHTML = `<div class="group">
      <div class="line"><div class="l-label">Discuter depuis Telegram
          <div class="l-sub">Réponds au message d'une conversation pour la continuer · /nouveau <i>question</i> · /conversations</div></div>
        ${toggle('rOn', c.enabled)}</div>
      <div class="line"><div class="l-label">${until ? `🔓 Déverrouillé jusqu'à ${until}` : '🔒 Verrouillé'}
          <div class="l-sub">Envoie <b>/unlock</b> et ton code à ton bot pour déverrouiller 30 minutes. <b>/aide</b> donne la liste des commandes.</div></div>
        ${until ? '<button class="btn" id="rLock">Verrouiller</button>' : ''}</div>
    </div>
    <button class="btn" id="rLog">Ouvrir le journal</button>
    <button class="btn danger" id="rRemove">Supprimer le code</button>`;
  $('rOn').onchange = (e) => window.cube.invoke('remote:set', { enabled: e.target.checked });
  $('rLock')?.addEventListener('click', async () => { await window.cube.invoke('remote:lock'); renderRemote(box); });
  $('rLog').onclick = () => window.cube.send('remote:open-log');
  $('rRemove').onclick = async () => {
    const ok = await window.cube.invoke('confirm', { message: 'Supprimer le code de déverrouillage ?', detail: 'Les commandes depuis Telegram seront coupées.', ok: 'Supprimer' });
    if (!ok) return;
    await window.cube.invoke('remote:remove-code');
    renderRemote(box);
  };
}

function pageAbout(el) {
  el.innerHTML = `<h2>À propos</h2>
    <div class="group"><div class="line"><div class="l-label">Cube Hub LLM
      <div class="l-sub">Le cube de Cube Hub (app macOS de Harlo9, licence MIT) branché sur ton IA locale : Open WebUI et Ollama sur ton serveur.
        Tes conversations restent chez toi : l'app parle seulement à ton serveur (et à Telegram si tu l'actives).</div></div></div></div>
    <p class="note"><a id="repo">github.com/Harlo9/cube-hub</a></p>`;
  $('repo').onclick = () => window.cube.send('open-url', 'https://github.com/Harlo9/cube-hub');
}
