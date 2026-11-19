# Architecture technique — AFTER MOTION AI

## Vue d'ensemble

```
┌────────────────────────────── Navigateur / PWA (Android, Windows, Web) ─────────────────────────────┐
│                                                                                                     │
│  apps/editor  (React)                                                                               │
│  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌──────────────┐ ┌──────────┐ ┌────────────┐               │
│  │ Toolbar  │ │  Viewer   │ │ Timeline │ │ Propriétés   │ │ Assistant│ │ Export     │  UI           │
│  │ Médias   │ │ (canvas + │ │ multi-   │ │ effets,      │ │ IA       │ │ (WebCodecs)│               │
│  │ Effets   │ │  poignées)│ │ pistes   │ │ masques…     │ │          │ │            │               │
│  └────┬─────┘ └─────┬─────┘ └────┬─────┘ └──────┬───────┘ └────┬─────┘ └─────┬──────┘               │
│       └─────────────┴────────────┴──────┬───────┴──────────────┘             │                      │
│                                         ▼                                    │                      │
│   EditorApp (orchestration) ── MediaManager (IndexedDB, <video>, décodage) ──┤                      │
│        │            │                                                        │                      │
│        │            └── Autosave / récupération (IndexedDB)                  │                      │
│        ▼                                                                     ▼                      │
│  ┌───────────────────────┐   ┌─────────────────────────┐   ┌──────────────────────────────┐        │
│  │ @amai/core            │   │ @amai/renderer          │   │ @amai/ai                     │        │
│  │ • modèle de projet    │◄──┤ • rendu Canvas 2D       │   │ • planificateur local FR/EN  │        │
│  │ • animation/keyframes │   │ • effets (registre)     │   │ • exécuteur de plans         │        │
│  │ • easing / Bézier     │   │ • masques, motion blur  │   │ • agent Claude (tool use)    │        │
│  │ • store + undo/redo   │   │ • particules, texte     │   └──────────────┬───────────────┘        │
│  │ • EditorEngine (API)  │   │ • caméra, transitions   │                  │ appelle les MÊMES      │
│  │ • catalogue d'OUTILS  │◄──────────────────────────────────────────────┘ outils que le MCP      │
│  └──────────▲────────────┘                                                                         │
│             │ executeTool()                                                                        │
│  ┌──────────┴────────────┐                                                                         │
│  │ @amai/bridge (client) │  WebSocket ws://127.0.0.1:7823/bridge  (jeton + origine vérifiés)       │
│  └──────────┬────────────┘                                                                         │
└─────────────┼───────────────────────────────────────────────────────────────────────────────────────┘
              │
┌─────────────▼──────────────── Node.js (local) ────────────────┐       ┌────────────────────────────┐
│ @amai/mcp-server                                              │ stdio │ Claude Desktop, Claude     │
│ • serveur MCP officiel (@modelcontextprotocol/sdk)            │◄─────►│ Code, autres clients MCP   │
│ • transport stdio + Streamable HTTP (/mcp, jeton Bearer)      │ HTTP  │                            │
│ • pont WebSocket vers l'éditeur, demandes d'autorisation      │       └────────────────────────────┘
│ • lecture de fichiers locaux (import), écriture des exports   │
│ • sert l'éditeur compilé (http://127.0.0.1:7823/)             │
│ • mode --headless (moteur en mémoire, sans rendu)             │
└───────────────────────────────────────────────────────────────┘
```

## Modules

| Module | Rôle | Dépendances |
|---|---|---|
| `packages/core` | Modèle de données (JSON pur), évaluation des animations, easing (Bézier cubique, bounce, elastic, back), store avec historique par patches immer, **EditorEngine** (API interne unique), presets d'animation, registre d'effets, **catalogue d'outils** (schémas zod → JSON Schema), sérialisation/validation des fichiers projet. | immer, zod |
| `packages/renderer` | Moteur de rendu Canvas 2D indépendant de l'UI : calques, parentage, caméra 2D, transitions, effets (registre extensible), masques avec contour progressif, motion blur par sur-échantillonnage temporel, particules déterministes, texte animé lettre par lettre, compositions imbriquées. | core |
| `packages/ai` | Connecteur IA : planificateur local hors-ligne (FR/EN), exécuteur de plans transactionnel, agent Claude (Messages API + tool use) qui reçoit le même catalogue d'outils que le MCP. | core, @anthropic-ai/sdk |
| `packages/bridge` | Protocole et client du pont éditeur ↔ serveur MCP (fonctionne dans le navigateur et dans Node ≥ 22). | core |
| `packages/mcp-server` | Serveur MCP (SDK officiel), pont WebSocket, autorisations, système de fichiers, mode headless, service de l'éditeur. | core, bridge, @modelcontextprotocol/sdk, ws |
| `apps/editor` | Interface React : vue, timeline, propriétés, bibliothèques, assistant, historique, MCP, export, sauvegarde, PWA. | tous |

