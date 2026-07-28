import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import ffmpegPath from "ffmpeg-static";
import multer from "multer";
import OpenAI, { toFile } from "openai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const jobs = new Map();
const projectsRoot = path.join(__dirname, "data", "projects");
const FORMAT_PRESETS = {
  horizontal: {
    id: "horizontal",
    label: "Horizontal 16:9",
    imageSize: "1536x864",
    width: 1536,
    height: 864,
    ratio: "16:9",
    prompt:
      "Cadre horizontal 16:9 de type vidéo YouTube. Composition large, claire et centrée.",
  },
  vertical: {
    id: "vertical",
    label: "Vertical 4:5",
    imageSize: "1024x1280",
    width: 1024,
    height: 1280,
    ratio: "4:5",
    prompt:
      "Cadre vertical 4:5. Composition organisée de haut en bas, claire et centrée, adaptée à un écran mobile. Ne crée pas une image horizontale et ne place rien d’important près des bords.",
  },
};
const imageQuality = ["low", "medium", "high"].includes(
  process.env.IMAGE_QUALITY?.toLowerCase(),
)
  ? process.env.IMAGE_QUALITY.toLowerCase()
  : "medium";
const imageReloadQuality = ["low", "medium", "high"].includes(
  process.env.IMAGE_QUALITY_RELOAD?.toLowerCase(),
)
  ? process.env.IMAGE_QUALITY_RELOAD.toLowerCase()
  : "medium";
const sceneMaxDuration = parseDecimalSetting(
  process.env.MAX_SCENE_DURATION,
  2.5,
  0.5,
  30,
);
const CHARACTER_RULES = `
Règles permanentes pour les personnages :
- Le personnage principal récurrent est toujours le même stickman : tête ronde blanche sans remplissage, contour noir épais et irrégulier, exactement deux petits yeux noirs pleins en forme de points, petite bouche tracée avec une seule ligne, corps formé d'une seule ligne noire verticale, bras et jambes faits d'une seule ligne noire chacun.
- Ne lui dessine jamais des yeux en cercles avec pupilles, des yeux réalistes, un torse carré, un corps rempli de couleur ou un t-shirt bleu générique.
- Son anatomie graphique et son visage de base ne changent jamais d'une vidéo à l'autre. Son expression, sa pose, l'orientation de son corps et les objets qu'il tient peuvent changer selon la scène.
- Ses vêtements, accessoires ou cheveux peuvent changer uniquement lorsque le récit, le métier, l'époque, le lieu ou l'identité représentée l'exigent. Ils doivent rester extrêmement simples et être ajoutés par-dessus sa structure de stickman sans transformer son corps en personnage réaliste.
- Les autres personnes utilisent le même style de stickman très simple, mais doivent être différenciées avec un ou deux signes visuels utiles seulement : coiffure, chapeau, moustache, lunettes, couleur de vêtement, accessoire, taille ou silhouette.
- Pour une personnalité ou un événement historique, autorise les vêtements, coiffures, couvre-chefs, expressions et poses nécessaires pour reconnaître la personne ou l'époque, tout en conservant le dessin enfantin MS Paint et les yeux en points noirs.
- N'ajoute pas de différences décoratives aléatoires. Chaque variation doit aider à comprendre qui est qui ou ce qui se passe.
`.trim();

fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });
fs.mkdirSync(projectsRoot, { recursive: true });

const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 250 * 1024 * 1024 },
});

app.use(express.json({ limit: "32kb" }));

