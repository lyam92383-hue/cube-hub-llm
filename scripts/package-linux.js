// Fabrique les paquets Linux de Cube Hub LLM : un .deb (Ubuntu, Debian) et un .tar.gz portable,
// pour amd64 et arm64. Marche depuis Windows comme depuis Linux (aucun outil Linux requis).
//   node scripts/package-linux.js [amd64|arm64 â€¦]
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { tar, ar, walk } = require('./archive');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const electronVersion = require('electron/package.json').version;
const checksums = require('electron/checksums.json');
const NAME = 'cube-hub-llm';
const DEPS = ['qrcode', 'dijkstrajs', 'pngjs'];
const ARCHES = { amd64: 'x64', arm64: 'arm64' };

const cacheDir = path.join(os.tmpdir(), 'cube-hub-llm-electron');
const outDir = path.join(root, 'dist', 'linux');

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`TÃ©lÃ©chargement impossible (${res.status}) : ${url}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

/** Electron pour Linux, tÃ©lÃ©chargÃ© depuis GitHub et vÃ©rifiÃ© avec les empreintes du paquet npm. */
async function electronZip(arch) {
  const file = `electron-v${electronVersion}-linux-${arch}.zip`;
  const dest = path.join(cacheDir, file);
  fs.mkdirSync(cacheDir, { recursive: true });
  const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (!fs.existsSync(dest) || sha(dest) !== checksums[file]) {
    console.log(`TÃ©lÃ©chargement de ${file}â€¦`);
    await download(`https://github.com/electron/electron/releases/download/v${electronVersion}/${file}`, dest);
  }
  if (sha(dest) !== checksums[file]) throw new Error(`Empreinte incorrecte pour ${file}`);
  return dest;
}

function unzip(zip, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    execFileSync('unzip', ['-q', zip, '-d', dir], { stdio: 'ignore' });
  } catch {
    execFileSync('tar', ['-xf', zip, '-C', dir]); // bsdtar (Windows, macOS) lit les .zip
  }
}

const isExec = (rel) => rel === NAME || rel === 'chrome_crashpad_handler' || /\.so(\.\d+)*$/.test(rel);

