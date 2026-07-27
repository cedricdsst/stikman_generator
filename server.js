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
const imageQuality = ["low", "medium", "high"].includes(
  process.env.IMAGE_QUALITY?.toLowerCase(),
)
  ? process.env.IMAGE_QUALITY.toLowerCase()
  : "medium";
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

const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 250 * 1024 * 1024 },
});

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
  const job = {
    id,
    status: "queued",
    phase: "Préparation de l’audio…",
    progress: 0,
    transcript: "",
    segments: [],
    images: [],
    audioBuffer: null,
    audioMime: req.file.mimetype,
    error: null,
    createdAt: Date.now(),
  };

  jobs.set(id, job);
  res.status(202).json({ id });

  runJob(job, req.file).catch((error) => {
    console.error(error);
    job.status = "failed";
    job.phase = "Échec";
    job.error = formatError(error);
  });
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Tâche introuvable." });
  const since = Math.max(0, Number.parseInt(req.query.since || "0", 10) || 0);
  const { audioBuffer, ...publicJob } = job;
  res.json({
    ...publicJob,
    audioUrl: audioBuffer ? `/api/jobs/${job.id}/audio` : null,
    images: job.images.slice(since),
  });
});

app.get("/api/jobs/:id/audio", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job?.audioBuffer) return res.status(404).send("Audio introuvable.");
  const total = job.audioBuffer.length;
  const range = req.headers.range;

  res.type(job.audioMime || "audio/mpeg");
  res.set({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=21600",
  });

  if (!range) {
    res.set("Content-Length", String(total));
    return res.send(job.audioBuffer);
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
  res.send(job.audioBuffer.subarray(start, end + 1));
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

    job.audioBuffer = await fs.promises.readFile(mediaFile.path);
    job.audioMime = mediaFile.mimetype;
    job.status = "working";
    job.phase = "Transcription mot à mot…";
    job.progress = 5;

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
    job.phase = "Découpage du script en plans…";
    job.progress = 15;

    const segments = await createSegments(openai, words);
    job.segments = segments;
    job.phase = "Création d’une direction visuelle cohérente…";
    job.progress = 22;

    const directedSegments = await createVisualPrompts(openai, segments);
    job.segments = directedSegments;
    job.progress = 30;

    await generateImagesInParallel(openai, job, directedSegments);

    job.status = "completed";
    job.phase = "Terminé";
    job.progress = 100;
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

async function createVisualPrompts(openai, segments) {
  const response = await openai.responses.create({
    model: process.env.PROMPT_MODEL || "gpt-5.6-sol",
    reasoning: { effort: "medium" },
    instructions: `
Tu es directeur artistique d'une vidéo pédagogique illustrée.
À partir de toutes les scènes horodatées, conçois une direction visuelle globale puis un prompt d'image précis pour chaque scène.
Les images doivent raconter la progression du texte et rester cohérentes entre elles.
Si un narrateur ou personnage revient, conserve exactement son apparence, ses couleurs et ses accessoires.
Chaque prompt doit être autonome : répète les détails nécessaires à la cohérence, car les images seront générées dans des requêtes séparées.
N'ajoute aucune idée qui contredit le texte.
Évite généralement le texte dans les images. Cependant, si le passage contient une date, un nombre important, une durée ou un lieu géographique, tu peux demander à afficher exactement cet élément dans l'image lorsqu'il aide à comprendre ou à mémoriser l'information. Dans ce cas, conserve uniquement le texte essentiel, recopie-le fidèlement depuis le passage et précise dans le prompt qu'il doit être grand, correctement orthographié et facile à lire.
La fiche du personnage principal est permanente entre toutes les vidéos, pas seulement entre les scènes de ce storyboard. Reprends ses caractéristiques exactement dans chaque prompt où il apparaît. Ne confonds pas le personnage principal avec une autre personne représentée.

${CHARACTER_RULES}

Style obligatoire pour toutes les scènes : dessin extrêmement simple et volontairement mauvais fait par un débutant dans MS Paint, fond blanc, contours noirs épais et tremblants, personnages bâtons, formes géométriques basiques, expressions simples, couleurs plates rares, beaucoup d'espace vide, aucune ombre, aucun dégradé, aucune 3D, aucun anime, aucun rendu professionnel, composition horizontale 16:9 claire et centrée.
`.trim(),
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

  return segments.map((segment, index) => ({
    ...segment,
    visualPrompt: [
      CHARACTER_RULES,
      direction.styleBible,
      promptByIndex.get(index) || buildImagePrompt(segment, index, segments),
      "Wide horizontal 16:9 YouTube frame. Keep every important element away from the edges.",
    ].join("\n\n"),
  }));
}

async function generateImagesInParallel(openai, job, segments) {
  const concurrency = Math.max(
    1,
    Math.min(6, Number.parseInt(process.env.IMAGE_CONCURRENCY || "3", 10) || 3),
  );
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
          size: "1536x864",
          quality: imageQuality,
          output_format: "png",
          prompt: segment.visualPrompt,
        });

        job.images.push({
          index,
          start: segment.start,
          end: segment.end,
          timestamp: formatTimestamp(segment.start),
          text: segment.text,
          src: `data:image/png;base64,${result.data[0].b64_json}`,
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
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, segments.length) }, () => worker()),
  );
}

async function createSegments(openai, words) {
  const response = await openai.responses.create({
    model: process.env.SEGMENTATION_MODEL || "gpt-5.6-sol",
    reasoning: { effort: "none" },
    instructions: [
      "Tu es monteur vidéo.",
      "Regroupe une transcription horodatée en plans visuels cohérents.",
      "Chaque plan doit durer idéalement 2 à 4 secondes.",
      "Ne coupe pas une expression au milieu si quelques dixièmes de seconde supplémentaires améliorent nettement le sens.",
      "Couvre tous les mots, dans l’ordre, sans chevauchement ni omission.",
      "Retourne uniquement les index inclusifs du premier et du dernier mot de chaque plan.",
    ].join(" "),
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
  return normalizeSegments(words, proposed);
}

function normalizeSegments(words, proposed) {
  const result = [];
  let cursor = 0;

  for (const candidate of proposed) {
    if (cursor >= words.length) break;
    const proposedEnd = Math.max(cursor, Math.min(words.length - 1, candidate.lastWord));
    const hardLimit = findLastWordBefore(words, cursor, words[cursor].start + 4.5);
    const end = Math.min(proposedEnd, Math.max(cursor, hardLimit));
    result.push(toSegment(words, cursor, end));
    cursor = end + 1;
  }

  while (cursor < words.length) {
    const end = findLastWordBefore(words, cursor, words[cursor].start + 4);
    result.push(toSegment(words, cursor, Math.max(cursor, end)));
    cursor = Math.max(cursor, end) + 1;
  }

  return mergeTinyTail(result);
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

function mergeTinyTail(segments) {
  if (segments.length < 2) return segments;
  const tail = segments.at(-1);
  const previous = segments.at(-2);
  if (tail.end - tail.start >= 1.2 || tail.end - previous.start > 4.8) return segments;

  previous.lastWord = tail.lastWord;
  previous.end = tail.end;
  previous.text = `${previous.text} ${tail.text}`;
  segments.pop();
  return segments;
}

function buildImagePrompt(segment, index, segments) {
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
- cadre horizontal 16:9, ne rien couper sur les bords

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

setInterval(() => {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 60 * 60 * 1000).unref();

async function startServer() {
  if (process.env.NODE_ENV === "development") {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
  }

  app.listen(port, () => {
    console.log(`Stickman Generator : http://localhost:${port}`);
  });
}

startServer();
