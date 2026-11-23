// Lancé avec Electron : fabrique assets/icon.ico (plusieurs tailles, images PNG dans l'ICO).
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  const src = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png'));
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((s) => src.resize({ width: s, height: s, quality: 'best' }).toPNG());
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + dir.length;
  sizes.forEach((s, i) => {
    const o = i * 16;
    dir.writeUInt8(s >= 256 ? 0 : s, o);
    dir.writeUInt8(s >= 256 ? 0 : s, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(pngs[i].length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += pngs[i].length;
  });
  fs.writeFileSync(path.join(__dirname, '..', 'assets', 'icon.ico'), Buffer.concat([header, dir, ...pngs]));
  console.log('icon.ico créé.');
  app.quit();
});
