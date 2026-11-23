// Commandes depuis Telegram : écrire à une conversation de ton IA (en répondant à son
// message), ou en commencer une nouvelle. La réponse de l'IA revient sur Telegram.
//
// Sécurité (tout est refusé par défaut) :
// - seule ta conversation avec le bot compte ;
// - il faut d'abord déverrouiller avec /unlock et le code à 6 chiffres de ton app
//   d'authentification (30 minutes) ; 5 mauvais codes de suite coupent les commandes ;
// - messages trop vieux, trop longs, trop nombreux ou en double refusés ;
// - tout est noté dans ~/.cube-hub-llm/remote.log (jamais le code).
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const paths = require('./paths');
const totp = require('./totp');

const C = {
  maxAgeSec: 60,
  maxLength: 4000,
  maxPerMinute: 5,
  duplicateWindowMs: 30_000,
  maxRefusals: 10,
  refusalWindowMs: 10 * 60_000,
  unlockMs: 30 * 60_000,
  maxFailedCodes: 5,
  codeWaitMs: 60_000,
  rememberedMessages: 300,
  logExcerpt: 200,
  logMaxSize: 1_000_000,
  pollTimeoutSec: 25,
  retryDelayMs: 5000,
  telegramMaxText: 3800,
};

const SECRET_FILE = path.join(paths.baseDir, 'telegram-totp.bin');
const LOG_FILE = path.join(paths.baseDir, 'remote.log');

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

class Remote {
  /**
   * @param {object} o
   * @param {import('./notify').Notifier} o.notifier
   * @param {() => object} o.getSettings
   * @param {() => void} o.save
   * @param {() => object[]} o.sessions  toutes les conversations
   * @param {(chatId:string|null, text:string) => Promise<string>} o.sendToChat  renvoie l'id de la conversation
   * @param {(chatId:string) => object|null} o.conversation
   * @param {() => void} o.changed
   */
  constructor(o) {
    Object.assign(this, o);
    this.unlockedUntil = 0;
    this.failedCodes = 0;
    this.awaitingCodeUntil = 0;
    this.refusals = [];
    this.recentSends = [];
    this.messageMap = new Map(); // message_id Telegram → id de la conversation
    this.offset = 0;
    this.running = false;
    this.pendingSecret = null;
    this.notifier.decorate = () => ({});
    this.notifier.onSent = (message, s) => this.remember(message, s.id);
  }

  get tg() {
    return this.getSettings().telegram;
  }

  get enabled() {
    const tg = this.tg;
    return !!(tg.commands?.enabled && tg.chatId && this.hasSecret() && this.notifier.hasToken());
  }

  get unlocked() {
    return Date.now() < this.unlockedUntil;
  }

  status() {
    return { configured: this.hasSecret(), enabled: this.enabled, unlockedUntil: this.unlocked ? this.unlockedUntil : null, polling: this.running };
  }

  // ------------------------------------------------ Code de déverrouillage

  hasSecret() {
    return fs.existsSync(SECRET_FILE);
  }

  readSecret() {
    try {
      return safeStorage.decryptString(fs.readFileSync(SECRET_FILE));
    } catch {
      return null;
    }
  }

  async beginSetup() {
    this.pendingSecret = totp.newSecret();
    const url = totp.otpauthURL(this.pendingSecret, 'Telegram');
    const qr = await require('qrcode').toDataURL(url, { margin: 1, width: 320 });
    return { secret: this.pendingSecret.match(/.{1,4}/g).join(' '), qr };
  }

  confirmSetup(code) {
    if (!this.pendingSecret) return { ok: false, error: 'Recommence la configuration.' };
    if (!totp.verify(this.pendingSecret, code)) return { ok: false, error: 'Code incorrect. Vérifie l\'heure du téléphone et réessaie.' };
    fs.mkdirSync(paths.baseDir, { recursive: true });
    fs.writeFileSync(SECRET_FILE, safeStorage.encryptString(this.pendingSecret));
    this.pendingSecret = null;
    this.log('code configuré');
    return { ok: true };
  }

  removeSecret() {
    try { fs.unlinkSync(SECRET_FILE); } catch {}
    this.lock('code supprimé');
    this.tg.commands.enabled = false;
    this.save();
    this.sync();
  }

  lock(reason) {
    this.unlockedUntil = 0;
    this.awaitingCodeUntil = 0;
    if (reason) this.log(`verrouillé (${reason})`);
    this.changed();
  }

  // ------------------------------------------------ Écoute de Telegram

  sync() {
    if (this.enabled && !this.running) this.loop();
    if (!this.enabled) this.running = false;
    this.changed();
  }

