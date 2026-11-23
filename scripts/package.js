// Fabrique dist/Cube Hub LLM (dossier de l'app avec Cube Hub LLM.exe) à partir de l'Electron déjà
// installé dans node_modules : copie, renomme, met l'icône et les infos de version.
const fs = require('fs');
const path = require('path');
const ResEdit = require('resedit');
const PELibrary = require('pe-library');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const out = path.join(root, 'dist', 'Cube Hub LLM');

if (!fs.existsSync(path.join(electronDist, 'electron.exe'))) throw new Error('Electron n\'est pas installé dans node_modules.');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.cpSync(electronDist, out, { recursive: true });
fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });
const exe = path.join(out, 'Cube Hub LLM.exe');
fs.renameSync(path.join(out, 'electron.exe'), exe);

// L'app elle-même dans resources/app.
const app = path.join(out, 'resources', 'app');
fs.mkdirSync(app, { recursive: true });
const appPkg = { name: pkg.name, productName: pkg.productName, version: pkg.version, main: pkg.main, license: pkg.license };
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(appPkg, null, 2));
for (const dir of ['src', 'assets']) fs.cpSync(path.join(root, dir), path.join(app, dir), { recursive: true });
for (const dep of ['qrcode', 'dijkstrajs', 'pngjs']) {
  fs.cpSync(path.join(root, 'node_modules', dep), path.join(app, 'node_modules', dep), {
    recursive: true,
    filter: (src) => !src.endsWith('.pdb'),
  });
}

// Icône et informations de version de Cube Hub LLM.exe.
const data = fs.readFileSync(exe);
const pe = PELibrary.NtExecutable.from(data, { ignoreCert: true });
const res = PELibrary.NtExecutableResource.from(pe);
const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets', 'icon.ico')));
const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
const groupId = groups.length ? groups[0].id : 1;
const lang = groups.length ? groups[0].lang : 1033;
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, ico.icons.map((i) => i.data));
const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
for (const v of versions) {
  const [a, b, c] = pkg.version.split('.').map(Number);
  v.setFileVersion(a, b, c, 0, 1033);
  v.setProductVersion(a, b, c, 0, 1033);
  const langs = v.getAllLanguagesForStringValues();
  for (const l of langs) {
    v.setStringValues(l, {
      FileDescription: 'Cube Hub LLM',
      ProductName: 'Cube Hub LLM',
      CompanyName: 'Cube Hub LLM',
      InternalName: 'Cube Hub LLM',
      OriginalFilename: 'Cube Hub LLM.exe',
      LegalCopyright: 'MIT — adapté de github.com/Harlo9/cube-hub',
      FileVersion: pkg.version,
      ProductVersion: pkg.version,
    });
  }
  v.outputToResourceEntries(res.entries);
}
res.outputResource(pe);
fs.writeFileSync(exe, Buffer.from(pe.generate()));

console.log('App prête :', out);