app.post("/api/jobs", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Ajoute un fichier audio ou vidéo." });
  }

  if (!process.env.OPENAI_API_KEY) {
    fs.unlink(req.file.path, () => {});
    return res.status(500).json({
      error: "OPENAI_API_KEY est absente. Ajoute-la dans le fichier .env.",
    });
  }

  const id = crypto.randomUUID();
  const visualFormat = getVisualFormat(req.body?.format);
  const projectDir = path.join(projectsRoot, id);
  await fs.promises.mkdir(path.join(projectDir, "images"), { recursive: true });
  const job = {
    id,
    title: path.parse(req.file.originalname).name,
    status: "queued",
    phase: "Préparation de l’audio…",
    progress: 0,
    transcript: "",
    words: [],
    segments: [],
    images: [],
    audioMime: req.file.mimetype,
    audioFilename: null,
    source: {
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      kind: isVideoFile(req.file) ? "video" : "audio",
    },
    pipeline: {},
    visualFormat,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectDir,
    saveChain: Promise.resolve(),
  };

  jobs.set(id, job);
  await queueSave(job);
  res.status(202).json({ id });

  runJob(job, req.file).catch((error) => {
    console.error(error);
    job.status = "failed";
    job.phase = "Échec";
    job.error = formatError(error);
    queueSave(job);
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Tâche introuvable." });
  const since = Math.max(0, Number.parseInt(req.query.since || "0", 10) || 0);
  res.json({
    ...toPublicProject(job),
    images: job.images.slice(since),
  });
});

app.get("/api/projects", (_req, res) => {
  const projects = [...jobs.values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      phase: job.phase,
      progress: job.progress,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      imageCount: job.images.filter((image) => !image.error).length,
      duration: job.segments.at(-1)?.end || 0,
      thumbnail: job.images.find((image) => image.src)?.src || null,
      source: job.source,
      visualFormat: job.visualFormat,
    }));
  res.json(projects);
});

app.get("/api/projects/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });
  res.json(toPublicProject(job));
});

app.get(["/api/jobs/:id/audio", "/api/projects/:id/audio"], (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.audioFilename) return res.status(404).send("Audio introuvable.");
  const audioPath = path.join(job.projectDir, job.audioFilename);
  if (!fs.existsSync(audioPath)) return res.status(404).send("Audio introuvable.");
  const total = fs.statSync(audioPath).size;
  const range = req.headers.range;

  res.type(job.audioMime || "audio/mpeg");
  res.set({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=21600",
  });

  if (!range) {
    res.set("Content-Length", String(total));
    return fs.createReadStream(audioPath).pipe(res);
  }

  const match = /bytes=(\d+)-(\d*)/.exec(range);
  if (!match) return res.status(416).end();
  const start = Number(match[1]);
  const end = Math.min(match[2] ? Number(match[2]) : total - 1, total - 1);
  if (start > end || start >= total) return res.status(416).end();

  res.status(206);
  res.set({
    "Content-Range": `bytes ${start}-${end}/${total}`,
    "Content-Length": String(end - start + 1),
  });
  fs.createReadStream(audioPath, { start, end }).pipe(res);
});

app.get("/api/projects/:id/images/:filename", (req, res) => {
  if (!/^[a-zA-Z0-9_-]+\.png$/.test(req.params.filename)) {
    return res.status(400).send("Nom d’image invalide.");
  }
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).send("Projet introuvable.");
  res.sendFile(path.join(job.projectDir, "images", req.params.filename));
});