  async loop() {
    this.running = true;
    // Les messages envoyés pendant que l'app était fermée sont ignorés.
    try {
      const last = await this.notifier.call('getUpdates', { offset: -1, timeout: 0 });
      if (last.length) this.offset = Math.max(this.offset, last[last.length - 1].update_id + 1);
    } catch {}
    this.offset = Math.max(this.offset, this.notifier.updateOffset || 0);
    while (this.running && this.enabled) {
      if (this.notifier.detecting) {
        await wait(1000);
        continue;
      }
      try {
        const updates = await this.notifier.call('getUpdates', {
          offset: this.offset, timeout: C.pollTimeoutSec, allowed_updates: ['message'],
        }, undefined, (C.pollTimeoutSec + 10) * 1000);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (u.message) {
            // Pas d'await : une réponse longue de l'IA ne bloque pas les autres messages.
            this.onMessage(u.message).catch((e) => this.log(`erreur : ${e.message}`));
          }
        }
      } catch {
        if (!this.running) break;
        await wait(C.retryDelayMs);
      }
    }
    this.running = false;
  }

  stop() {
    this.running = false;
  }

  reply(text, extra = {}) {
    return this.notifier.send(text, extra).catch((e) => this.log(`envoi impossible : ${e.message}`));
  }

  refuse(text, why) {
    this.log(`refusé : ${why}`);
    const now = Date.now();
    this.refusals = this.refusals.filter((t) => now - t < C.refusalWindowMs);
    this.refusals.push(now);
    if (this.refusals.length >= C.maxRefusals && this.unlocked) {
      this.lock('trop de refus');
      return this.reply('🔒 Trop de messages refusés : les commandes sont verrouillées. Renvoie /unlock avec ton code.');
    }
    return text ? this.reply(text) : null;
  }

  // ------------------------------------------------ Messages

  async onMessage(m) {
    if (!m.chat || m.chat.id !== this.tg.chatId) {
      this.log(`ignoré : message d'une autre conversation Telegram (${m.chat?.id})`);
      return;
    }
    const text = String(m.text || '').trim();
    const shown = /^\/unlock\b/i.test(text) || (Date.now() < this.awaitingCodeUntil && /^\d{3}\s?\d{3}$/.test(text))
      ? text.replace(/\d/g, '•') : text;
    this.log(`reçu : ${shown.slice(0, C.logExcerpt)}`);
    if (Date.now() / 1000 - m.date > C.maxAgeSec) return this.refuse('⌛ Message arrivé en retard, ignoré. Renvoie-le.', 'trop ancien');
    if (!text) return this.refuse('Je ne comprends que le texte.', 'pas de texte');

    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd.toLowerCase().replace(/@\w+$/, '')) {
      case '/start':
      case '/aide':
      case '/help':
        return this.reply(this.helpText());
      case '/lock':
        this.lock('/lock');
        return this.reply('🔒 Verrouillé.');
      case '/unlock':
        if (arg) return this.tryCode(arg);
        this.awaitingCodeUntil = Date.now() + C.codeWaitMs;
        return this.reply('🔑 Envoie le code à 6 chiffres de ton app d\'authentification.');
      case '/conversations':
      case '/sessions':
        return this.listChats();
      case '/nouveau':
      case '/new':
        if (!arg) return this.reply('Écris ta question après /nouveau, par exemple : /nouveau Une idée de dîner ?');
        return this.sendTo(null, arg);
      default:
        break;
    }
    if (Date.now() < this.awaitingCodeUntil && /^\d{3}\s?\d{3}$/.test(text)) return this.tryCode(text);
    if (text.startsWith('/')) return this.refuse('Commande inconnue. /aide pour la liste.', 'commande inconnue');
    const replyTo = m.reply_to_message?.message_id;
    if (!replyTo || !this.messageMap.has(replyTo)) {
      return this.refuse('↩️ Réponds au message d\'une conversation pour lui écrire (/conversations pour la liste), ou commence-en une avec /nouveau.', 'conversation inconnue');
    }
    return this.sendTo(this.messageMap.get(replyTo), text);
  }

  helpText() {
    return [
      '🧊 <b>Cube Hub LLM</b> — commandes',
      '/unlock <i>code</i> : déverrouiller 30 min avec ton app d\'authentification',
      '/lock : verrouiller',
      '/conversations : tes conversations récentes',
      '/nouveau <i>question</i> : nouvelle conversation (modèle par défaut)',
      '',
      'Pour continuer une conversation, <b>réponds</b> (glisser vers la gauche) à un de ses messages : la réponse de ton IA arrive ici.',
    ].join('\n');
  }

  async tryCode(input) {
    this.awaitingCodeUntil = 0;
    const secret = this.readSecret();
    if (secret && totp.verify(secret, input)) {
      this.failedCodes = 0;
      this.unlockedUntil = Date.now() + C.unlockMs;
      this.log('déverrouillé');
      this.changed();
      const until = new Date(this.unlockedUntil).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      return this.reply(`🔓 Déverrouillé jusqu'à ${until}.`);
    }
    this.failedCodes++;
    this.log(`mauvais code (${this.failedCodes})`);
    if (this.failedCodes >= C.maxFailedCodes) {
      this.failedCodes = 0;
      this.tg.commands.enabled = false;
      this.save();
      this.lock('trop de mauvais codes');
      this.sync();
      return this.reply('⛔ Trop de mauvais codes : les commandes sont coupées. Rallume-les sur le PC (Réglages → Telegram).');
    }
    return this.reply('❌ Code incorrect.');
  }

  async listChats() {
    if (!this.unlocked) return this.refuse('🔒 Verrouillé. Envoie /unlock suivi de ton code.', 'verrouillé');
    const list = this.sessions().slice(0, 8);
    if (!list.length) return this.reply('Aucune conversation.');
    const label = { working: '🔵 écrit', waiting: '🟠 erreur', done: '🟢 prête' };
    for (const s of list) {
      const msg = await this.reply(`<b>${esc(s.projectName)}</b> — ${label[s.status]}${s.model ? ` · ${esc(s.model)}` : ''}` +
        (s.currentTask ? `\n<i>${esc(s.currentTask)}</i>` : '') + '\n↩️ Réponds à ce message pour continuer.');
      if (msg) this.remember(msg, s.id);
    }
    return null;
  }

  async sendTo(chatId, text) {
    if (!this.unlocked) return this.refuse('🔒 Verrouillé. Envoie /unlock suivi du code de ton app d\'authentification.', 'verrouillé');
    if (chatId && !this.sessions().some((s) => s.id === chatId)) return this.refuse('Cette conversation n\'existe plus.', 'conversation disparue');
    if (text.length > C.maxLength) return this.refuse(`Message trop long (${C.maxLength} caractères au plus).`, 'trop long');
    const now = Date.now();
    this.recentSends = this.recentSends.filter((x) => now - x.at < 60_000);
    if (this.recentSends.length >= C.maxPerMinute) return this.refuse('⏱️ Trop de messages en une minute, attends un peu.', 'trop de messages');
    if (this.recentSends.some((x) => x.chatId === chatId && x.text === text && now - x.at < C.duplicateWindowMs)) {
      return this.refuse('Même message déjà envoyé à l\'instant, ignoré.', 'doublon');
    }
    this.recentSends.push({ at: now, chatId, text });
    this.log(`envoyé à ${chatId || 'nouvelle conversation'} : ${text.slice(0, C.logExcerpt)}`);
    await this.notifier.call('sendChatAction', { chat_id: this.tg.chatId, action: 'typing' }).catch(() => {});
    if (chatId) this.notifier.mute(chatId);
    let id;
    try {
      id = await this.sendToChat(chatId, text, (newId) => this.notifier.mute(newId));
    } catch (e) {
      return this.reply(`⚠️ ${esc(e.message)}`);
    }
    const conv = this.conversation(id);
    const last = conv?.messages?.[conv.messages.length - 1];
    let answer = last?.role === 'assistant' ? last.content : '';
    if (answer.length > C.telegramMaxText) answer = answer.slice(0, C.telegramMaxText) + '\n…(suite dans le Cube Hub)';
    const msg = await this.reply(`💬 <b>${esc(conv?.title || 'Conversation')}</b>\n${esc(answer || '(réponse vide)')}`);
    if (msg) this.remember(msg, id);
    return null;
  }

  remember(message, chatId) {
    if (!message?.message_id || !chatId) return;
    this.messageMap.set(message.message_id, chatId);
    while (this.messageMap.size > C.rememberedMessages) this.messageMap.delete(this.messageMap.keys().next().value);
  }

  // ------------------------------------------------ Journal

  log(line) {
    try {
      fs.mkdirSync(paths.baseDir, { recursive: true });
      try {
        if (fs.statSync(LOG_FILE).size > C.logMaxSize) fs.renameSync(LOG_FILE, LOG_FILE + '.1');
      } catch {}
      fs.appendFileSync(LOG_FILE, `${new Date().toISOString()}  ${line.replace(/\s+/g, ' ')}\n`);
    } catch {}
  }
}

module.exports = { Remote, LOG_FILE };
