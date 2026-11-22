# Jellyfin Desktop

Application de bureau Windows (Electron) pour Jellyfin. Elle charge le **client web officiel servi par votre
serveur** (`http(s)://serveur/web/`) : toutes les fonctionnalités de la version web sont disponibles et suivent les
mises à jour du serveur (bibliothèques, lecture, sous-titres, SyncPlay, Live TV, profils, administration, plugins…).

L'intégration passe par `window.NativeShell`, l'interface officielle des applications Jellyfin (comme Jellyfin
Media Player).

## Fonctionnalités bureau

- **Lecteur vidéo mpv intégré** : les vidéos s'ouvrent dans mpv, directement dans la fenêtre de l'application.
  Lecture directe de presque tous les formats (HEVC, AV1, DTS, TrueHD, sous-titres ASS/PGS…) sans conversion par le
  serveur. Pistes audio et sous-titres choisis dans Jellyfin, progression synchronisée, épisode suivant enchaîné.
  Raccourcis : `F` / double-clic plein écran, `Échap` quitter le plein écran ou arrêter, `Q` arrêter, `<` `>`
  précédent / suivant, plus les raccourcis habituels de mpv. La musique reste lue par le lecteur intégré.
- **Barre des tâches** : boutons ⏮ ⏯ ⏭ dans l'aperçu de la fenêtre et barre de progression de la lecture.
- **Icône de la zone de notification** : clic pour afficher/masquer ; clic droit pour le titre en cours,
  lecture/pause, précédent, suivant, arrêter, la liste des serveurs, les paramètres et quitter.
- **Reconnexion automatique** : si le serveur est injoignable (NAS éteint ou en démarrage), l'application réessaie
  toutes les 10 secondes et recharge Jellyfin dès qu'il répond.
- **Discord Rich Presence** : « Regarde… » / « Écoute… » avec le temps restant (à activer dans les paramètres,
  avec votre propre Application ID Discord).
- **Mises à jour automatiques** depuis les versions publiées sur GitHub (version installée).
- Écran de connexion avec découverte automatique des serveurs du réseau local, certificats HTTPS auto-signés
  (empreinte vérifiée et mémorisée), lecture qui continue en arrière-plan, touches multimédia du clavier, plein écran
  `F11`, zoom, taille de fenêtre mémorisée, instance unique.

Paramètres : `Ctrl+,`, menu **Jellyfin → Paramètres…** ou clic droit sur l'icône.

## Développement

```bash
npm install
npm run fetch-mpv
npm start
```

`fetch-mpv` télécharge une version épinglée de mpv (build [shinchiro](https://github.com/shinchiro/mpv-winbuild-cmake))
dans `vendor/mpv` (non versionné).

## Créer l'installateur Windows

```bash
npm run dist
```

Les fichiers (`.exe` installateur NSIS + version portable) sont générés dans `dist/`. Seule la version installée se
met à jour automatiquement ; la version portable signale les nouvelles versions.

## Publier une version

1. Augmenter `version` dans `package.json`.
2. `GH_TOKEN=<jeton> npm run release` : construit et publie la version sur GitHub (brouillon à valider).

## Structure

| Fichier | Rôle |
| --- | --- |
| `src/main.js` | Fenêtre, menus, icône, paramètres, IPC |
| `src/inject.js` | Code injecté dans le client web : `NativeShell`, plugin hôte, lecteur mpv |
| `src/preload.js` | Pont sécurisé entre les pages et le processus principal |
| `src/mpv.js` | Pilotage de mpv (IPC JSON, intégration `--wid`) |
| `src/playback.js` | État de lecture, boutons et progression de la barre des tâches |
| `src/servers.js` | Serveurs, découverte, certificats auto-signés |
| `src/discord.js` | Discord Rich Presence (IPC local) |
| `src/updater.js` | Mises à jour automatiques |
| `mpv-config/` | Configuration, raccourcis et script d'intégration de mpv |
