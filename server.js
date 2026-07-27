import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
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

fs.mkdirSync(path.join(__dirname, "uploads"), { recursive: true });

const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 25 * 1024 * 1024 },
});

app.post("/api/jobs", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Ajoute un fichier audio." });
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

  try {
    job.audioBuffer = await fs.promises.readFile(file.path);
    job.status = "working";
    job.phase = "Transcription mot à mot…";
    job.progress = 5;

    const transcription = await openai.audio.transcriptions.create({
      file: await toFile(fs.createReadStream(file.path), file.originalname, {
        type: file.mimetype,
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
  }
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

Style obligatoire pour toutes les scènes : dessin extrêmement simple et volontairement mauvais fait par un débutant dans MS Paint, fond blanc, contours noirs épais et tremblants, personnages bâtons, formes géométriques basiques, expressions simples, couleurs plates rares, beaucoup d'espace vide, aucune ombre, aucun dégradé, aucune 3D, aucun anime, aucun rendu professionnel, composition horizontale 16:9 claire et centrée. Évite le texte dans l'image.
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
- pas de détails inutiles et pas de texte, sauf un mot très court indispensable
- cadre horizontal 16:9, ne rien couper sur les bords

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
