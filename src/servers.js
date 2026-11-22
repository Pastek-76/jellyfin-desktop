// Serveurs Jellyfin : normalisation d'adresse, sonde /System/Info/Public, découverte
// réseau, mémorisation, et confiance dans les certificats HTTPS auto-signés.
const { app } = require('electron');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const dgram = require('dgram');
const store = require('./store');

// ---------------------------------------------------------------- certificats auto-signés
// Un certificat non reconnu n'est accepté que si l'utilisateur l'a approuvé :
// on mémorise son empreinte SHA-256 par nom d'hôte. Si le certificat change,
// une nouvelle confirmation est demandée.

const rejectedCerts = new Map(); // hôte → détails du dernier certificat refusé

// Même format que Certificate.fingerprint d'Electron : SHA-256 du certificat DER, en base64.
function fingerprintOf(der) {
  return 'sha256/' + crypto.createHash('sha256').update(der).digest('base64');
}

function isTrusted(host, fingerprint) {
  return store.get('trustedCerts', {})[host] === fingerprint;
}

function trustCertificate(host, fingerprint) {
  const pending = rejectedCerts.get(host);
  if (!pending || pending.fingerprint !== fingerprint) return false;
  store.set('trustedCerts', { ...store.get('trustedCerts', {}), [host]: fingerprint });
  rejectedCerts.delete(host);
  return true;
}

// Fenêtre (pages, images, flux vidéo, WebSocket) : accepte les certificats approuvés.
app.on('certificate-error', (event, _wc, url, error, certificate, callback) => {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* URL invalide */ }
  if (host && isTrusted(host, certificate.fingerprint)) {
    event.preventDefault();
    callback(true);
    return;
  }
  rejectedCerts.set(host, {
    host,
    fingerprint: certificate.fingerprint,
    subject: certificate.subjectName,
    issuer: certificate.issuerName,
    validExpiry: certificate.validExpiry,
    reason: error,
  });
  callback(false);
});

// ---------------------------------------------------------------- sonde

function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Veuillez saisir une adresse de serveur.');
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  const u = new URL(s);
  const p = u.pathname.replace(/\/web(\/.*)?$/i, '').replace(/\/+$/, '');
  return u.origin + p;
}

// Interroge /System/Info/Public. En HTTPS, un certificat non reconnu n'est accepté
// que si son empreinte a été approuvée ; sinon l'erreur porte ses détails.
function probe(url, { timeout = 6000, redirects = 3 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url + '/System/Info/Public');
    const secure = target.protocol === 'https:';
    const req = (secure ? https : http).get(target, {
      headers: { Accept: 'application/json' },
      timeout,
      rejectUnauthorized: false,
    }, (res) => {
      if (secure && !res.socket.authorized) {
        const peer = res.socket.getPeerCertificate();
        const fingerprint = fingerprintOf(peer.raw);
        if (!isTrusted(target.hostname, fingerprint)) {
          res.destroy();
          const cert = {
            host: target.hostname,
            fingerprint,
            subject: { commonName: peer.subject && peer.subject.CN },
            issuer: { commonName: peer.issuer && peer.issuer.CN },
            validExpiry: Math.floor(Date.parse(peer.valid_to) / 1000),
            reason: res.socket.authorizationError,
          };
          rejectedCerts.set(target.hostname, cert);
          const err = new Error(`Le certificat HTTPS de ${target.hostname} n'est pas reconnu (${cert.reason}).`);
          err.certificate = cert;
          reject(err);
          return;
        }
      }
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        const next = new URL(res.headers.location, target).href.replace(/\/System\/Info\/Public.*$/i, '');
        probe(next, { timeout, redirects: redirects - 1 }).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Réponse HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        try {
          const info = JSON.parse(body);
          if (!info.Id) throw new Error();
          resolve({ url, name: info.ServerName || url, version: info.Version || '', id: info.Id });
        } catch {
          reject(new Error('Ce n\'est pas un serveur Jellyfin.'));
        }
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('Le serveur ne répond pas.'), { name: 'TimeoutError' })));
    req.on('error', reject);
  });
}

// Essaie l'adresse telle quelle, puis avec le port par défaut 8096 si aucun port n'est donné.
async function testServer(input) {
  const url = normalizeUrl(input);
  const candidates = [url];
  const u = new URL(url);
  if (!u.port && u.protocol === 'http:') {
    u.port = '8096';
    candidates.push(u.origin + u.pathname.replace(/\/+$/, ''));
  }
  let lastErr;
  for (const c of candidates) {
    try {
      return await probe(c);
    } catch (err) {
      if (err.certificate) throw err;
      lastErr = err;
    }
  }
  const msg = lastErr && lastErr.name === 'TimeoutError' ? 'Le serveur ne répond pas.' : (lastErr && lastErr.message) || 'Erreur inconnue';
  throw new Error(`Impossible de joindre ${url} — ${msg}`);
}

// ---------------------------------------------------------------- liste mémorisée

function list() {
  return store.get('servers', []);
}

function current() {
  return store.get('currentServer', null);
}

function currentServer() {
  const url = current();
  return list().find((s) => s.url === url) || (url ? { url, name: url } : null);
}

function remember(server) {
  const servers = list().filter((s) => s.id !== server.id && s.url !== server.url);
  servers.unshift({ ...server, lastUsed: Date.now() });
  store.set('servers', servers);
  store.set('currentServer', server.url);
}

function select(url) {
  const server = list().find((s) => s.url === url);
  if (!server) return null;
  remember(server);
  return server;
}

function forget(url) {
  try {
    const host = new URL(url).hostname;
    const others = list().some((s) => s.url !== url && new URL(s.url).hostname === host);
    if (!others) {
      const trusted = { ...store.get('trustedCerts', {}) };
      delete trusted[host];
      store.set('trustedCerts', trusted);
    }
  } catch { /* adresse invalide */ }
  store.set('servers', list().filter((s) => s.url !== url));
  if (current() === url) store.set('currentServer', null);
  return list();
}

// ---------------------------------------------------------------- découverte (UDP 7359)

function discover(timeout = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    let done = false;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      if (done) return;
      done = true;
      try { sock.close(); } catch { /* déjà fermé */ }
      resolve([...found.values()]);
    };
    sock.on('error', finish);
    sock.on('message', (msg) => {
      try {
        const d = JSON.parse(msg.toString());
        if (d.Address) {
          found.set(d.Id || d.Address, { id: d.Id, name: d.Name || d.Address, url: d.Address.replace(/\/+$/, '') });
        }
      } catch { /* réponse invalide ignorée */ }
    });
    sock.bind(0, () => {
      try {
        sock.setBroadcast(true);
        sock.send(Buffer.from('Who is JellyfinServer?'), 7359, '255.255.255.255');
      } catch {
        finish();
        return;
      }
      setTimeout(finish, timeout);
    });
  });
}

module.exports = {
  normalizeUrl, probe, testServer, discover, trustCertificate,
  list, current, currentServer, remember, select, forget,
};