app.post("/api/projects/:id/scenes/:index/regenerate", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY est absente." });
  }

  const index = Number.parseInt(req.params.index, 10);
  const image = job.images.find((candidate) => candidate.index === index);
  const segment = job.segments[index];
  if (!image || !segment) {
    return res.status(404).json({ error: "Scène introuvable." });
  }

  normalizeImageVersions(job, image);
  const currentVersion =
    image.versions.find((version) => version.id === image.selectedVersionId) ||
    image.versions.at(-1);
  if (!currentVersion?.filename) {
    return res.status(409).json({ error: "Aucune image de référence disponible." });
  }

  const extraInstructions = String(req.body?.instructions || "").trim().slice(0, 1500);
  const referencePath = path.join(job.projectDir, "images", currentVersion.filename);
  if (!fs.existsSync(referencePath)) {
    return res.status(404).json({ error: "Le fichier de référence est introuvable." });
  }

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const formatInstruction = job.visualFormat.prompt;
    const regenerationPrompt = `
Reproduis l'image de référence en créant une nouvelle version de la même scène.
Conserve strictement le style MS Paint amateur, la composition générale, l'identité des personnages, leurs proportions et tous les éléments qui ne sont pas explicitement modifiés.

Prompt visuel original de la scène :
${segment.visualPrompt}

Instructions supplémentaires de l'utilisateur :
${extraInstructions || "Créer une variante très fidèle, avec seulement de petites différences naturelles de dessin."}

Format obligatoire : ${formatInstruction}
Conserve exactement le ratio ${job.visualFormat.ratio} du projet. N'ajoute aucun détail non demandé.
`.trim();

    const result = await openai.images.edit({
      model: "gpt-image-2",
      image: await toFile(
        fs.createReadStream(referencePath),
        currentVersion.filename,
        { type: "image/png" },
      ),
      prompt: regenerationPrompt,
      size: job.visualFormat.imageSize,
      quality: imageReloadQuality,
      output_format: "png",
    });

    const versionId = `v-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
    const filename = `${String(index).padStart(4, "0")}-${versionId}.png`;
    await fs.promises.writeFile(
      path.join(job.projectDir, "images", filename),
      Buffer.from(result.data[0].b64_json, "base64"),
    );

    const version = {
      id: versionId,
      filename,
      src: `/api/projects/${job.id}/images/${filename}`,
      createdAt: new Date().toISOString(),
      basedOnVersionId: currentVersion.id,
      instructions: extraInstructions,
      prompt: regenerationPrompt,
      quality: imageReloadQuality,
    };
    image.versions.push(version);
    image.selectedVersionId = versionId;
    image.filename = filename;
    image.src = version.src;
    image.error = null;
    await queueSave(job);

    res.json(toPublicProject(job));
  } catch (error) {
    console.error(error);
    res.status(error?.status || 500).json({ error: formatError(error) });
  }
});

app.post("/api/projects/:id/scenes/:index/select-version", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });

  const index = Number.parseInt(req.params.index, 10);
  const image = job.images.find((candidate) => candidate.index === index);
  if (!image) return res.status(404).json({ error: "Scène introuvable." });

  normalizeImageVersions(job, image);
  const version = image.versions.find(
    (candidate) => candidate.id === req.body?.versionId,
  );
  if (!version) return res.status(404).json({ error: "Version introuvable." });

  image.selectedVersionId = version.id;
  image.filename = version.filename;
  image.src = version.src;
  image.error = null;
  await queueSave(job);
  res.json(toPublicProject(job));
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.OPENAI_API_KEY) });
});

async function runJob(job, file) {
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let mediaFile = file;

  try {
    if (isVideoFile(file)) {
      job.status = "working";
      job.phase = "Extraction de l’audio de la vidéo…";
      job.progress = 2;
      mediaFile = await extractAudioAsMp3(file);
    }

    const audioStats = await fs.promises.stat(mediaFile.path);
    if (audioStats.size > 25 * 1024 * 1024) {
      throw new Error(
        "L’audio extrait dépasse 25 Mo. Utilise une vidéo plus courte ou plus compressée.",
      );
    }

    job.audioMime = mediaFile.mimetype;
    const sourceExtension = path.extname(mediaFile.originalname).toLowerCase();
    const safeExtension = [".mp3", ".wav", ".m4a", ".webm", ".mp4", ".mpeg", ".mpga"].includes(
      sourceExtension,
    )
      ? sourceExtension
      : ".mp3";
    job.audioFilename = `audio${safeExtension}`;
    await fs.promises.copyFile(
      mediaFile.path,
      path.join(job.projectDir, job.audioFilename),
    );
    job.status = "working";
    job.phase = "Transcription mot à mot…";
    job.progress = 5;
    await queueSave(job);

    const transcription = await openai.audio.transcriptions.create({
      file: await toFile(fs.createReadStream(mediaFile.path), mediaFile.originalname, {
        type: mediaFile.mimetype,
      }),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["word"],
    });

    const words = (transcription.words || []).map((word, index) => ({
      index,
      word: word.word,
      start: Number(word.start),
      end: Number(word.end),
    }));

    if (!words.length) {
      throw new Error("Aucun mot horodaté n’a été détecté dans cet audio.");
    }

    job.transcript = transcription.text;
    job.words = words;
    job.pipeline.transcription = {
      model: "whisper-1",
      responseFormat: "verbose_json",
      timestampGranularities: ["word"],
      text: transcription.text,
      words,
    };
    job.phase = "Découpage du script en plans…";
    job.progress = 15;
    await queueSave(job);

    const segmentation = await createSegments(openai, words);
    const segments = segmentation.segments;
    job.pipeline.segmentation = {
      model: process.env.SEGMENTATION_MODEL || "gpt-5.6-sol",
      reasoningEffort: "none",
      maxSceneDuration: sceneMaxDuration,
      instructions: segmentation.instructions,
      response: segmentation.response,
    };
    job.segments = segments;
    job.phase = "Création d’une direction visuelle cohérente…";
    job.progress = 22;
    await queueSave(job);

    const visualDirection = await createVisualPrompts(
      openai,
      segments,
      job.visualFormat,
    );
    const directedSegments = visualDirection.segments;
    job.pipeline.visualDirection = {
      model: process.env.PROMPT_MODEL || "gpt-5.6-sol",
      reasoningEffort: "medium",
      instructions: visualDirection.instructions,
      response: visualDirection.response,
    };
    job.pipeline.imageGeneration = {
      model: "gpt-image-2",
      quality: imageQuality,
      reloadQuality: imageReloadQuality,
      size: job.visualFormat.imageSize,
      format: job.visualFormat,
      concurrency: getImageConcurrency(),
    };
    job.segments = directedSegments;
    job.progress = 30;
    await queueSave(job);

    await generateImagesInParallel(openai, job, directedSegments);

    job.status = "completed";
    job.phase = "Terminé";
    job.progress = 100;
    await queueSave(job);
  } finally {
    fs.unlink(file.path, () => {});
    if (mediaFile.path !== file.path) fs.unlink(mediaFile.path, () => {});
  }
}

function isVideoFile(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  return file.mimetype.startsWith("video/") || [".mp4", ".mov", ".mkv", ".avi"].includes(extension);
}

async function extractAudioAsMp3(file) {
  if (!ffmpegPath) {
    throw new Error("FFmpeg n’est pas disponible sur cette plateforme.");
  }

  const outputPath = `${file.path}.mp3`;
  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        file.path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "44100",
        "-b:a",
        "96k",
        outputPath,
      ],
      { windowsHide: true },
    );
    let errorOutput = "";

    ffmpeg.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `Impossible d’extraire l’audio de cette vidéo.${errorOutput ? ` ${errorOutput.trim()}` : ""}`,
        ),
      );
    });
  });

  return {
    ...file,
    path: outputPath,
    originalname: `${path.parse(file.originalname).name}.mp3`,
    mimetype: "audio/mpeg",
  };
}

async function createVisualPrompts(openai, segments, visualFormat) {
  const instructions = `
