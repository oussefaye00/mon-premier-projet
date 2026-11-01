# Consignes pour Claude

## Vidéos : toujours combiner les trois skills

Pour toute demande de vidéo (promo, plan animé, motion design), utiliser **à chaque fois**
ces trois skills ensemble, chacun dans son rôle :

| Skill | Rôle |
|---|---|
| `video-shotcraft` (dans `.claude/skills/`) | **Moteur de production** : Remotion, fiches de plans + code des démos, workflow, musique et effets sonores, revue finale indépendante. Ce skill décide de l'outil de rendu. |
| `motion-design` | **Règles d'animation** : easing choisi pour chaque élément (ease-out pour les entrées, ease-in pour les sorties, jamais linéaire sauf pour les éléments mécaniques), décalages en cascade, anticipation et suivi du mouvement, durées qui traduisent le poids, vérification des images à mi-transition. |
| `saas-motion-video` | **Règles créatives** : phrase « message et ton » écrite avant de choisir les effets, tableau des plans (entrée, transition, easing, direction, son), au moins 3 familles de transitions et jamais la même deux fois de suite, au moins un composant inventé par vidéo, peu de texte à l'écran, aucune statistique ni capacité inventée, pas de noir #000 ni de blanc #fff purs, pas de rebond ni d'élastique sur l'UI. |

Le rendu se fait avec **Remotion** (video-shotcraft). Le pipeline HyperFrames de
`saas-motion-video` n'est pas utilisé : on n'en reprend que les règles créatives.

En cas de conflit entre les règles, la plus exigeante l'emporte. Les validations
du mode choisi (par exemple les étapes de la co-création) restent celles de
`video-shotcraft`.
