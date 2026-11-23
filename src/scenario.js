// Vérification automatique contre le faux Open WebUI (scripts/mock-openwebui.js) :
// CUBE_SCENARIO=<dossier> CUBE_LLM_URL=http://127.0.0.1:8080 CUBE_LLM_KEY=sk-test
const fs = require('fs');
const path = require('path');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function scenario(ctx, dir, log) {
  const { store, widget, openHub, getHub, api } = ctx;
  fs.mkdirSync(dir, { recursive: true });
  const shot = async (win, name) => {
    win.webContents.invalidate();
    await wait(250);
    fs.writeFileSync(path.join(dir, name + '.png'), (await win.webContents.capturePage()).toPNG());
    log('capture', name);
  };
  const base = process.env.CUBE_LLM_URL;
  const mock = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body) });

  await wait(5000);
  const all = store.all();
  log('conversations lues :', all.length, '| actives :', all.filter((c) => c.active).map((c) => `${c.projectName} (${c.status})`).join(', '));
  log('dossiers :', store.folders.map((f) => f.name).join(', '));
  await shot(widget, '01-widget');

  // Une réponse s'écrit dans Open WebUI (pas dans l'app).
  const nas = all.find((c) => c.projectName.startsWith('Script'));
  await mock('/mock/activity', { chat_id: nas.id });
  await wait(3500);
  log('pendant la génération dans Open WebUI :', store.all().find((c) => c.id === nas.id).status);
  await shot(widget, '02-widget-ecrit');
  await wait(5000);
  log('après :', store.all().find((c) => c.id === nas.id).status);
  await shot(widget, '03-widget-pret');

  // Le Hub, sur cette conversation.
  openHub({ selectSession: nas.id });
  await wait(3500);
  await shot(getHub(), '04-hub');

  // On continue la conversation depuis l'app.
  const sending = store.send(nas.id, 'Et comment je vérifie que la sauvegarde a marché ?', null, (id, c) => {
    if (getHub()) getHub().webContents.send('chat:progress', { chatId: id, content: c });
  });
  getHub().webContents.executeJavaScript(`document.getElementById('input').value=''`);
  await wait(1200);
  await shot(getHub(), '05-hub-en-direct');
  await sending;
  const conv = store.conversation(nas.id);
  const last = conv.messages[conv.messages.length - 1];
  log('réponse enregistrée dans Open WebUI :', last.role, last.done, JSON.stringify(last.content.slice(0, 60)));
  const saved = await api.chat(nas.id);
  log('messages côté serveur :', saved.chat.messages.length, '| currentId ok :', saved.chat.history.currentId === saved.chat.messages[saved.chat.messages.length - 1].id);
  await wait(1500);
  await shot(getHub(), '06-hub-fini');

  // Nouvelle conversation, puis rangement dans un dossier.
  const id = await store.send(null, 'Donne-moi trois idées de projets pour un Raspberry Pi', 'qwen2.5:14b');
  const created = await api.chat(id);
  log('nouvelle conversation :', JSON.stringify(created.title), created.chat.messages.length, 'messages');
  await api.moveToFolder(id, 'f-perso');
  await store.refresh(id);
  log('rangée dans :', store.all().find((c) => c.id === id).folderId);
  getHub().webContents.send('hub:command', { selectSession: id });
  await wait(2500);
  await shot(getHub(), '07-hub-nouvelle');
  await shot(widget, '08-widget-fin');

  // Discuter depuis Telegram (avec un faux serveur Telegram, CUBE_TELEGRAM_API).
  const tgApi = process.env.CUBE_TELEGRAM_API;
  if (!tgApi) return;
  const totp = require('./totp');
  const { notifier, remote, state } = ctx;
  const push = (u) => fetch(`${tgApi}/push`, { method: 'POST', body: JSON.stringify(u) });
  const now = () => Math.floor(Date.now() / 1000);
  const msg = (text, extra = {}) => push({ message: { message_id: 1, date: now(), chat: { id: 4242, type: 'private' }, from: { id: 4242 }, text, ...extra } });
  log('bot :', await notifier.connect('123456789:' + 'A'.repeat(35)));
  await new Promise((resolve) => notifier.detectChat((chat) => {
    Object.assign(state.telegram, { chatId: chat.id, enabled: true, always: true });
    resolve();
  }));
  await remote.beginSetup();
  const secret = remote.pendingSecret;
  log('code configuré :', remote.confirmSetup(totp.code(secret, totp.counterAt(Date.now()))).ok);
  state.telegram.commands.enabled = true;
  remote.sync();
  await wait(1500);
  await msg('/conversations');
  await wait(1500);
  await msg('/unlock ' + totp.code(secret, totp.counterAt(Date.now())));
  await wait(1500);
  await msg('/conversations');
  await wait(2500);
  // Réponse au premier message listé (message_id attribué par le faux serveur).
  const firstListed = [...remote.messageMap.entries()][0];
  log('message listé →', firstListed && store.all().find((c) => c.id === firstListed[1])?.projectName);
  await msg('Résume en une phrase', { reply_to_message: { message_id: firstListed[0] } });
  await wait(6000);
  await msg('/nouveau Quelle heure est-il à Tokyo ?');
  await wait(6000);
  remote.stop();
};
