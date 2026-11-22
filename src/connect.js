const api = window.jellyfinDesktop;
const $ = (id) => document.getElementById(id);

const errorBox = $('error');
const savedSection = $('saved-section');
const savedList = $('saved');
const foundList = $('found');
const form = $('form');
const input = $('address');
const submit = $('submit');

let busy = false;

function showError(msg) {
  errorBox.textContent = msg || '';
  errorBox.hidden = !msg;
}

function serverRow(server, { onRemove } = {}) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'server';

  const info = document.createElement('div');
  info.className = 'info';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = server.name || server.url;
  const url = document.createElement('div');
  url.className = 'url';
  url.textContent = server.version ? `${server.url} · v${server.version}` : server.url;
  info.append(name, url);
  row.append(info);

  if (onRemove) {
    const rm = document.createElement('span');
    rm.className = 'remove';
    rm.title = 'Oublier ce serveur';
    rm.setAttribute('role', 'button');
    rm.textContent = '×';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove(server);
    });
    row.append(rm);
  }

  row.addEventListener('click', () => connect(server.url));
  return row;
}

async function renderSaved() {
  const { servers } = await api.listServers();
  savedList.replaceChildren(...servers.map((s) => serverRow(s, {
    onRemove: async (srv) => {
      await api.remove(srv.url);
      renderSaved();
    },
  })));
  savedSection.hidden = servers.length === 0;
}

async function scan() {
  const spinner = document.createElement('div');
  spinner.className = 'empty';
  spinner.innerHTML = '<span class="spinner"></span>&nbsp; Recherche de serveurs…';
  foundList.replaceChildren(spinner);

  const servers = await api.discover();
  if (servers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Aucun serveur détecté. Saisissez son adresse ci-dessous.';
    foundList.replaceChildren(empty);
  } else {
    foundList.replaceChildren(...servers.map((s) => serverRow(s)));
  }
}

const certBox = $('cert');
let pendingCert = null;

function showCert(cert, address) {
  pendingCert = cert ? { cert, address } : null;
  certBox.hidden = !cert;
  if (!cert) return;
  $('cert-host').textContent = cert.host;
  $('cert-subject').textContent = (cert.subject && cert.subject.commonName) || cert.host;
  $('cert-issuer').textContent = (cert.issuer && cert.issuer.commonName) || '—';
  $('cert-expiry').textContent = cert.validExpiry
    ? new Date(cert.validExpiry * 1000).toLocaleDateString('fr-FR', { dateStyle: 'long' }) : '—';
  $('cert-fp').textContent = cert.fingerprint;
  $('cert-trust').focus();
}

$('cert-cancel').addEventListener('click', () => showCert(null));
$('cert-trust').addEventListener('click', async () => {
  if (!pendingCert) return;
  const { cert, address } = pendingCert;
  showCert(null);
  const ok = await api.trust(cert.host, cert.fingerprint);
  if (!ok) {
    showError('Impossible d\'enregistrer ce certificat. Réessayez la connexion.');
    return;
  }
  connect(address);
});

async function connect(address) {
  if (busy) return;
  busy = true;
  showError('');
  showCert(null);
  submit.disabled = true;
  submit.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await api.connect(address);
    if (!res.ok && res.certificate) showCert(res.certificate, address);
    else if (!res.ok) showError(res.error);
  } finally {
    busy = false;
    submit.disabled = false;
    submit.textContent = 'Connexion';
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  connect(input.value);
});
$('rescan').addEventListener('click', scan);

const initialError = new URLSearchParams(location.search).get('error');
if (initialError) showError(initialError);

renderSaved();
scan();
input.focus();
