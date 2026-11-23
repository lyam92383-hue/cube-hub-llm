// Faux Open WebUI (avec Ollama derrière), pour tester Cube Hub LLM sans serveur.
// node scripts/mock-openwebui.js [port]   — clé API acceptée : sk-test
// POST /mock/activity {chat_id}  simule une réponse en train de s'écrire dans Open WebUI (4 s).
const http = require('http');
const crypto = require('crypto');

const port = Number(process.argv[2] || 8080);
const KEY = 'sk-test';
const now = () => Math.floor(Date.now() / 1000);
const uid = () => crypto.randomUUID();

const folders = [
  { id: 'f-travail', name: 'Travail', parent_id: null, is_expanded: true },
  { id: 'f-perso', name: 'Perso', parent_id: null, is_expanded: true },
];
const chats = new Map();

function makeChat(title, folder, turns, ageMin, model = 'llama3.1:8b') {
  const id = uid();
  const messages = {};
  let parent = null;
  let t = now() - ageMin * 60;
  for (const [q, a] of turns) {
    const u = uid();
    const r = uid();
    messages[u] = { id: u, parentId: parent, childrenIds: [r], role: 'user', content: q, timestamp: t, models: [model] };
    if (parent) messages[parent].childrenIds = [u];
    messages[r] = {
      id: r, parentId: u, childrenIds: [], role: 'assistant', content: a, model, modelName: model, timestamp: t + 5, done: true,
      usage: { prompt_tokens: 800 + a.length, completion_tokens: a.length / 4 | 0, total_tokens: 900 + a.length },
    };
    parent = r;
    t += 60;
  }
  const chat = {
    id, user_id: 'u1', title, folder_id: folder, pinned: false, archived: false, created_at: now() - ageMin * 60 - 600, updated_at: now() - ageMin * 60,
    chat: { id: '', title, models: [model], history: { messages, currentId: parent }, messages: linear(messages, parent), timestamp: Date.now() },
  };
  chats.set(id, chat);
  return chat;
}

function linear(messages, currentId) {
  const out = [];
  let m = messages[currentId];
  while (m) {
    out.unshift(m);
    m = messages[m.parentId];
  }
  return out;
}

makeChat('Script de sauvegarde du NAS', 'f-travail', [['Écris-moi un script bash qui sauvegarde /srv vers mon NAS chaque nuit.', 'Voici un script **rsync** avec rotation :\n\n```bash\n#!/bin/bash\nrsync -a --delete /srv/ nas:/backup/srv/\n```\n\nAjoute-le à `crontab -e` avec `0 3 * * *`.']], 3);
makeChat('Recette de lasagnes', 'f-perso', [['Une recette de lasagnes végé pour 4 ?', 'Bien sûr ! Il te faut des courgettes, des épinards, de la ricotta…']], 20, 'qwen2.5:14b');
makeChat('Config Nginx reverse proxy', 'f-travail', [['Comment mettre Open WebUI derrière Nginx ?', 'Utilise un bloc `location /` avec `proxy_pass http://127.0.0.1:8080;` et les en-têtes WebSocket.']], 240);
makeChat('Idées de nom de chaîne YouTube', null, [['Des idées de nom pour une chaîne tech ?', '1. Octet Libre\n2. Le Labo du Dev\n3. Pixel & Kernel']], 2000);

const busy = new Map(); // chat id → fin de la génération simulée

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}
const summary = (c) => ({ id: c.id, title: c.title, updated_at: c.updated_at, created_at: c.created_at });

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const data = body ? JSON.parse(body) : {};
    if (p === '/mock/activity') {
      const c = chats.get(data.chat_id);
      const cur = c.chat.history.messages[c.chat.history.currentId];
      cur.done = false;
      c.updated_at = now();
      busy.set(c.id, Date.now() + 4000);
      setTimeout(() => { cur.done = true; cur.content += '\n\n(suite écrite dans Open WebUI)'; c.updated_at = now(); busy.delete(c.id); }, 4000);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/version') return json(res, 200, { version: '0.6.5' });
    if (p === '/health') return json(res, 200, { status: true });
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(res, 401, { detail: 'Not authenticated' });

    if (p === '/api/v1/auths/') return json(res, 200, { id: 'u1', name: 'Testeur', email: 'test@example.com', role: 'admin' });
    if (p === '/api/models') return json(res, 200, { data: [{ id: 'llama3.1:8b', name: 'llama3.1:8b', owned_by: 'ollama' }, { id: 'qwen2.5:14b', name: 'qwen2.5:14b', owned_by: 'ollama' }] });
    if (p === '/ollama/api/ps') return json(res, 200, { models: [{ name: 'llama3.1:8b', size: 6e9, size_vram: 5.5e9, expires_at: new Date(Date.now() + 240000).toISOString() }] });
    if (p === '/api/v1/folders/') return json(res, 200, folders);
    if (p === '/api/v1/chats/' || p === '/api/v1/chats/list') {
      const page = Number(url.searchParams.get('page') || 1);
      const list = [...chats.values()].filter((c) => !c.archived).sort((a, b) => b.updated_at - a.updated_at);
      return json(res, 200, list.slice((page - 1) * 60, page * 60).map(summary));
    }
    if (p === '/api/v1/chats/pinned') return json(res, 200, [...chats.values()].filter((c) => c.pinned).map(summary));
    if (p === '/api/v1/chats/new' && req.method === 'POST') {
      const c = { id: uid(), user_id: 'u1', title: data.chat.title || 'New Chat', folder_id: null, pinned: false, archived: false, created_at: now(), updated_at: now(), chat: data.chat };
      chats.set(c.id, c);
      return json(res, 200, c);
    }
    let m = p.match(/^\/api\/v1\/chats\/folder\/([^/]+)$/);
    if (m) return json(res, 200, [...chats.values()].filter((c) => c.folder_id === m[1]));
    m = p.match(/^\/api\/tasks\/chat\/([^/]+)$/);
    if (m) return json(res, 200, { task_ids: busy.has(m[1]) ? ['t-' + m[1]] : [] });
    m = p.match(/^\/api\/v1\/chats\/([^/]+)\/folder$/);
    if (m && req.method === 'POST') {
      const c = chats.get(m[1]);
      if (!c) return json(res, 404, { detail: 'Not found' });
      c.folder_id = data.folder_id || null;
      return json(res, 200, c);
    }
    m = p.match(/^\/api\/v1\/chats\/([^/]+)$/);
    if (m) {
      const c = chats.get(m[1]);
      if (!c) return json(res, 404, { detail: 'Not found' });
      if (req.method === 'POST') {
        c.chat = { ...c.chat, ...data.chat };
        if (data.chat.title) c.title = data.chat.title;
        c.updated_at = now();
      }
      return json(res, 200, c);
    }
    if (p === '/api/chat/completions' && req.method === 'POST') {
      const last = data.messages[data.messages.length - 1]?.content || '';
      const answer = `Réponse de ${data.model} à « ${last.slice(0, 60)} » : voici quelques idées, étape par étape. 1) D'abord… 2) Ensuite… 3) Enfin.`;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const word of answer.split(/(?<= )/)) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 60));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {} , finish_reason: 'stop' }], usage: { prompt_tokens: 420, completion_tokens: 60, total_tokens: 480 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    json(res, 404, { detail: 'Not found' });
  });
}).listen(port, '127.0.0.1', () => console.log(`faux Open WebUI sur http://127.0.0.1:${port} (clé ${KEY})`));
