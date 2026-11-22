// Télécharge mpv pour Windows (build shinchiro, version épinglée) dans vendor/mpv.
// Usage : npm run fetch-mpv
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const TAG = '20261111';
const ASSET = 'mpv-x86_64-20261111-git-bcde6b93cc.7z';
const URL_ = `https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/${TAG}/${ASSET}`;

const root = path.join(__dirname, '..');
const dest = path.join(root, 'vendor', 'mpv');
const tmp = path.join(root, 'vendor', '.download');

function download(url, file, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'jellyfin-desktop-build' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        download(res.headers.location, file, redirects - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} pour ${url}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      let done = 0;
      let last = 0;
      res.on('data', (chunk) => {
        done += chunk.length;
        const pct = total ? Math.floor((done / total) * 100) : 0;
        if (pct >= last + 10) { last = pct; process.stdout.write(`  ${pct} %\n`); }
      });
      const out = fs.createWriteStream(file);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  if (fs.existsSync(path.join(dest, 'mpv.exe'))) {
    console.log('mpv déjà présent dans vendor/mpv');
    return;
  }
  fs.mkdirSync(tmp, { recursive: true });
  const archive = path.join(tmp, ASSET);
  if (!fs.existsSync(archive)) {
    console.log(`Téléchargement de ${URL_}`);
    await download(URL_ + '', archive + '.part');
    fs.renameSync(archive + '.part', archive);
  }
  fs.rmSync(path.join(tmp, 'x'), { recursive: true, force: true });

  const sevenZip = require('7zip-bin').path7za;
  const extracted = path.join(tmp, 'x');
  execFileSync(sevenZip, ['x', archive, `-o${extracted}`, '-y'], { stdio: 'ignore' });
  if (!fs.existsSync(path.join(extracted, 'mpv.exe'))) throw new Error('mpv.exe introuvable dans l\'archive');

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  for (const name of ['mpv.exe', 'd3dcompiler_43.dll', 'vulkan-1.dll']) {
    const src = path.join(extracted, name);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, name));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('mpv installé dans vendor/mpv');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
