# Serveur MCP — AFTER MOTION AI

Le serveur `@amai/mcp-server` implémente le **Model Context Protocol** avec le SDK officiel
(`@modelcontextprotocol/sdk`). Il permet à Claude Desktop, Claude Code ou tout client MCP de
**contrôler le projet réellement ouvert** dans l'éditeur.

## Fonctionnement

1. Le client MCP lance le serveur (transport **stdio**), ou s'y connecte en **Streamable HTTP** (`--http`).
2. Le serveur ouvre en local (127.0.0.1 uniquement) :
   * `ws://127.0.0.1:7823/bridge` — pont vers l'éditeur ;
   * `http://127.0.0.1:7823/` — l'éditeur compilé (si `npm run build` a été lancé) ;
   * `http://127.0.0.1:7823/mcp` — point d'accès MCP HTTP (avec `--http`).
3. L'éditeur ouvert à cette adresse s'appaire automatiquement (même origine). Depuis une autre
   origine (ex. `npm run dev`), collez le jeton dans **MCP › Jeton** (obtenu par `--print-token`).
4. Chaque appel d'outil est transmis à l'éditeur, exécuté par `EditorEngine` sur le projet ouvert,
   enregistré comme **une entrée d'historique « MCP »** annulable, et affiché dans le journal
   d'activité du panneau MCP.

## Configuration de Claude Desktop

`claude_desktop_config.json` (Windows : `%APPDATA%\Claude\`, macOS : `~/Library/Application Support/Claude/`) :

```json
{
  "mcpServers": {
    "after-motion-ai": {
      "command": "node",
      "args": ["C:\\chemin\\vers\\after-motion-ai\\packages\\mcp-server\\dist\\index.js"]
    }
  }
}
```

Redémarrez Claude Desktop, puis ouvrez `http://127.0.0.1:7823/` dans Chrome ou Edge. Demandez à
Claude : « Vérifie la connexion à After Motion AI » (outil `get_connection_status`).

**Claude Code** : `claude mcp add after-motion-ai -- node /chemin/packages/mcp-server/dist/index.js`

**Client HTTP** : lancer `node packages/mcp-server/dist/index.js --http --no-stdio` et utiliser
`http://127.0.0.1:7823/mcp` avec l'en-tête `Authorization: Bearer <jeton>`.

## Options

| Option | Effet |
|---|---|
| `--port <n>` / `AMAI_PORT` | Port local (défaut 7823) |
| `--export-dir <dir>` / `AMAI_EXPORT_DIR` | Dossier des vidéos exportées (défaut `~/AfterMotionAI/exports`) |
| `--http` | Active le transport Streamable HTTP sur `/mcp` |
| `--no-stdio` | Désactive stdio (serveur autonome) |
| `--headless [--project f.json]` | Sans éditeur connecté, exécute les outils sur un projet en mémoire (sauvegardé dans le fichier). Aperçu, import et export indisponibles dans ce mode (pas de rendu). |
| `--allow-origin <url>` | Autorise une origine supplémentaire pour l'éditeur |
| `--print-token` | Affiche le jeton du pont |
| `AMAI_BRIDGE_TOKEN` / `AMAI_TOKEN_FILE` | Jeton imposé / emplacement du fichier jeton (défaut `~/.after-motion-ai/bridge-token`, droits 0600) |

## Outils

| Outil | Description | Sensible |
|---|---|---|
| `get_connection_status` | État de la connexion à l'éditeur, adresse à ouvrir | |
| `get_project_info` | Résumé du projet, compositions, médias, sélection, temps courant | |
| `create_project` | Nouveau projet (remplace le projet ouvert) | ✔ |
| `update_composition` / `create_composition` / `set_active_composition` | Résolution, FPS, durée, fond ; scènes multiples | |
| `get_timeline` | Calques, plages, effets, propriétés animées, transitions | |
| `get_layer` | Toutes les données d'un calque | |
| `create_layer` | Solide, forme, texte, image, vidéo, audio, particules, composition, caméra, nul | |
| `create_text` | Texte (+ preset d'animation optionnel) | |
| `update_layer` | Nom, temps, visibilité, verrouillage, fusion, parent, motion blur, transitions, valeurs | |
| `delete_layer` | Supprime des calques | ✔ |
| `duplicate_layer`, `reorder_layer` | Duplication, ordre de pile | |
| `set_property` | Valeur d'une propriété (keyframe si animée) | |
| `add_keyframe`, `add_keyframes`, `remove_keyframe`, `set_keyframe_easing` | Keyframes et courbes (presets ou Bézier) | |
| `list_presets`, `create_animation` | Presets d'animation professionnels | |
| `list_effects`, `apply_effect`, `update_effect`, `remove_effect` | Effets visuels | |
| `add_mask` | Masques rectangle/ellipse/polygone, contour progressif | |
| `set_transition`, `add_transitions_between_clips` | Transitions d'entrée/sortie, fondus enchaînés | |
| `split_layer`, `merge_layers`, `move_layer_in_time`, `precompose` | Montage | |
| `optimize_animations` | Nettoyage des keyframes et effets redondants | |
| `select_layers`, `set_current_time` | Montrer à l'utilisateur | |
| `import_media` | Import depuis une URL ou un fichier local | ✔ |
| `get_preview` | Image rendue (PNG/JPEG) renvoyée au client | |
| `export_video` | Export MP4/WebM écrit dans le dossier d'export, progression MCP | ✔ |
| `get_history`, `undo_action`, `redo_action` | Historique | |

Les schémas de paramètres (JSON Schema) sont générés depuis les définitions zod de
`packages/core/src/tools.ts` et publiés via `tools/list`, avec les annotations
`readOnlyHint` / `destructiveHint` / `openWorldHint`.

## Sécurité

* Écoute sur **127.0.0.1** uniquement.
* **Jeton secret** (48 caractères hexadécimaux, comparaison à temps constant) exigé par le pont
  WebSocket et le transport HTTP.
* Contrôle de l'en-tête **Host** (protection DNS rebinding) et de l'**Origin** des connexions WebSocket.
* L'appairage automatique (`/bridge/info`) n'est servi qu'aux requêtes de même origine.
* **Actions sensibles** (`create_project`, `delete_layer`, `import_media`, `export_video`) :
  le serveur demande d'abord l'accord de l'utilisateur dans l'éditeur (boîte de dialogue montrant
  l'action et ses paramètres). Rien n'est lu sur le disque ni exécuté avant cet accord ; sans réponse
  sous 2 minutes, l'action est refusée. L'éditeur revérifie l'accord pour chaque requête.
* Import local : fichiers uniquement, extensions média reconnues, taille max 512 Mo.
* Export : nom de fichier assaini, écriture uniquement dans le dossier d'export.
* Erreurs renvoyées en `isError` avec un code (`invalid_arguments`, `not_found`, `locked`, `denied`,
  `editor_not_connected`, `timeout`, `unsupported`…).
