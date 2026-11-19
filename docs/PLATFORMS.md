# Plateformes

## Aujourd'hui : application web progressive (PWA)

L'éditeur est une application web installable, fonctionnant hors-ligne grâce à un service worker
(`apps/editor/public/sw.js`) et au stockage local IndexedDB.

| Plateforme | Installation | État |
|---|---|---|
| Windows | Chrome ou Edge › *Installer AFTER MOTION AI* | Fonctionnalités dépendantes de Chromium (WebCodecs, `ctx.filter`) disponibles. Non testé sur une machine Windows réelle. |
| Android | Chrome › *Ajouter à l'écran d'accueil* | Mise en page mobile testée en viewport 390×844 (Chromium). Non testé sur un appareil Android réel. |
| Linux / macOS | Chrome, Edge, Chromium | Testé (Chromium sous Linux). |
| Safari / iOS | — | Non testé ; WebCodecs et `CanvasRenderingContext2D.filter` y sont partiels : l'export et certains effets peuvent être indisponibles. |

Le serveur MCP est un programme Node.js multiplateforme (Windows, macOS, Linux). Sur Android,
il n'y a pas de client MCP local : l'assistant IA intégré (local ou Claude) reste disponible.

## Optimisations pour appareils modestes

- prévisualisation à résolution automatique (pixels réellement affichés) ou forcée (1/2, 1/4) ;
- baisse automatique de la résolution pendant la lecture si une image dépasse ~28 ms ;
- motion blur désactivable dans l'aperçu (toujours appliqué à l'export) ;
- médias conservés en Blob dans IndexedDB, URL et éléments vidéo libérés quand inutilisés ;
- pool de canvas intermédiaires réutilisés (`Renderer.trimPool()` pour libérer la mémoire).

## Feuille de route vers des paquets natifs (non réalisée)

- **Android** : empaqueter `apps/editor/dist` avec Capacitor ; vérifier WebCodecs dans la WebView
  Android (Chrome ≥ 94) ; remplacer IndexedDB par le système de fichiers pour les gros médias.
- **Windows** : Tauri (WebView2 = Chromium, WebCodecs disponible) ou Electron ; le serveur MCP peut
  être lancé comme processus compagnon de l'application.
- **Rendu** : passage optionnel à WebGL/WebGPU pour les effets lourds (flous, lueurs) sur mobile.
