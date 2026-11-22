const api = window.jellyfinDesktop;
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const DELAY = 10;
const CIRC = 194.8;

$('title').textContent = `${params.get('name') || 'Le serveur'} est injoignable`;
$('detail').textContent = params.get('reason') ? `${params.get('url')} — ${params.get('reason')}` : params.get('url') || '';

function plural(n, word) {
  return `${n} ${word}${n > 1 ? 's' : ''}`;
}

api.onOfflineStatus((s) => {
  const bar = $('bar');
  if (s.checking) {
    $('status').textContent = 'Connexion en cours…';
    $('count').textContent = '';
    bar.parentElement.classList.add('spin');
    bar.style.strokeDashoffset = String(CIRC * 0.7);
    $('retry').disabled = true;
    return;
  }
  bar.parentElement.classList.remove('spin');
  $('retry').disabled = false;
  const left = Math.max(0, s.nextRetryIn || 0);
  $('count').textContent = String(left);
  bar.style.strokeDashoffset = String(CIRC * (1 - left / DELAY));
  const tries = s.attempt ? ` (${plural(s.attempt, 'tentative')})` : '';
  $('status').textContent = `Nouvelle tentative dans ${plural(left, 'seconde')}${tries}.`;
  if (s.error) $('detail').textContent = `${params.get('url')} — ${s.error}`;
});

$('retry').addEventListener('click', () => api.retryNow());
$('change').addEventListener('click', () => api.showConnect());
