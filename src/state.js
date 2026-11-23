// Réglages de Cube Hub LLM, gardés dans ~/.cube-hub-llm/reglages.json.
const fs = require('fs');
const path = require('path');
const { stateFile } = require('./paths');

const defaults = () => ({
  welcomeDone: false,
  server: { url: '', defaultModel: '', activeWindowMin: 30 },
  widget: { visible: true, scale: 1, collapsed: false, x: null, y: null },
  sounds: { master: 1, bosse: 0.4, fini: 1, attente: 1, dodo: 0.4 },
  notifications: { windows: true, windowsEvents: { waiting: true, done: true } },
  telegram: {
    enabled: false, chatId: null, chatName: '', always: false, awayDelay: 180,
    events: { waiting: true, done: true },
    commands: { enabled: false },
  },
  hub: { selected: null, bounds: null, collapsed: {} },
});

function merge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      merge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}

let state = defaults();
try {
  state = merge(defaults(), JSON.parse(fs.readFileSync(stateFile, 'utf8')));
} catch {
  // Premier lancement, ou fichier illisible : réglages par défaut.
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}
function saveNow() {
  clearTimeout(saveTimer);
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    console.error('Sauvegarde impossible', e);
  }
}

module.exports = { get: () => state, save, saveNow };
