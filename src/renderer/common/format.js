export const LONG = { working: 'écrit…', waiting: 'erreur', done: 'réponse prête' };
export const SHORT = { working: 'écrit', waiting: 'erreur', done: 'prête' };

/** "à l'instant", "il y a 5 min", "il y a 2 h", "il y a 3 j". */
export function ago(when, now = Date.now()) {
  const m = Math.max(0, Math.floor((now - Date.parse(when)) / 60000));
  if (!Number.isFinite(m)) return '';
  if (m < 1) return "à l'instant";
  if (m < 60) return `il y a ${m} min`;
  if (m < 48 * 60) return `il y a ${Math.floor(m / 60)} h`;
  return `il y a ${Math.floor(m / 1440)} j`;
}

/** "12 min", "1 h 05". */
export function duration(since, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

/** "850 tokens", "210k tokens", "1,2M tokens". */
export function tokens(n) {
  if (!n) return '';
  if (n < 1000) return `${n} tokens`;
  if (n < 1_000_000) return `${Math.floor(n / 1000)}k tokens`;
  return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M tokens`;
}

export function escapeHTML(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