async function build(debArch) {
  const arch = ARCHES[debArch];
  const stage = path.join(os.tmpdir(), `cube-hub-llm-stage-${arch}`);
  unzip(await electronZip(arch), stage);
  fs.renameSync(path.join(stage, 'electron'), path.join(stage, NAME));
  fs.rmSync(path.join(stage, 'resources', 'default_app.asar'), { force: true });

  // L'app elle-mÃªme.
  const app = path.join(stage, 'resources', 'app');
  fs.mkdirSync(app, { recursive: true });
  const appPkg = { name: pkg.name, productName: pkg.productName, version: pkg.version, main: pkg.main, license: pkg.license };
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(appPkg, null, 2));
  for (const dir of ['src', 'assets']) {
    fs.cpSync(path.join(root, dir), path.join(app, dir), { recursive: true, filter: (s) => !s.endsWith('.ico') });
  }
  for (const dep of DEPS) fs.cpSync(path.join(root, 'node_modules', dep), path.join(app, 'node_modules', dep), { recursive: true });

  const files = walk(stage);
  const optEntries = files.map((f) => {
    if (f.dir) return { name: f.rel, dir: true, mode: 0o755 };
    const mode = f.rel === 'chrome-sandbox' ? 0o4755 : isExec(f.rel) ? 0o755 : 0o644;
    return { name: f.rel, file: f.full, mode };
  });

  fs.mkdirSync(outDir, { recursive: true });

  // ---- .tar.gz portable : cube-hub-llm-1.0.0-linux-x64/â€¦
  const top = `${NAME}-${pkg.version}-linux-${arch}`;
  const portable = tar([{ name: top, dir: true }, ...optEntries.map((e) => ({ ...e, name: `${top}/${e.name}` }))]);
  const tgz = path.join(outDir, `${top}.tar.gz`);
  fs.writeFileSync(tgz, zlib.gzipSync(portable, { level: 9 }));

  // ---- .deb
  const icon = fs.readFileSync(path.join(root, 'assets', 'icon.png'));
  const desktop = [
    '[Desktop Entry]',
    'Name=Cube Hub LLM',
    'Comment=Les conversations de ton IA locale (Open WebUI + Ollama), avec le cube',
    `Exec=/opt/${NAME}/${NAME} %U`,
    `Icon=${NAME}`,
    'Terminal=false',
    'Type=Application',
    'Categories=Utility;Network;Chat;',
    `StartupWMClass=${pkg.productName}`,
    '',
  ].join('\n');
  const copyright = [
    'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/',
    'Upstream-Name: Cube Hub LLM',
    '',
    'Files: *',
    'License: MIT',
    ' AdaptÃ© de Cube Hub (https://github.com/Harlo9/cube-hub), licence MIT.',
    ' Electron : licence MIT, voir /opt/cube-hub-llm/LICENSE et LICENSES.chromium.html.',
    '',
  ].join('\n');
  const dataEntries = [
    { name: './', dir: true },
    { name: './opt', dir: true },
    { name: `./opt/${NAME}`, dir: true },
    ...optEntries.map((e) => ({ ...e, name: `./opt/${NAME}/${e.name}` })),
    { name: './usr', dir: true },
    { name: './usr/bin', dir: true },
    { name: `./usr/bin/${NAME}`, symlink: `/opt/${NAME}/${NAME}` },
    { name: './usr/share', dir: true },
    { name: './usr/share/applications', dir: true },
    { name: `./usr/share/applications/${NAME}.desktop`, data: Buffer.from(desktop) },
    { name: './usr/share/icons', dir: true },
    { name: './usr/share/icons/hicolor', dir: true },
    { name: './usr/share/icons/hicolor/256x256', dir: true },
    { name: './usr/share/icons/hicolor/256x256/apps', dir: true },
    { name: `./usr/share/icons/hicolor/256x256/apps/${NAME}.png`, data: icon },
    { name: './usr/share/doc', dir: true },
    { name: `./usr/share/doc/${NAME}`, dir: true },
    { name: `./usr/share/doc/${NAME}/copyright`, data: Buffer.from(copyright) },
  ];
  const md5 = dataEntries
    .filter((e) => !e.dir && !e.symlink)
    .map((e) => `${crypto.createHash('md5').update(e.data ?? fs.readFileSync(e.file)).digest('hex')}  ${e.name.slice(2)}`)
    .join('\n') + '\n';
  const installedKB = Math.ceil(dataEntries.reduce((n, e) => n + (e.data?.length ?? (e.file ? fs.statSync(e.file).size : 0)), 0) / 1024);

  const control = [
    `Package: ${NAME}`,
    `Version: ${pkg.version}`,
    `Architecture: ${debArch}`,
    'Maintainer: Cube Hub LLM <noreply@example.invalid>',
    `Installed-Size: ${installedKB}`,
    'Depends: libgtk-3-0t64 | libgtk-3-0, libnss3, libnotify4, libxss1, libxtst6, xdg-utils, libatspi2.0-0t64 | libatspi2.0-0, libuuid1, libsecret-1-0, libgbm1, libasound2t64 | libasound2, libdrm2',
    'Recommends: gnome-shell-extension-appindicator | libappindicator3-1 | libayatana-appindicator3-1',
    'Section: utils',
    'Priority: optional',
    'Homepage: https://github.com/Harlo9/cube-hub',
    'Description: Le cube de Cube Hub pour ton IA locale (Open WebUI + Ollama)',
    ' Un widget toujours visible avec un cube animÃ© : bleu quand ton IA Ã©crit,',
    ' vert quand la rÃ©ponse est prÃªte. Le Hub range tes conversations Open WebUI',
    ' par dossiers et permet de les lire et de les continuer. Notifications du',
    ' systÃ¨me et Telegram en option.',
    '',
  ].join('\n');
  const postinst = `#!/bin/sh
set -e
# Bac Ã  sable de Chromium : doit appartenir Ã  root avec le bit setuid.
chown root:root /opt/${NAME}/chrome-sandbox 2>/dev/null || true
chmod 4755 /opt/${NAME}/chrome-sandbox 2>/dev/null || true
# Ubuntu 24.04 et plus : AppArmor bloque les apps Electron sans profil.
if [ -f /etc/apparmor.d/abi/4.0 ]; then
  cat > /etc/apparmor.d/${NAME} <<'EOF'
abi <abi/4.0>,
include <tunables/global>

profile ${NAME} /opt/${NAME}/${NAME} flags=(unconfined) {
  userns,
  include if exists <local/${NAME}>
}
EOF
  if command -v apparmor_parser >/dev/null 2>&1; then
    apparmor_parser --replace --write-cache --skip-read-cache /etc/apparmor.d/${NAME} >/dev/null 2>&1 || true
  fi
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
exit 0
`;
  const postrm = `#!/bin/sh
set -e
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  if [ -f /etc/apparmor.d/${NAME} ]; then
    command -v apparmor_parser >/dev/null 2>&1 && apparmor_parser --remove /etc/apparmor.d/${NAME} >/dev/null 2>&1 || true
    rm -f /etc/apparmor.d/${NAME}
  fi
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
fi
exit 0
`;
  const controlTar = tar([
    { name: './', dir: true },
    { name: './control', data: Buffer.from(control) },
    { name: './md5sums', data: Buffer.from(md5) },
    { name: './postinst', data: Buffer.from(postinst), mode: 0o755 },
    { name: './postrm', data: Buffer.from(postrm), mode: 0o755 },
  ]);
  const deb = ar([
    { name: 'debian-binary', data: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', data: zlib.gzipSync(controlTar, { level: 9 }) },
    { name: 'data.tar.gz', data: zlib.gzipSync(tar(dataEntries), { level: 9 }) },
  ]);
  const debFile = path.join(outDir, `${NAME}_${pkg.version}_${debArch}.deb`);
  fs.writeFileSync(debFile, deb);
  fs.rmSync(stage, { recursive: true, force: true });
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(0) + ' Mo';
  console.log(`${path.basename(debFile)} (${mb(debFile)}), ${path.basename(tgz)} (${mb(tgz)})`);
}

(async () => {
  const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ARCHES);
  for (const a of wanted) {
    if (!ARCHES[a]) throw new Error(`Architecture inconnue : ${a} (amd64 ou arm64)`);
    await build(a);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