Tu es directeur artistique d'une vidéo pédagogique illustrée.
À partir de toutes les scènes horodatées, conçois une direction visuelle globale puis un prompt d'image précis pour chaque scène.
Les images doivent raconter la progression du texte et rester cohérentes entre elles.
Si un narrateur ou personnage revient, conserve exactement son apparence, ses couleurs et ses accessoires.
Chaque prompt doit être autonome : répète les détails nécessaires à la cohérence, car les images seront générées dans des requêtes séparées.
N'ajoute aucune idée qui contredit le texte.
Évite généralement le texte dans les images. Cependant, si le passage contient une date, un nombre important, une durée ou un lieu géographique, tu peux demander à afficher exactement cet élément dans l'image lorsqu'il aide à comprendre ou à mémoriser l'information. Dans ce cas, conserve uniquement le texte essentiel, recopie-le fidèlement depuis le passage et précise dans le prompt qu'il doit être grand, correctement orthographié et facile à lire.
La fiche du personnage principal est permanente entre toutes les vidéos, pas seulement entre les scènes de ce storyboard. Reprends ses caractéristiques exactement dans chaque prompt où il apparaît. Ne confonds pas le personnage principal avec une autre personne représentée.

${CHARACTER_RULES}

Style obligatoire pour toutes les scènes : dessin extrêmement simple et volontairement mauvais fait par un débutant dans MS Paint, fond blanc, contours noirs épais et tremblants, personnages bâtons, formes géométriques basiques, expressions simples, couleurs plates rares, beaucoup d'espace vide, aucune ombre, aucun dégradé, aucune 3D, aucun anime, aucun rendu professionnel.

