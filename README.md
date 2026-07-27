# Stickman Generator — MVP

Application Node.js qui transforme un fichier audio en storyboard illustré :

1. transcription et timestamps mot à mot avec `whisper-1` ;
2. regroupement du texte en scènes cohérentes de 2 à 4 secondes avec `gpt-5.6-sol` ;
3. direction artistique et rédaction de prompts cohérents avec `gpt-5.6-sol` ;
4. génération parallèle de chaque illustration avec `gpt-image-2` ;
5. affichage progressif des images dans le navigateur ;
6. prévisualisation du montage audio/image synchronisé avec Remotion Player.

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
```

`IMAGE_QUALITY` accepte `low`, `medium` ou `high`. Si la valeur est absente ou
invalide, l’application utilise `medium`.

Puis lance l’application :

```bash
npm run dev
```

Ouvre <http://localhost:3000>.

## Limites du MVP

- les tâches et images sont conservées seulement en mémoire ;
- elles disparaissent lorsque le serveur redémarre ;
- les fichiers audio temporaires sont supprimés après traitement ;
- la vidéo est une prévisualisation interactive, aucun MP4 n’est encodé ;
- la taille maximale d’un fichier est de 25 Mo.
