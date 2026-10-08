# Stickman Generator — MVP

Application Node.js qui transforme un fichier audio ou vidéo en storyboard illustré :

1. préparation audio locale avec AudioHumanifier : réglages, comparaison avant/après et validation avant génération ;
2. transcription et timestamps mot à mot avec `whisper-1` ;
3. regroupement du texte en scènes cohérentes avec une durée maximale configurable ;
4. direction artistique et rédaction de prompts cohérents avec `gpt-5.6-sol` ;
5. génération parallèle de chaque illustration avec `gpt-image-2` ;
6. affichage progressif des images dans le navigateur ;
7. prévisualisation du montage audio/image synchronisé avec Remotion Player ;
8. sauvegarde persistante de chaque projet et réouverture depuis le dashboard ;
9. régénération d’une scène à partir de son image actuelle avec conservation de
   toutes les versions et sélection de celle utilisée dans la vidéo ;
10. choix du format horizontal 16:9 ou vertical 4:5 à la création du projet ;
11. timeline éditable avec forme d’onde, mots horodatés et déplacement des
    images avec aimantation sur les débuts de mots ;
12. export MP4 téléchargeable avec l’audio, les versions sélectionnées et les
    timings manuels du montage ;
13. choix d’une couleur d’arrière-plan par nom et code hexadécimal, réutilisée
    dans les prompts initiaux et les régénérations.

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
IMAGE_CONCURRENCY=10
IMAGE_REQUESTS_PER_MINUTE=50
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

## Préparer l’audio avec AudioHumanifier

Le bouton **Préparer mon audio** importe le fichier dans un projet sauvegardé.
Cette étape accepte les fichiers audio (dont FLAC) et vidéo, jusqu’à 250 Mo et
30 minutes. Elle ne lance aucune transcription ni génération d’image.

Le moteur FFmpeg d’AudioHumanifier (HumanTone) est intégré dans
`lib/audio-humanifier/`, sans dépendre de son dossier ou de son serveur :

- profils Naturel, Podcast et Studio ;
- intensité, réduction des pauses, vitesse de 80 à 120 %, atténuation des
  sifflantes et seuil des pauses à conserver ;
- variations locales de hauteur et de rythme, avec possibilité de varier les nuances ;
- lecteurs avant/après, historique des essais et téléchargement des WAV 24 bits à 48 kHz.

Chaque essai repart du fichier d’origine, qui reste intact. Les réglages sont
sauvegardés au fil des modifications. On peut choisir un ancien essai ou conserver
l’original. Si les réglages diffèrent de l’essai sélectionné, l’interface demande
de produire un nouvel essai avant de le valider.

**Valider cet audio et créer la vidéo** place le projet dans la file des générations.
Le fichier MP3 écouté et validé est utilisé pour la transcription, les timestamps,
la prévisualisation et l’export MP4. Les WAV restent disponibles comme exports audio ;
le MP3 mono à 96 kbit/s garde l’envoi à la transcription sous 25 Mo.
Après validation, la piste du projet est figée pour conserver la synchronisation.

Les traitements audio ont une file locale séparée, avec un traitement à la fois.
Ils continuent pendant les générations d’images et les changements de page.
Après redémarrage du serveur, les traitements interrompus reprennent ; les audios
qui attendent une validation restent en brouillon et ne déclenchent aucun appel IA.
Les projets existants conservent leur fonctionnement et leur piste actuelle.

## Plusieurs projets et travaux en arrière-plan

Les nouvelles générations sont traitées **une par une, dans l’ordre de validation**.
Tu peux en lancer plusieurs, revenir au dashboard, monter un autre projet ou
fermer le navigateur : les tâches acceptées restent gérées par le serveur.
Le panneau « Travaux en arrière-plan » affiche l’activité et les projets en attente.

Toutes les générations et régénérations partagent une seule limite globale :

- `IMAGE_CONCURRENCY=10` : dix requêtes au maximum en cours dans l’application ;
- `IMAGE_REQUESTS_PER_MINUTE=50` : au plus cinquante démarrages de génération
  par minute, espacés pour éviter les rafales ;
- une retouche manuelle prend la prochaine place libre, sans annuler les images
  déjà lancées. Une seule retouche s’exécute à la fois ; les autres places restent
  disponibles pour le projet en cours. Sans retouche, toutes les places lui servent.

