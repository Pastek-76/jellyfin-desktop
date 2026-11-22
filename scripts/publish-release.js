// Publie la version courante (package.json) sur GitHub avec le CLI gh :
// installateur, version portable, blockmap et latest.yml (flux des mises à jour).
// Usage : npm run release   (construit puis appelle ce script)
// Les fichiers sont envoyés avec des noms sans espaces, comme les attend electron-updater.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require('../package.json');
const version = pkg.version;
const tag = `v${version}`;
const pub = [].concat(pkg.build.publish)[0];
const repo = `${pub.owner}/${pub.repo}`;
const dist = path.join(root, 'dist');

const setupName = `${pkg.build.productName} Setup ${version}.exe`;
const portableName = `${pkg.build.productName} ${version}.exe`;
const dashed = (name) => name.replace(/ /g, '-');

for (const f of [setupName, `${setupName}.blockmap`, portableName]) {
  if (!fs.existsSync(path.join(dist, f))) throw new Error(`Fichier manquant : dist/${f} (lancez la construction d'abord)`);
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// Dossier temporaire avec les noms définitifs.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jfd-release-'));
const files = [];
for (const f of [setupName, `${setupName}.blockmap`, portableName]) {
  const dest = path.join(tmp, dashed(f));
  fs.copyFileSync(path.join(dist, f), dest);
  files.push(dest);
}

const setup = fs.readFileSync(path.join(tmp, dashed(setupName)));
const sha512 = crypto.createHash('sha512').update(setup).digest('base64');
const latest = [
  `version: ${version}`,
  'files:',
  `  - url: ${dashed(setupName)}`,
  `    sha512: ${sha512}`,
  `    size: ${setup.length}`,
  `path: ${dashed(setupName)}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n');
fs.writeFileSync(path.join(tmp, 'latest.yml'), latest);
files.push(path.join(tmp, 'latest.yml'));

let exists = true;
try { gh('release', 'view', tag, '--repo', repo); } catch { exists = false; }
if (!exists) {
  console.log(`Création de la release ${tag}`);
  gh('release', 'create', tag, '--repo', repo, '--target', 'main', '--title', `Jellyfin Desktop ${version}`, '--generate-notes');
}
console.log(`Envoi de ${files.length} fichiers vers ${repo} ${tag}`);
gh('release', 'upload', tag, ...files, '--repo', repo, '--clobber');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(gh('release', 'view', tag, '--repo', repo, '--json', 'url', '--jq', '.url').trim());