## Principes

### Une seule API interne
Toute modification du projet passe par `EditorEngine` (`packages/core/src/engine.ts`). L'interface,
l'assistant IA et le serveur MCP n'ont **aucun** accès direct aux données : ils appellent les mêmes
méthodes. Le catalogue `TOOLS` (`packages/core/src/tools.ts`) décrit ces opérations (nom, description,
schéma de paramètres, caractère sensible) ; il est exposé tel quel au MCP et à Claude.

### Historique et annulation
`ProjectStore` produit, pour chaque transaction, des patches et patches inverses (immer).
* une action utilisateur, une réponse de l'IA ou un appel d'outil MCP = **une** entrée d'historique ;
* chaque entrée porte sa source (`user`, `ai`, `mcp`) et s'affiche dans le panneau Historique ;
* un groupe (`store.batch`) n'absorbe que les modifications de sa propre source : une retouche
  manuelle pendant que l'IA travaille reste annulable séparément ;
* si une étape d'un plan IA échoue, tout le plan est annulé (atomicité).

### Temps et animation
Temps en secondes (composition). `evaluate(prop, t)` interpole entre keyframes (recherche
dichotomique), l'easing de la keyframe de gauche s'appliquant au segment. Nombres et couleurs
(interpolation RVB + alpha) sont animables.

### Rendu
* Matrice locale = `T(position) · R(rotation) · S(échelle) · T(-origine)`, composée avec les parents
  puis la caméra (`T(centre) · S(zoom) · R(-rot) · T(-point visé)`).
* Calques « simples » dessinés directement ; calques avec effets/masques/motion blur/transitions de
  flou ou volet rendus dans un canvas intermédiaire (pool réutilisé) puis composités (opacité, mode de fusion).
* Motion blur : N échantillons dans l'angle d'obturateur, accumulation additive pondérée
  (moyenne exacte en espace prémultiplié).
* Particules : état calculé analytiquement depuis l'instant de naissance (graine + index) →
  rendu identique en lecture, en scrubbing et à l'export.
* Prévisualisation à qualité adaptative (réduction automatique de la résolution pendant la lecture
  si une image dépasse ~28 ms) — utile sur les appareils Android modestes.

### Médias
Les fichiers importés sont stockés en `Blob` dans IndexedDB (`idb:<assetId>`), jamais en mémoire
JavaScript permanente. Les vidéos sont décodées par des éléments `<video>` : lecture native
synchronisée en prévisualisation, positionnement exact (seek + attente `seeked`) à l'export.
`MediaManager.gc()` libère URL objets et éléments des médias supprimés.

### Export
Rendu image par image (indépendant du temps réel) → `VideoFrame` → `VideoEncoder` (WebCodecs) →
`mp4-muxer` (H.264) ou `webm-muxer` (VP9/VP8). Audio mixé hors-ligne (`OfflineAudioContext`, volumes
animés, fondus de transition) puis `AudioEncoder` (AAC si disponible, sinon Opus). Gestion de la
contre-pression de l'encodeur, annulation, réduction de résolution si l'encodeur H.264 l'exige.

### Sauvegarde et récupération
* sauvegarde automatique du projet dans IndexedDB après chaque modification (délai réglable) ;
* une version de récupération toutes les 30 s d'édition (10 dernières conservées) ;
* marqueur de session : si l'application n'a pas été fermée proprement, le projet est rouvert depuis
  la dernière sauvegarde et un bandeau propose les versions antérieures ;
* export/import de fichiers `.amai.json` (médias embarqués en base64).

## Extensibilité

**Ajouter un effet** :
1. `registerEffect({ type, label, category, description, params })` dans `packages/core/src/effects.ts` ;
2. `registerEffectRenderer(type, (rc) => { … })` dans `packages/renderer/src/effects.ts`.

L'effet apparaît alors automatiquement dans le panneau Effets, les propriétés (paramètres animables),
l'outil MCP `apply_effect`, et l'assistant Claude.

**Ajouter un preset d'animation** : ajouter une entrée à `PRESETS` (`packages/core/src/presets.ts`).

**Ajouter un outil (MCP + IA)** : ajouter une entrée à `TOOLS` (`packages/core/src/tools.ts`) avec son
schéma zod et sa fonction `run` qui appelle `EditorEngine`.

**Ajouter un type de calque** : étendre `LayerType`, `defaultProps` (factory) et `Renderer.drawContent`.