Format obligatoire pour l'ensemble du projet : ${visualFormat.prompt}
Tous les prompts de scène doivent rappeler explicitement le ratio ${visualFormat.ratio}. Organise la composition pour ce format précis.
`.trim();
  const response = await openai.responses.create({
    model: process.env.PROMPT_MODEL || "gpt-5.6-sol",
    reasoning: { effort: "medium" },
    instructions,
    input: JSON.stringify(
      segments.map(({ start, end, text }, index) => ({ index, start, end, text })),
    ),
    text: {
      format: {
        type: "json_schema",
        name: "visual_storyboard",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            styleBible: { type: "string" },
            scenes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  index: { type: "integer" },
                  visualPrompt: { type: "string" },
                },
                required: ["index", "visualPrompt"],
              },
            },
          },
          required: ["styleBible", "scenes"],
        },
      },
    },
  });

  const direction = JSON.parse(response.output_text);
  const promptByIndex = new Map(
    direction.scenes.map((scene) => [scene.index, scene.visualPrompt]),
  );

  return {
    instructions,
    response: direction,
    segments: segments.map((segment, index) => ({
      ...segment,
      visualPrompt: [
        CHARACTER_RULES,
        direction.styleBible,
        promptByIndex.get(index) ||
          buildImagePrompt(segment, index, segments, visualFormat),
        visualFormat.prompt,
      ].join("\n\n"),
    })),
  };
}

async function generateImagesInParallel(openai, job, segments) {
  const concurrency = getImageConcurrency();
  let cursor = 0;
  let completed = 0;

  const worker = async () => {
    while (cursor < segments.length) {
      const index = cursor;
      cursor += 1;
      const segment = segments[index];
      job.phase = `Génération parallèle : ${completed}/${segments.length} images terminées…`;

      try {
        const result = await openai.images.generate({
          model: "gpt-image-2",
          size: job.visualFormat.imageSize,
          quality: imageQuality,
          output_format: "png",
          prompt: segment.visualPrompt,
        });
        const filename = `${String(index).padStart(4, "0")}.png`;
        await fs.promises.writeFile(
          path.join(job.projectDir, "images", filename),
          Buffer.from(result.data[0].b64_json, "base64"),
        );
        const initialVersion = {
          id: "original",
          filename,
          src: `/api/projects/${job.id}/images/${filename}`,
          createdAt: new Date().toISOString(),
          basedOnVersionId: null,
          instructions: "",
          prompt: segment.visualPrompt,
        };

        job.images.push({
          index,
          start: segment.start,
          end: segment.end,
          timestamp: formatTimestamp(segment.start),
          text: segment.text,
          filename,
          src: initialVersion.src,
          versions: [initialVersion],
          selectedVersionId: initialVersion.id,
        });
      } catch (error) {
        job.images.push({
          index,
          start: segment.start,
          end: segment.end,
          timestamp: formatTimestamp(segment.start),
          text: segment.text,
          error: formatError(error),
        });
      }

      completed += 1;
      job.progress = Math.round(30 + (completed / segments.length) * 70);
      await queueSave(job);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()),
  );
}

function getImageConcurrency() {
  return Math.max(
    1,
    Math.min(6, Number.parseInt(process.env.IMAGE_CONCURRENCY || "3", 10) || 3),
  );
}

async function createSegments(openai, words) {
  const idealMinimum = Math.max(0.5, Math.round(sceneMaxDuration * 0.6 * 10) / 10);
  const instructions = [
    "Tu es monteur vidéo.",
    "Regroupe une transcription horodatée en plans visuels cohérents.",
    `Chaque plan doit durer idéalement entre ${idealMinimum} et ${sceneMaxDuration} secondes.`,
    `La durée de ${sceneMaxDuration} secondes est un maximum strict à ne jamais dépasser.`,
    "Privilégie une coupure sémantique naturelle à l'intérieur de cette limite.",
    "Couvre tous les mots, dans l’ordre, sans chevauchement ni omission.",
    "Retourne uniquement les index inclusifs du premier et du dernier mot de chaque plan.",
  ].join(" ");
  const response = await openai.responses.create({
    model: process.env.SEGMENTATION_MODEL || "gpt-5.6-sol",
    reasoning: { effort: "none" },
    instructions,
    input: JSON.stringify(words),
    text: {
      format: {
        type: "json_schema",
        name: "video_segments",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            segments: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  firstWord: { type: "integer" },
                  lastWord: { type: "integer" },
                },
                required: ["firstWord", "lastWord"],
              },
            },
          },
          required: ["segments"],
        },
      },
    },
  });

  const proposed = JSON.parse(response.output_text).segments;
  return {
    instructions,
    response: { segments: proposed },
    segments: normalizeSegments(words, proposed, sceneMaxDuration),
  };
}

function normalizeSegments(words, proposed, maxDuration) {
  const result = [];
  let cursor = 0;

  for (const candidate of proposed) {
    if (cursor >= words.length) break;
    const proposedEnd = Math.max(cursor, Math.min(words.length - 1, candidate.lastWord));
    const hardLimit = findLastWordBefore(
      words,
      cursor,
      words[cursor].start + maxDuration,
    );
    const end = Math.min(proposedEnd, Math.max(cursor, hardLimit));
    result.push(toSegment(words, cursor, end));
    cursor = end + 1;
  }

  while (cursor < words.length) {
    const end = findLastWordBefore(
      words,
      cursor,
      words[cursor].start + maxDuration,
    );
    result.push(toSegment(words, cursor, Math.max(cursor, end)));
    cursor = Math.max(cursor, end) + 1;
  }

  return mergeTinyTail(result, maxDuration);
}

function findLastWordBefore(words, startIndex, limit) {
  let end = startIndex;
  while (end + 1 < words.length && words[end + 1].end <= limit) end += 1;
  return end;
}

function toSegment(words, firstWord, lastWord) {
  const selection = words.slice(firstWord, lastWord + 1);
  return {
    firstWord,
    lastWord,
    start: selection[0].start,
    end: selection.at(-1).end,
    text: selection.map(({ word }) => word).join(" ").replace(/\s+([,.!?;:])/g, "$1"),
  };
}

function mergeTinyTail(segments, maxDuration) {
  if (segments.length < 2) return segments;
  const tail = segments.at(-1);
  const previous = segments.at(-2);
  if (
    tail.end - tail.start >= Math.min(1.2, maxDuration / 2) ||
    tail.end - previous.start > maxDuration
  ) {
    return segments;
  }

  previous.lastWord = tail.lastWord;
  previous.end = tail.end;
  previous.text = `${previous.text} ${tail.text}`;
  segments.pop();
  return segments;
}

function buildImagePrompt(segment, index, segments, visualFormat) {
  const previous = segments[index - 1]?.text || "aucun";
  const next = segments[index + 1]?.text || "aucun";

  return `
