// Secrets (clé API, token Telegram, code de déverrouillage) gardés sur cet ordinateur.
// Chiffrés par le système quand c'est possible (DPAPI sous Windows, GNOME Keyring ou KWallet
// sous Linux). Sur un Linux sans trousseau, ils sont gardés dans un fichier lisible par toi
// seul (droits 600), comme le font la plupart des outils en ligne de commande.
const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');

const PLAIN = Buffer.from('PLAIN1:');

function encrypted() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = encrypted() ? safeStorage.encryptString(value) : Buffer.concat([PLAIN, Buffer.from(value, 'utf8')]);
  fs.writeFileSync(file, data, { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function read(file) {
  try {
    const data = fs.readFileSync(file);
    if (data.subarray(0, PLAIN.length).equals(PLAIN)) return data.subarray(PLAIN.length).toString('utf8');
    return safeStorage.decryptString(data);
  } catch {
    return null;
  }
}

module.exports = { write, read, encrypted };
