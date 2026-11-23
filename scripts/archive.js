// Écrit des archives tar (ustar) et ar sans outil externe, pour fabriquer les paquets Linux
// depuis n'importe quel système (droits Unix, propriétaire root, liens symboliques).
const fs = require('fs');
const path = require('path');

function octal(n, len) {
  return n.toString(8).padStart(len - 1, '0') + '\0';
}

function splitName(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' };
  const parts = name.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    const rest = parts.slice(i).join('/');
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix };
  }
  throw new Error(`Chemin trop long pour tar : ${name}`);
}

function header({ name, mode, size = 0, type = '0', linkname = '', mtime }) {
  const h = Buffer.alloc(512, 0);
  const { name: n, prefix } = splitName(name);
  h.write(n, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii');
  h.write(octal(0, 8), 116, 8, 'ascii');
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii');
  h.write(type, 156, 1, 'ascii');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  h.write('root', 265, 32, 'ascii');
  h.write('root', 297, 32, 'ascii');
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148, 8, 'ascii');
  return h;
}

/**
 * Archive tar en mémoire.
 * entries : { name, dir?:true, data?:Buffer, file?:string, mode, symlink?:string }
 */
function tar(entries, mtime = Math.floor(Date.now() / 1000)) {
  const chunks = [];
  for (const e of entries) {
    if (e.dir) {
      chunks.push(header({ name: e.name.replace(/\/?$/, '/'), mode: e.mode ?? 0o755, type: '5', mtime }));
    } else if (e.symlink) {
      chunks.push(header({ name: e.name, mode: 0o777, type: '2', linkname: e.symlink, mtime }));
    } else {
      const data = e.data ?? fs.readFileSync(e.file);
      chunks.push(header({ name: e.name, mode: e.mode ?? 0o644, size: data.length, mtime }));
      chunks.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

/** Archive ar (format des paquets .deb). */
function ar(files, mtime = Math.floor(Date.now() / 1000)) {
  const chunks = [Buffer.from('!<arch>\n', 'ascii')];
  for (const { name, data } of files) {
    const h = Buffer.alloc(60, 0x20);
    h.write(name.padEnd(16), 0, 16, 'ascii');
    h.write(String(mtime).padEnd(12), 16, 12, 'ascii');
    h.write('0'.padEnd(6), 28, 6, 'ascii');
    h.write('0'.padEnd(6), 34, 6, 'ascii');
    h.write('100644'.padEnd(8), 40, 8, 'ascii');
    h.write(String(data.length).padEnd(10), 48, 10, 'ascii');
    h.write('`\n', 58, 2, 'ascii');
    chunks.push(h, data);
    if (data.length % 2) chunks.push(Buffer.from('\n'));
  }
  return Buffer.concat(chunks);
}

/** Tous les fichiers et dossiers sous `dir`, en chemins relatifs avec des « / ». */
function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      out.push({ rel, full, dir: true });
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push({ rel, full, dir: false, size: fs.statSync(full).size });
    }
  }
  return out;
}

module.exports = { tar, ar, walk };
