const $ = (id) => document.getElementById(id);
const show = (cls, text) => {
  $('msg').innerHTML = `<span class="${cls}"></span>`;
  $('msg').firstChild.textContent = text;
};

window.cube.on('init', (data) => {
  $('url').value = data.settings.server.url || '';
  if (data.hotkey) $('hotkey').textContent = data.hotkey;
  if (data.hasKey) $('key').placeholder = '•••••••• (déjà enregistrée)';
});

async function test() {
  show('', 'Test…');
  const r = await window.cube.invoke('server:test', { url: $('url').value, key: $('key').value.trim() });
  if (r.ok) show('ok', `Ça marche ! Open WebUI ${r.version}, compte ${r.user}, ${r.models.length} modèle(s) : ${r.models.slice(0, 4).join(', ')}`);
  else show('err', r.error);
  return r;
}

$('test').onclick = test;
$('save').onclick = async () => {
  if (!$('url').value.trim()) return show('err', 'Indique l\'adresse de ton Open WebUI.');
  const r = await test();
  if (!r.ok) return;
  await window.cube.invoke('server:save', { url: $('url').value, key: $('key').value.trim() || null });
  show('ok', 'Connecté ! Tes conversations récentes vont apparaître dans le widget.');
  $('save').textContent = 'Ouvrir le Hub';
  $('later').hidden = true;
  $('save').onclick = () => {
    window.cube.send('open-hub', {});
    window.cube.send('welcome:close');
  };
};
$('later').onclick = () => window.cube.send('welcome:close');
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('key').focus(); });
$('key').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save').click(); });
