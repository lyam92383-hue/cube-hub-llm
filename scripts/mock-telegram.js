// Faux serveur de l'API Telegram, pour tester Cube Hub sans vrai bot.
// POST /push {message|callback_query} ajoute un message entrant.
const http = require('http');
const fs = require('fs');
const log = process.argv[2];
let nextId = 10;
let nextMsg = 100;
const queue = [{ update_id: nextId++, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 4242, type: 'private', first_name: 'Testeur' }, from: { id: 4242 }, text: 'bonjour' } }];

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const params = body ? JSON.parse(body) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/push') {
      queue.push({ update_id: nextId++, ...params });
      return res.end('{"ok":true}');
    }
    const method = req.url.split('/').pop();
    let result = true;
    if (method === 'getMe') result = { id: 1, is_bot: true, username: 'cube_test_bot' };
    if (method === 'getUpdates') {
      const off = params.offset || 0;
      for (let i = 0; i < 20 && !queue.some((u) => u.update_id >= off) && params.timeout; i++) await new Promise((r) => setTimeout(r, 100));
      result = queue.filter((u) => u.update_id >= off);
    }
    if (method === 'sendMessage') result = { message_id: nextMsg++, date: Math.floor(Date.now() / 1000), chat: { id: params.chat_id } };
    fs.appendFileSync(log, JSON.stringify({ method, params, result: method === 'sendMessage' ? result.message_id : undefined }) + '\n');
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(8787, '127.0.0.1', () => console.log('mock prêt'));
