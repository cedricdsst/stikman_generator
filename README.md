# Stickman Generator — MVP

Application Node.js qui transforme un fichier audio ou vidéo en storyboard illustré :

1. extraction automatique de la piste MP3 pour les vidéos avec FFmpeg ;
2. transcription et timestamps mot à mot avec `whisper-1` ;
3. regroupement du texte en scènes cohérentes avec une durée maximale configurable ;
4. direction artistique et rédaction de prompts cohérents avec `gpt-5.6-sol` ;
5. génération parallèle de chaque illustration avec `gpt-image-2` ;
6. affichage progressif des images dans le navigateur ;
7. prévisualisation du montage audio/image synchronisé avec Remotion Player ;
8. sauvegarde persistante de chaque projet et réouverture depuis le dashboard ;
9. régénération d’une scène à partir de son image actuelle avec conservation de
   toutes les versions et sélection de celle utilisée dans la vidéo ;
10. choix du format horizontal 16:9 ou vertical 4:5 à la création du projet.

## Installation

```bash
npm install
Copy-Item .env.example .env
```

Ajoute ensuite ta clé dans `.env` :

```env
OPENAI_API_KEY=sk-...
SEGMENTATION_MODEL=gpt-5.6-sol
PROMPT_MODEL=gpt-5.6-sol
IMAGE_CONCURRENCY=3
IMAGE_QUALITY=medium
IMAGE_QUALITY_RELOAD=medium
MAX_SCENE_DURATION=2.5
```

`IMAGE_QUALITY` accepte `low`, `medium` ou `high`. Si la valeur est absente ou
invalide, l’application utilise `medium`. Elle s’applique uniquement à la
génération initiale.

`IMAGE_QUALITY_RELOAD` accepte les mêmes valeurs et s’applique uniquement aux
régénérations faites depuis le storyboard. Sa valeur par défaut est `medium`.

`MAX_SCENE_DURATION` définit la durée maximale d’affichage d’une image en
secondes. Les nombres décimaux avec un point (`2.5`) ou une virgule (`2,5`) sont
acceptés. La valeur par défaut est `2.5`, avec une plage autorisée de `0.5` à
`30` secondes.

Puis lance l’application :

```bash
npm run dev
```

Ouvre <http://localhost:3000>.

Le dashboard est disponible sur <http://localhost:3000/dashboard>.

## Sauvegardes

Chaque génération crée un dossier local dans `data/projects/<id>/` contenant :

- `project.json` avec le transcript, les timestamps mot à mot, les scènes, les
  prompts, les réponses structurées des modèles et les paramètres utilisés ;
- la piste audio utilisée pour le montage ;
- le dossier `images/` avec tous les PNG générés.

Chaque scène conserve son historique de versions dans `project.json`. Une
régénération utilise la version sélectionnée comme image de référence pour
`gpt-image-2`, sans écraser les fichiers précédents.

Le format choisi est également sauvegardé dans le projet. Il pilote les prompts,
les générations initiales, les régénérations et les dimensions du lecteur :

- horizontal : `1536x864` en 16:9 ;
- vertical : `1024x1280` en 4:5.

Le dossier `data/` est volontairement ignoré par Git.

## Limites du MVP

- les fichiers audio temporaires sont supprimés après traitement ;
- les projets sauvegardés restent disponibles après un redémarrage ;
- la vidéo est une prévisualisation interactive, aucun MP4 n’est encodé ;
- la taille maximale d’une vidéo est de 250 Mo ;
- après extraction, la piste audio envoyée à Whisper ne doit pas dépasser 25 Mo.
