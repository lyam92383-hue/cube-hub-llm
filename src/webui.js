// Client d'Open WebUI : lit les conversations (et leurs dossiers), et écrit dans une
// conversation comme le fait l'interface web (le message est enregistré dans Open WebUI).
const crypto = require('crypto');

const POLL_MS = 3000;
const FULL_REFRESH_MS = 120_000;
const FOLDERS_MS = 30_000;
const WORKING_STALE_S = 10 * 60; // une réponse « en cours » plus vieille que ça a planté
const MAX_DETAILS_PER_TICK = 12;

const sec = (v) => (typeof v === 'number' ? (v > 1e12 ? Math.floor(v / 1000) : v) : Math.floor(Date.parse(v) / 1000) || 0);
const iso = (s) => new Date(sec(s) * 1000).toISOString();

class WebUI {
  constructor(getServer) {
    this.getServer = getServer; // () => ({ url, key })
  }

  base() {
    const { url } = this.getServer();
    if (!url) throw new Error('Adresse du serveur non réglée.');
    return url.replace(/\/+$/, '');
  }

  async request(method, path, body, { timeout = 15_000, raw = false } = {}) {
    const { key } = this.getServer();
    const res = await fetch(this.base() + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      body: body == null ? undefined : JSON.stringify(body),
      signal: timeout ? AbortSignal.timeout(timeout) : undefined,
    });
    if (raw) {
      if (!res.ok) throw new Error(await errorText(res));
      return res;
    }
    if (!res.ok) throw new Error(await errorText(res));
    return res.json();
  }

  version() { return this.request('GET', '/api/version'); }
  me() { return this.request('GET', '/api/v1/auths/'); }
  async models() {
    const r = await this.request('GET', '/api/models');
    return (r.data || r || []).map((m) => ({ id: m.id, name: m.name || m.id }));
  }
  folders() { return this.request('GET', '/api/v1/folders/'); }
  listChats(page = 1) { return this.request('GET', `/api/v1/chats/?page=${page}`); }
  pinned() { return this.request('GET', '/api/v1/chats/pinned').catch(() => []); }
  chat(id) { return this.request('GET', `/api/v1/chats/${encodeURIComponent(id)}`); }
  updateChat(id, chat) { return this.request('POST', `/api/v1/chats/${encodeURIComponent(id)}`, { chat }); }
  newChat(chat) { return this.request('POST', '/api/v1/chats/new', { chat }); }
  moveToFolder(id, folderId) { return this.request('POST', `/api/v1/chats/${encodeURIComponent(id)}/folder`, { folder_id: folderId || null }); }
  async tasksFor(id) {
    try {
      const r = await this.request('GET', `/api/tasks/chat/${encodeURIComponent(id)}`, null, { timeout: 5000 });
      return (r.task_ids || r.tasks || []).length > 0;
    } catch {
      return null; // pas disponible sur cette version d'Open WebUI
    }
  }
  async ollamaPs() {
    try {
      return (await this.request('GET', '/ollama/api/ps', null, { timeout: 5000 })).models || [];
    } catch {
      return null; // réservé aux administrateurs
    }
  }
}

async function errorText(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j.detail || j.error?.message || j.message || '';
  } catch {}
  if (res.status === 401 || res.status === 403) return `Accès refusé (${res.status}) : vérifie la clé API.${detail ? ' ' + detail : ''}`;
  return `Erreur ${res.status}${detail ? ' : ' + detail : ''}`;
}

// ------------------------------------------------------------ Conversations

/** Chemin de messages de la branche affichée (du premier message jusqu'à currentId). */
function linear(history) {
  const out = [];
  const msgs = history?.messages || {};
  let m = msgs[history?.currentId];
  const seen = new Set();
  while (m && !seen.has(m.id)) {
    seen.add(m.id);
    out.unshift(m);
    m = msgs[m.parentId];
  }
  return out;
}

function usageTokens(m) {
  const u = m?.usage || m?.info || {};
  const total = u.total_tokens ?? ((u.prompt_tokens ?? u.prompt_eval_count ?? 0) + (u.completion_tokens ?? u.eval_count ?? 0));
  return Number(total) || 0;
}

class ChatStore {
  /**
   * @param {WebUI} api
   * @param {(all:object[]) => void} onChange
   * @param {(status:object) => void} onStatus
   * @param {() => number} activeWindowMin  minutes pendant lesquelles une conversation reste « active »
   */
  constructor(api, { onChange, onStatus, activeWindowMin }) {
    Object.assign(this, { api, onChange, onStatus, activeWindowMin });
    this.summaries = new Map(); // id → { updated_at, title }
    this.details = new Map(); // id → réponse complète d'Open WebUI
    this.statusSince = new Map(); // id → { status, at }
    this.live = new Map(); // id → { content, model } réponse en train d'être écrite par l'app
    this.folders = [];
    this.pinnedIds = new Set();
    this.tasks = new Map(); // id → true si Open WebUI dit qu'une génération tourne
    this.lastFull = 0;
    this.lastFolders = 0;
    this.status = { ok: false, error: null, checkedAt: 0 };
    this.lastKey = '';
    this.timer = null;
  }