Crée une illustration qui explique visuellement ce passage exact d'une narration française :
"${segment.text}"

Contexte juste avant : "${previous}"
Contexte juste après : "${next}"

STYLE OBLIGATOIRE :
- dessin extrêmement simple et volontairement maladroit fait par un débutant dans MS Paint
- fond entièrement blanc, beaucoup d'espace vide
- contours noirs épais, irréguliers et tremblants
- personnages bâtons avec tête ronde, corps en lignes et expressions très basiques
- objets dessinés uniquement avec des formes simples
- couleurs plates occasionnelles : rouge, vert, bleu, jaune, orange, brun ou gris
- composition amusante, claire, centrée et immédiatement compréhensible
- aucune ombre réaliste, aucun dégradé, aucune texture complexe
- aucun rendu 3D, cinématographique, anime, Disney, vectoriel ou professionnel
- pas de détails inutiles ; évite généralement le texte
- si le passage contient une date, un nombre important, une durée ou un lieu géographique utile à la compréhension, tu peux afficher exactement cet élément, en grand, correctement orthographié et facile à lire
- format obligatoire : ${visualFormat.prompt}
- respecter exactement le ratio ${visualFormat.ratio}, ne rien couper sur les bords

${CHARACTER_RULES}

Montre une seule idée visuelle forte correspondant précisément au passage, avec au maximum trois personnages ou objets principaux.
`.trim();
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function formatError(error) {
  if (error?.status === 429) return "Limite API atteinte. Réessaie dans un instant.";
  return error?.error?.message || error?.message || "Une erreur inconnue est survenue.";
}

function parseDecimalSetting(value, fallback, minimum, maximum) {
  const parsed = Number(String(value ?? "").trim().replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

function getVisualFormat(format) {
  const preset =
    format === "vertical" ? FORMAT_PRESETS.vertical : FORMAT_PRESETS.horizontal;
  return { ...preset };
}

function projectSnapshot(job) {
  return {
    version: 1,
    id: job.id,
    title: job.title,
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    transcript: job.transcript,
    words: job.words,
    segments: job.segments,
    images: [...job.images].sort((a, b) => a.index - b.index),
    audioMime: job.audioMime,
    audioFilename: job.audioFilename,
    source: job.source,
    pipeline: job.pipeline,
    visualFormat: job.visualFormat,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeImageVersions(job, image) {
  if (!Array.isArray(image.versions)) {
    image.versions = image.filename
      ? [
          {
            id: "original",
            filename: image.filename,
            src: `/api/projects/${job.id}/images/${image.filename}`,
            createdAt: job.createdAt,
            basedOnVersionId: null,
            instructions: "",
            prompt: job.segments[image.index]?.visualPrompt || "",
          },
        ]
      : [];
  }

  image.versions = image.versions.map((version) => ({
    ...version,
    src: version.filename
      ? `/api/projects/${job.id}/images/${version.filename}`
      : version.src,
  }));

  if (!image.selectedVersionId && image.versions.length) {
    image.selectedVersionId = image.versions.at(-1).id;
  }
  const selected =
    image.versions.find((version) => version.id === image.selectedVersionId) ||
    image.versions.at(-1);
  if (selected) {
    image.filename = selected.filename;
    image.src = selected.src;
  }
  return image;
}

function toPublicProject(job) {
  const snapshot = projectSnapshot(job);
  return {
    ...snapshot,
    audioUrl: snapshot.audioFilename
      ? `/api/projects/${job.id}/audio`
      : null,
  };
}

function queueSave(job) {
  job.updatedAt = new Date().toISOString();
  job.saveChain = (job.saveChain || Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const snapshot = projectSnapshot(job);
      const manifestPath = path.join(job.projectDir, "project.json");
      const temporaryPath = path.join(job.projectDir, "project.json.tmp");
      await fs.promises.writeFile(
        temporaryPath,
        JSON.stringify(snapshot, null, 2),
        "utf8",
      );
      await fs.promises.rename(temporaryPath, manifestPath);
    });
  return job.saveChain;
}

async function loadProjects() {
  const entries = await fs.promises.readdir(projectsRoot, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, entry.name);
    const manifestPath = path.join(projectDir, "project.json");

    try {
      const saved = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
      const job = {
        ...saved,
        visualFormat: saved.visualFormat || getVisualFormat("horizontal"),
        projectDir,
        saveChain: Promise.resolve(),
        images: saved.images || [],
      };
      job.images = job.images.map((image) => normalizeImageVersions(job, image));

      if (["queued", "working"].includes(job.status)) {
        job.status = "failed";
        job.phase = "Traitement interrompu";
        job.error =
          "Le serveur a redémarré avant la fin de la génération. Les données déjà produites sont conservées.";
        await queueSave(job);
      }

      jobs.set(job.id, job);
    } catch (error) {
      console.error(`Projet illisible ignoré : ${entry.name}`, error);
    }
  }
}

async function startServer() {
  await loadProjects();

  if (process.env.NODE_ENV === "development") {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.use((req, res, next) => {
      if (req.method !== "GET" || !req.accepts("html")) return next();
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(port, () => {
    console.log(`Stickman Generator : http://localhost:${port}`);
  });
}

startServer();
