// Petit stockage persistant JSON dans le dossier userData de l'application.
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const file = path.join(app.getPath('userData'), 'config.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

let data = load();

function get(key, fallback) {
  return data[key] === undefined ? fallback : data[key];
}

function set(key, value) {
  data[key] = value;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Impossible d\'enregistrer la configuration :', err);
  }
}

module.exports = { get, set };
