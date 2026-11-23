// Copie les images du cube du projet original (../cube-hub) dans assets/.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const original = path.join(root, '..', 'cube-hub');
const copies = [
  ['Resources/Frames', 'assets/frames'],
  ['docs/icon.png', 'assets/icon.png'],
  ['LICENSE', 'assets/LICENSE-original.txt'],
];
for (const [from, to] of copies) {
  fs.cpSync(path.join(original, from), path.join(root, to), { recursive: true });
}
// Liste des images, lue par le rendu (pas d'accès au disque depuis la page).
const frames = {};
for (const size of ['card', 'menubar']) {
  frames[size] = {};
  for (const folder of ['Travail', 'Sommeil', 'Regard']) {
    const dir = path.join(root, 'assets/frames', size, folder);
    frames[size][folder] = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
  }
}
fs.writeFileSync(path.join(root, 'assets/frames/index.json'), JSON.stringify(frames, null, 2));
console.log('Images copiées.');