  start() {
    this.stop();
    const tick = async () => {
      await this.poll().catch(() => {});
      this.timer = setTimeout(tick, POLL_MS);
    };
    tick();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Repart de zéro (serveur ou clé changés). */
  reset() {
    this.summaries.clear();
    this.details.clear();
    this.statusSince.clear();
    this.folders = [];
    this.lastFull = 0;
    this.lastFolders = 0;
    this.lastKey = '';
    this.emit(true);
    this.start();
  }

  setStatus(s) {
    const changed = s.ok !== this.status.ok || s.error !== this.status.error;
    this.status = { ...s, checkedAt: Date.now() };
    if (changed) this.onStatus(this.status);
  }

  async poll() {
    let list;
    try {
      list = await this.api.listChats(1);
      if (!Array.isArray(list)) throw new Error('Réponse inattendue du serveur (est-ce bien Open WebUI ?)');
      this.setStatus({ ok: true, error: null });
    } catch (e) {
      this.setStatus({ ok: false, error: e.name === 'TimeoutError' ? 'Le serveur ne répond pas.' : e.message });
      return;
    }
    const now = Date.now();
    if (now - this.lastFolders > FOLDERS_MS) {
      this.lastFolders = now;
      this.folders = await this.api.folders().catch(() => this.folders);
      this.pinnedIds = new Set((await this.api.pinned()).map((c) => c.id));
    }
    const full = now - this.lastFull > FULL_REFRESH_MS;
    if (full) this.lastFull = now;

    const ids = new Set(list.map((c) => c.id));
    for (const id of [...this.summaries.keys()]) {
      if (!ids.has(id) && !this.live.has(id)) {
        this.summaries.delete(id);
        this.details.delete(id);
      }
    }
    const toFetch = [];
    for (const c of list) {
      const prev = this.summaries.get(c.id);
      this.summaries.set(c.id, { updated_at: sec(c.updated_at), title: c.title });
      const d = this.details.get(c.id);
      const working = d && this.rawStatus(d) === 'working';
      if (!d || !prev || prev.updated_at !== sec(c.updated_at) || working || full) toFetch.push(c.id);
    }
    // Les plus récentes d'abord ; le reste suit aux tours suivants.
    for (const id of toFetch.slice(0, full ? toFetch.length : MAX_DETAILS_PER_TICK)) {
      try {
        const d = await this.api.chat(id);
        this.details.set(id, d);
        if (this.recent(d)) this.tasks.set(id, await this.api.tasksFor(id));
      } catch {}
    }
    this.emit();
  }

  recent(d) {
    return Date.now() / 1000 - sec(d.updated_at) < this.activeWindowMin() * 60;
  }

  rawStatus(d) {
    if (this.live.has(d.id) || this.tasks.get(d.id) === true) return 'working';
    const msgs = linear(d.chat?.history);
    const last = msgs[msgs.length - 1];
    const age = Date.now() / 1000 - sec(d.updated_at);
    if (!last) return 'done';
    if (last.role === 'assistant') {
      if (last.error) return 'waiting';
      if (last.done === false && age < WORKING_STALE_S) return 'working';
      if (last.done === false) return 'waiting'; // réponse jamais terminée
      return 'done';
    }
    // Ton message n'a pas encore de réponse.
    return age < 120 ? 'working' : 'waiting';
  }

  toSession(d) {
    const msgs = linear(d.chat?.history);
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const lastAsst = [...msgs].reverse().find((m) => m.role === 'assistant');
    const status = this.rawStatus(d);
    const prev = this.statusSince.get(d.id);
    let since = prev?.at;
    if (!prev || prev.status !== status) {
      since = prev ? new Date().toISOString() : iso(d.updated_at);
      this.statusSince.set(d.id, { status, at: since });
    }
    const live = this.live.get(d.id);
    const model = live?.model || lastAsst?.model || d.chat?.models?.[0] || '';
    const error = lastAsst?.error ? (lastAsst.error.content || lastAsst.error.message || String(lastAsst.error)) : null;
    return {
      id: d.id,
      projectName: d.title || 'Sans titre',
      status,
      startedAt: iso(d.created_at),
      updatedAt: iso(d.updated_at),
      statusChangedAt: since,
      lastPromptAt: lastUser ? iso(lastUser.timestamp || d.updated_at) : null,
      lastCompletedTask: null,
      currentTask: lastUser ? oneLine(lastUser.content, 140) : null,
      contextTokens: usageTokens(lastAsst),
      model,
      folderId: d.folder_id || null,
      pinned: !!d.pinned || this.pinnedIds.has(d.id),
      messageCount: msgs.length,
      lastAnswer: lastAsst && status !== 'working' ? { excerpt: String(lastAsst.content || '').slice(0, 600), at: iso(lastAsst.timestamp || d.updated_at) } : null,
      error,
      active: status === 'working' || this.recent(d),
    };
  }

  all() {
    return [...this.details.values()]
      .filter((d) => !d.archived)
      .map((d) => this.toSession(d))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  emit(force) {
    const all = this.all();
    const key = JSON.stringify([all, this.folders]);
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.onChange(all, this.folders);
  }

  /** La conversation complète, avec la réponse en cours si l'app est en train de l'écrire. */
  conversation(id) {
    const d = this.details.get(id);
    if (!d) return null;
    const msgs = linear(d.chat?.history).map((m) => ({
      id: m.id, role: m.role, content: m.content || '', model: m.model || '', timestamp: m.timestamp,
      done: m.done !== false, error: m.error ? (m.error.content || m.error.message || 'Erreur') : null, tokens: usageTokens(m),
    }));
    const live = this.live.get(id);
    if (live && msgs.length && msgs[msgs.length - 1].role === 'assistant') {
      msgs[msgs.length - 1].content = live.content;
      msgs[msgs.length - 1].done = false;
    }
    return { id, title: d.title, folderId: d.folder_id || null, models: d.chat?.models || [], messages: msgs };
  }

  async refresh(id) {
    const d = await this.api.chat(id);
    this.details.set(id, d);
    this.summaries.set(id, { updated_at: sec(d.updated_at), title: d.title });
    this.emit();
    return d;
  }

  // ------------------------------------------------ Écrire

  /**
   * Envoie `text` dans la conversation `chatId` (ou une nouvelle si null), en streaming,
   * et l'enregistre dans Open WebUI. Renvoie l'id de la conversation.
   */
  async send(chatId, text, model, onProgress = () => {}, onCreated = () => {}) {
    text = String(text || '').trim();
    if (!text) throw new Error('Message vide.');
    let d;
    if (chatId) {
      d = await this.api.chat(chatId);
    } else {
      if (!model) throw new Error('Choisis un modèle.');
      d = await this.api.newChat({
        id: '', title: oneLine(text, 48), models: [model], params: {}, history: { messages: {}, currentId: null },
        messages: [], tags: [], timestamp: Date.now(),
      });
      chatId = d.id;
      onCreated(chatId);
    }
    if (this.live.has(chatId)) throw new Error('Une réponse est déjà en train de s\'écrire dans cette conversation.');
    const chat = d.chat || {};
    const history = chat.history || { messages: {}, currentId: null };
    history.messages = history.messages || {};
    const path0 = linear(history);
    model = model || [...path0].reverse().find((m) => m.role === 'assistant')?.model || chat.models?.[0];
    if (!model) throw new Error('Aucun modèle pour cette conversation.');

    const now = Math.floor(Date.now() / 1000);
    const userId = crypto.randomUUID();
    const asstId = crypto.randomUUID();
    const parentId = history.currentId || null;
    history.messages[userId] = { id: userId, parentId, childrenIds: [asstId], role: 'user', content: text, timestamp: now, models: [model] };
    if (parentId && history.messages[parentId]) {
      history.messages[parentId].childrenIds = [...(history.messages[parentId].childrenIds || []), userId];
    }
    history.messages[asstId] = {
      id: asstId, parentId: userId, childrenIds: [], role: 'assistant', content: '', model, modelName: model,
      modelIdx: 0, timestamp: now, done: false,
    };
    history.currentId = asstId;
    const save = () => {
      chat.history = history;
      chat.messages = linear(history);
      chat.models = chat.models?.length ? chat.models : [model];
      return this.api.updateChat(chatId, chat);
    };
    await save();
    this.live.set(chatId, { content: '', model });
    this.details.set(chatId, { ...d, id: chatId, chat: { ...chat }, updated_at: now });
    this.emit();

    const asst = history.messages[asstId];
    let lastEmit = 0;
    try {
      const messages = linear(history).filter((m) => m.id !== asstId).map((m) => ({ role: m.role, content: m.content }));
      const res = await this.api.request('POST', '/api/chat/completions', { model, messages, stream: true }, { timeout: 0, raw: true });
      const type = res.headers.get('content-type') || '';
      if (!type.includes('text/event-stream')) {
        // Certaines versions répondent d'un bloc.
        const j = await res.json();
        if (j.error || j.detail) throw new Error(j.error?.message || j.detail);
        asst.content = j.choices?.[0]?.message?.content || '';
        if (j.usage) asst.usage = j.usage;
      } else {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let j;
            try { j = JSON.parse(payload); } catch { continue; }
            if (j.error) throw new Error(j.error.message || j.error.content || JSON.stringify(j.error));
            if (j.detail) throw new Error(j.detail);
            const delta = j.choices?.[0]?.delta?.content;
            if (delta) asst.content += delta;
            if (j.usage) asst.usage = j.usage;
          }
          this.live.set(chatId, { content: asst.content, model });
          if (Date.now() - lastEmit > 150) {
            lastEmit = Date.now();
            onProgress(chatId, asst.content);
          }
        }
      }
      asst.done = true;
    } catch (e) {
      asst.done = true;
      asst.error = { content: e.message };
    } finally {
      this.live.delete(chatId);
      onProgress(chatId, asst.content);
      try {
        await save();
      } catch {}
      await this.refresh(chatId).catch(() => this.emit());
    }
    if (asst.error) throw new Error(asst.error.content);
    return chatId;
  }
}

function oneLine(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

module.exports = { WebUI, ChatStore };