Ces réglages correspondent au plafond communiqué pour ce compte :
`gpt-image-2`, **50 images/min et 800 000 tokens/min**. Dix requêtes simultanées
est un choix de l’application, pas une limite de simultanéité annoncée par OpenAI.
Les limites par minute et les requêtes simultanées sont distinctes ; les autres
applications utilisant le même compte peuvent aussi consommer ces quotas.
Voir la [documentation des limites OpenAI](https://developers.openai.com/api/docs/guides/rate-limits).

Le serveur suit les en-têtes de quota disponibles. Les erreurs temporaires
déclenchent une attente conforme à `Retry-After`, sinon une attente croissante,
avec au plus six tentatives et quinze minutes de reprise par tâche image.
Les erreurs de crédit ou les refus permanents ne sont pas répétés automatiquement.
Une image en échec ne bloque pas les autres scènes ni le projet suivant.

La timeline devient disponible dès que l’audio est découpé. Chaque image absente
est représentée par une scène provisoire numérotée et un court extrait du script,
dans le lecteur, la timeline et le storyboard. Les timings sont sauvegardés sans
attendre les images ; leur arrivée conserve les déplacements et les versions choisies.

Les retouches sont enregistrées immédiatement et leur état reste visible après
un changement de page. Une deuxième demande sur la même scène est bloquée jusqu’à
la fin de la première. Une sélection de version faite pendant une retouche est
conservée : la nouvelle version est ajoutée à l’historique.

## Reprise après redémarrage

Relance `npm start` (ou `npm run dev`) après l’arrêt du serveur ou du PC :
les projets, retouches et exports en attente reprennent automatiquement.
La transcription, le découpage, les prompts, les images et les timings déjà
sauvegardés sont réutilisés. Le fichier source est conservé avant l’acceptation
du projet, y compris pour les projets qui n’ont pas encore commencé.
La fenêtre des demandes d’images et les attentes API sont également conservées.

Une image entièrement écrite avant l’arrêt est récupérée sans nouvel appel.
En revanche, une requête interrompue dont la réponse n’a pas été enregistrée
peut devoir être refaite et facturée de nouveau : l’API Images ne fournit pas ici
de récupération d’une réponse perdue. Le serveur doit être relancé pour reprendre ;
aucun démarrage automatique de Windows n’est installé.

Les anciens projets restent compatibles. Les anciens traitements marqués
« Traitement interrompu » sont repris lorsque leurs fichiers et étapes sauvegardés
le permettent. Pour une autre erreur de pipeline, le bouton « Reprendre le
traitement » relance à partir des étapes disponibles.

## Exports pendant le montage

Les exports utilisent une file séparée, avec un seul encodage FFmpeg à la fois.
Chaque export sauvegarde son propre instantané des images sélectionnées et des
timings. Tu peux continuer le montage : l’encodage conserve l’état du lancement.
S’il ne correspond plus au montage actuel, l’interface le signale et propose un
nouvel export. Les fichiers de deux exports ne peuvent pas s’écraser.
L’export attend qu’une image valide soit disponible pour chaque scène.

La suppression d’un projet est refusée tant qu’il possède un traitement actif
ou en attente, afin de préserver les fichiers utilisés par les tâches.

## Vérification

`npm test` vérifie la préparation audio et sa validation, les files, la priorité des retouches, les plafonds, les erreurs,
les sauvegardes concurrentes, les reprises après arrêt et les exports. Les tests
emploient une API OpenAI locale simulée, des dossiers temporaires isolés et FFmpeg
pour les essais MP4 ; ils ne consomment pas de crédits et ne modifient pas les projets.
`npm run check` vérifie le serveur et compile l’interface.

## Sauvegardes

Chaque génération crée un dossier local dans `data/projects/<id>/` contenant :

- `project.json` avec le transcript, les timestamps mot à mot, les scènes, les
  prompts, les réponses structurées des modèles et les paramètres utilisés ;
- la piste audio utilisée pour le montage ;
- le fichier source d’origine pour la reprise des projets en attente ;
- le dossier `images/` avec tous les PNG générés.

Chaque scène conserve son historique de versions dans `project.json`. Une
régénération utilise la version sélectionnée comme image de référence pour
`gpt-image-2`, sans écraser les fichiers précédents. Si la génération initiale
d’une scène a échoué et qu’aucune image de référence n’existe, le même bouton
reformule automatiquement le prompt de façon concise et conforme avant de
relancer une création d’image.

## Diagnostic des générations

Le serveur affiche dans le terminal un journal structuré de chaque étape :
transcription, découpage, direction visuelle et génération de chaque image. Une
copie persistante est enregistrée dans
`data/projects/<id>/generation.log`. Ce fichier contient notamment les durées,
les codes et identifiants de requête API ainsi que la stack des erreurs, mais ni
la clé API, ni le transcript, ni les prompts complets.

Pour ne voir que les erreurs du dernier projet sous PowerShell :

```powershell
Get-Content data/projects/<id>/generation.log | Select-String '"level":"error"'
```

Le format choisi est également sauvegardé dans le projet. Il pilote les prompts,
les générations initiales, les régénérations et les dimensions du lecteur :

- horizontal : `1536x864` en 16:9 ;
- vertical : `1024x1280` en 4:5.

La couleur d’arrière-plan est sauvegardée dans `backgroundColor` avec son nom
et son code `#RRGGBB`. Les anciens projets utilisent automatiquement le blanc
`#FFFFFF`.

Les ajustements effectués dans la timeline sont enregistrés dans
`timelineHistory`. Le champ `timelineStart` de chaque image détermine son
apparition dans le lecteur Remotion, sans modifier les timestamps Whisper
originaux.

L’export final est encodé en H.264/AAC par FFmpeg dans `export-<id>.mp4`.
Une signature du montage distingue la version exportée du montage actuel.
Les anciens fichiers `export.mp4` restent lisibles.

Le dossier `data/` est volontairement ignoré par Git.

## Limites du MVP

- les fichiers temporaires d’un traitement audio terminé sont supprimés ; le
  fichier source et les essais restent dans le projet jusqu’à sa suppression ;
- les projets sauvegardés restent disponibles après un redémarrage ;
- l’encodage MP4 est effectué localement et sa durée dépend de la longueur du
  projet et des performances de la machine ;
- la taille maximale d’une vidéo est de 250 Mo ;
- après extraction, la piste audio envoyée à Whisper ne doit pas dépasser 25 Mo.
