import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import express from "express";
import ffmpegPath from "ffmpeg-static";
import multer from "multer";
import { TaskQueue, retryDelay } from "./lib/task-queue.js";
import { activeTask, ensureScenes, exportSignature } from "./lib/project-state.js";
import { createImageWork } from "./lib/image-work.js";
import { createPipeline } from "./lib/pipeline.js";
import { createExportWork } from "./lib/export-work.js";
import { rateState } from "./lib/rate-state.js";
import { createAudioWork, newAudioPreparation, publicAudioPreparation } from "./lib/audio-work.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3000);
const jobs = new Map();
const projectsRoot = path.resolve(process.env.PROJECTS_ROOT || path.join(__dirname, "data", "projects"));
const uploadsRoot = path.resolve(process.env.UPLOADS_ROOT || path.join(__dirname, "uploads"));
const projectQueue = new TaskQueue();
const exportQueue = new TaskQueue();
const audioQueue = new TaskQueue();
const imageQueue = new TaskQueue({
  concurrency: getImageConcurrency(),
  requestsPerMinute: Math.max(1, Number.parseInt(process.env.IMAGE_REQUESTS_PER_MINUTE || "50", 10) || 50),
  getRetryDelay: retryDelay,
});
let observedImageLimits = {};
const imageRateState = rateState(imageQueue, path.join(projectsRoot, "image-rate-window.json"));
const serverRunId = crypto.randomUUID();
const diagnosticLogFilename = "generation.log";
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

const imageWork = createImageWork({ imageQueue, queueSave, logJob, formatError,
  getErrorDiagnostics, normalizeImageVersions, createCompliantRetryImagePrompt,
  getBackgroundColorInstruction, imageQuality, imageReloadQuality, observeImageLimits,
  saveRateState: imageRateState.save });
const runJob = createPipeline({ queueSave, logJob, isVideoFile, extractAudioAsMp3,
  createSegments, createVisualPrompts, generateInitial: imageWork.generateInitial,
  sceneMaxDuration, imageQuality, imageReloadQuality, getImageConcurrency });
const exportWork = createExportWork({ exportQueue, queueSave, runFfmpeg, getExportSignature, formatError });
const audioWork = createAudioWork({ audioQueue, queueSave, logJob, formatError });

function observeImageLimits(headers) {
  for (const field of ["requests", "tokens", "project-tokens"]) {
    const value = headers.get(`x-ratelimit-limit-${field}`);
    if (value) observedImageLimits[field] = Number(value);
    if (headers.get(`x-ratelimit-remaining-${field}`) === "0") {
      const reset = headers.get(`x-ratelimit-reset-${field}`) || "";
      let ms = 0;
      for (const [, number, unit] of reset.matchAll(/([\d.]+)(ms|s|m|h)/g)) {
        ms += Number(number) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit]);
      }
      imageQueue.cooldownUntil = Math.max(imageQueue.cooldownUntil, Date.now() + (ms || 60_000));
    }
  }
}

fs.mkdirSync(uploadsRoot, { recursive: true });
fs.mkdirSync(projectsRoot, { recursive: true });

const upload = multer({
  dest: uploadsRoot,
  limits: { fileSize: 250 * 1024 * 1024 },
});

app.use(express.json({ limit: "32kb" }));

app.post("/api/jobs", upload.single("audio"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "Ajoute un fichier audio ou vidéo." });
  }

  const prepareAudio = req.body?.prepareAudio === "true";
  if (!prepareAudio && !process.env.OPENAI_API_KEY) {
    fs.unlink(req.file.path, () => {});
    return res.status(500).json({
      error: "OPENAI_API_KEY est absente. Ajoute-la dans le fichier .env.",
    });
  }

  const backgroundColor = parseBackgroundColor(
    req.body?.backgroundName,
    req.body?.backgroundHex,
  );
  if (!backgroundColor) {
    fs.unlink(req.file.path, () => {});
    return res.status(400).json({
      error:
        "Couleur d’arrière-plan invalide. Indique un nom et un code au format #RRGGBB.",
    });
  }

  const id = crypto.randomUUID();
  const visualFormat = getVisualFormat(req.body?.format);
  const projectDir = path.join(projectsRoot, id);
  await fs.promises.mkdir(path.join(projectDir, "images"), { recursive: true });
  const sourceFilename = `source${path.extname(req.file.originalname).replace(/[^.a-zA-Z0-9]/g, "") || ".bin"}`;
  await fs.promises.rename(req.file.path, path.join(projectDir, sourceFilename));
  const job = {
    id,
    title: path.parse(req.file.originalname).name,
    status: prepareAudio ? "draft" : "queued",
    phase: prepareAudio ? "Préparation audio en attente…" : "En attente du projet précédent…",
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
    sourceFilename,
    audioPreparation: prepareAudio ? newAudioPreparation() : null,
    queuedAt: prepareAudio ? null : new Date().toISOString(),
    revision: 0,
    pipeline: {},
    timelineHistory: [],
    visualFormat,
    backgroundColor,
    error: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    projectDir,
    saveChain: Promise.resolve(),
  };

  jobs.set(id, job);
  await queueSave(job);
  await logJob(job, "info", "project.created", prepareAudio ? "Projet créé pour préparer l’audio." : "Projet créé et mis en file d’attente.", {
    source: {
      originalName: job.source.originalName,
      mimeType: job.source.mimeType,
      size: job.source.size,
      kind: job.source.kind,
    },
    visualFormat: job.visualFormat.id,
    imageSize: job.visualFormat.imageSize,
    imageQuality,
    imageConcurrency: getImageConcurrency(),
  });
  res.status(202).json({ id });

  if (prepareAudio) audioWork.schedule(job);
  else scheduleProject(job);
});

for (const [action, handler] of Object.entries({
  settings: (job, body) => audioWork.saveSettings(job, body),
  process: (job, body) => audioWork.request(job, body),
  approve: async (job, body) => { await audioWork.approve(job, body.versionId); if (job.status === "queued") scheduleProject(job); },
})) {
  app.post(`/api/projects/:id/audio-preparation/${action}`, async (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "Projet introuvable." });
    try {
      await handler(job, req.body || {});
      res.status(action === "settings" ? 200 : 202).json(toPublicProject(job));
    } catch (error) { res.status(error.status || 500).json({ error: formatError(error) }); }
  });
}

app.get("/api/projects/:id/audio-preparation/:versionId/:action", (req, res) => {
  const job = jobs.get(req.params.id);
  const preparation = job?.audioPreparation;
  const version = req.params.versionId === "original" ? preparation?.original : preparation?.versions.find((entry) => entry.id === req.params.versionId);
  if (!version || !["listen", "download"].includes(req.params.action)) return res.status(404).send("Version audio introuvable.");
  const download = req.params.action === "download";
  const filename = download ? version.filename : version.previewFilename;
  const filePath = path.join(job.projectDir, filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("Audio introuvable.");
  if (download) return res.download(filePath, `${job.title}-${version.id === "original" ? "source" : "humanifie"}${path.extname(filename)}`);
  res.type("audio/mpeg").sendFile(filePath);
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
      imageCount: job.images.filter((image) => image.src && !image.error).length,
      sceneCount: job.segments.length,
      pendingRetouches: job.images.filter((image) => activeTask(image.regeneration)).length,
      export: toPublicExport(job),
      duration: job.audioDuration || job.segments.at(-1)?.end || job.audioPreparation?.original?.analysis.durationSeconds || 0,
      thumbnail: job.images.find((image) => image.src)?.src || null,
      source: job.source,
      visualFormat: job.visualFormat,
      error: job.error,
    }));
  res.json(projects);
});

app.get("/api/projects/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });
  res.json(toPublicProject(job));
});

app.get("/api/queue", (_req, res) => {
  res.json({
    images: { ...imageQueue.snapshot(), observedLimits: observedImageLimits },
    projects: [...jobs.values()].filter((job) => ["queued", "working"].includes(job.status))
      .sort((a, b) => (a.queuedAt || a.createdAt).localeCompare(b.queuedAt || b.createdAt))
      .map((job) => ({ id: job.id, title: job.title, status: job.status, phase: job.phase, progress: job.progress })),
    exports: exportQueue.snapshot(),
    audio: { ...audioQueue.snapshot(), projects: [...jobs.values()].filter((job) => activeTask(job.audioPreparation?.task))
      .map((job) => ({ id: job.id, title: job.title, phase: job.phase })) },
  });
});

app.post("/api/projects/:id/resume", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });
  if (job.status !== "failed") return res.status(409).json({ error: "Ce projet est déjà en cours ou terminé." });
  job.status = "queued";
  job.error = null;
  job.phase = "Reprise en attente…";
  for (const image of job.images) {
    if (image.initialTask?.status === "failed" && !image.src && !activeTask(image.regeneration)) {
      image.initialTask.status = "queued";
      image.initialTask.attempts = 0;
      image.error = null;
    }
  }
  await queueSave(job);
  scheduleProject(job);
  res.status(202).json(toPublicProject(job));
});

app.delete("/api/projects/:id", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });

  if (["queued", "working"].includes(job.status) || job.images.some((image) => activeTask(image.regeneration)) || activeTask(job.export) ||
      activeTask(job.audioPreparation?.task) || audioQueue.hasProject(job.id) ||
      projectQueue.hasProject(job.id) || imageQueue.hasProject(job.id) || exportQueue.hasProject(job.id)) {
    return res.status(409).json({ error: "Ce projet a encore des tâches en cours. Attends leur fin avant de le supprimer." });
  }

  const root = path.resolve(projectsRoot);
  const projectDir = path.resolve(job.projectDir);
  if (projectDir === root || path.dirname(projectDir) !== root) {
    return res.status(400).json({ error: "Chemin de projet invalide." });
  }

  job.deleted = true;
  jobs.delete(job.id);

  try {
    await job.saveChain?.catch(() => {});
    await fs.promises.rm(projectDir, { recursive: true, force: true });
    res.status(204).end();
  } catch (error) {
    job.deleted = false;
    jobs.set(job.id, job);
    res.status(500).json({
      error: `Impossible de supprimer le projet : ${formatError(error)}`,
    });
  }
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
  if (await imageWork.regenerate(req, res, job) === true) res.status(202).json(toPublicProject(job));
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
  image.selectionRevision = (image.selectionRevision || 0) + 1;
  image.filename = version.filename;
  image.src = version.src;
  image.error = null;
  await queueSave(job);
  res.json(toPublicProject(job));
});

app.post("/api/projects/:id/scenes/:index/timing", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });

  const index = Number.parseInt(req.params.index, 10);
  const images = [...job.images].sort((a, b) => a.index - b.index);
  const position = images.findIndex((image) => image.index === index);
  if (position === -1) {
    return res.status(404).json({ error: "Scène introuvable." });
  }

  const requestedStart = Number(req.body?.start);
  if (!Number.isFinite(requestedStart)) {
    return res.status(400).json({ error: "Timestamp invalide." });
  }

  const audioDuration =
    job.audioDuration || job.words.at(-1)?.end || job.segments.at(-1)?.end || requestedStart;
  const previous = images[position - 1];
  const next = images[position + 1];
  const minimum = previous ? getImageStart(previous) + 0.05 : 0;
  const maximum = next
    ? getImageStart(next) - 0.05
    : Math.max(minimum, audioDuration - 0.05);
  const start =
    Math.round(
      Math.min(maximum, Math.max(minimum, requestedStart)) * 1000,
    ) / 1000;

  const image = images[position];
  const previousStart = getImageStart(image);
  image.timelineStart = start;
  job.timelineHistory = job.timelineHistory || [];
  job.timelineHistory.push({
    imageIndex: image.index,
    previousStart,
    start,
    updatedAt: new Date().toISOString(),
  });
  await queueSave(job);
  res.json(toPublicProject(job));
});

app.post("/api/projects/:id/export", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });
  if (!toPublicExport(job).canExport) return res.status(409).json({ error: "Toutes les scènes doivent avoir une image avant l’export." });
  await exportWork.request(job);
  res.status(activeTask(job.export) ? 202 : 200).json(toPublicProject(job));
});

app.get("/api/projects/:id/export", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });
  res.json(toPublicExport(job));
});

app.get("/api/projects/:id/download", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "Projet introuvable." });

  const outputPath = path.join(job.projectDir, job.export?.filename || "export.mp4");
  if (
    job.export?.status !== "ready" ||
    !fs.existsSync(outputPath)
  ) {
    return res.status(409).json({
      error: "Cet export n’est plus disponible ou doit être régénéré.",
    });
  }

  const safeTitle =
    job.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").trim() || "video";
  res.download(outputPath, `${safeTitle}.mp4`);
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(process.env.OPENAI_API_KEY) });
});

async function markJobFailed(job, error) {
  const failedPhase = job.phase;
  const failedProgress = job.progress;
  job.status = "failed";
  job.phase = "Échec";
  job.error = formatError(error);

  await logJob(job, "error", "pipeline.failed", "La génération du projet a échoué.", {
    failedPhase,
    failedProgress,
    error: getErrorDiagnostics(error),
  });

  try {
    await queueSave(job);
  } catch (saveError) {
    await logJob(
      job,
      "error",
      "project.save_failed",
      "Impossible d’enregistrer l’état d’échec du projet.",
      { error: getErrorDiagnostics(saveError) },
    );
  }
}

function scheduleProject(job) {
  void projectQueue.add({ id: job.id, projectId: job.id, run: () => runJob(job) })
    .catch((error) => markJobFailed(job, error));
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



function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(ffmpegPath, args, { windowsHide: true });
    let errorOutput = "";
    ffmpeg.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) return resolve();
      reject(
        new Error(
          `FFmpeg n’a pas pu créer la vidéo.${
            errorOutput ? ` ${errorOutput.trim()}` : ""
          }`,
        ),
      );
    });
  });
}

async function createVisualPrompts(
  openai,
  segments,
  visualFormat,
  backgroundColor,
) {
  const backgroundInstruction = getBackgroundColorInstruction(backgroundColor);
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

Style obligatoire pour toutes les scènes : dessin extrêmement simple et volontairement mauvais fait par un débutant dans MS Paint, ${backgroundInstruction}, contours noirs épais et tremblants, personnages bâtons, formes géométriques basiques, expressions simples, couleurs plates rares, beaucoup d'espace vide, aucune ombre, aucun dégradé, aucune 3D, aucun anime, aucun rendu professionnel.

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
          buildImagePrompt(
            segment,
            index,
            segments,
            visualFormat,
            backgroundColor,
          ),
        visualFormat.prompt,
        backgroundInstruction,
      ].join("\n\n"),
    })),
  };
}

async function createCompliantRetryImagePrompt(
  openai,
  job,
  segment,
  extraInstructions,
) {
  const instructions = `
Tu adaptes un prompt destiné à une illustration pédagogique lorsqu'une première génération d'image n'a pas abouti.
Réécris-le de façon concise, claire et conforme tout en conservant l'idée narrative, le style graphique, la composition, les couleurs et le format demandés.
Ne cherche jamais à contourner, dissimuler ou tromper un système de sécurité.
Supprime les formulations négatives, répétitives ou ambiguës qui ne sont pas indispensables à l'image.
Si un élément ne peut pas être représenté directement, remplace-le par une métaphore visuelle neutre, symbolique, non graphique et adaptée à tout public.
Le résultat doit être un prompt d'image autonome, uniquement descriptif, sans commentaire sur la réécriture ni sur les règles de sécurité.
`.trim();
  const response = await openai.responses.create({
    model: process.env.PROMPT_MODEL || "gpt-5.6-sol",
    reasoning: { effort: "none" },
    instructions,
    input: JSON.stringify({
      narration: segment.text,
      promptOriginal: segment.visualPrompt,
      instructionsUtilisateur: extraInstructions || null,
      contraintes: {
        style: "dessin de stickman très simple et volontairement amateur sous MS Paint",
        format: job.visualFormat.prompt,
        ratio: job.visualFormat.ratio,
        arrierePlan: getBackgroundColorInstruction(job.backgroundColor),
      },
    }),
    text: {
      format: {
        type: "json_schema",
        name: "compliant_image_retry_prompt",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            prompt: { type: "string" },
          },
          required: ["prompt"],
        },
      },
    },
  });

  const rewrittenPrompt = JSON.parse(response.output_text).prompt?.trim();
  if (!rewrittenPrompt) {
    throw new Error("La reformulation du prompt n’a produit aucun contenu.");
  }

  return {
    prompt: rewrittenPrompt,
    requestId: response._request_id || response.request_id || null,
  };
}

function getImageConcurrency() {
  return Math.max(1, Math.min(50, Number.parseInt(process.env.IMAGE_CONCURRENCY || "10", 10) || 10));
}

async function createSegments(openai, words) {
  const instructions = [
    "Tu es monteur vidéo.",
    "Regroupe une transcription horodatée en plans visuels cohérents.",
    `La durée de ${sceneMaxDuration} secondes est un maximum strict à ne jamais dépasser.`,
    "Quand plusieurs découpages cohérents sont possibles, privilégie les plans courts plutôt que les plans longs, sans couper artificiellement une idée ou une phrase.",
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

function buildImagePrompt(
  segment,
  index,
  segments,
  visualFormat,
  backgroundColor,
) {
  const previous = segments[index - 1]?.text || "aucun";
  const next = segments[index + 1]?.text || "aucun";
  const backgroundInstruction = getBackgroundColorInstruction(backgroundColor);

  return `
Crée une illustration qui explique visuellement ce passage exact d'une narration française :
"${segment.text}"

Contexte juste avant : "${previous}"
Contexte juste après : "${next}"

STYLE OBLIGATOIRE :
- dessin extrêmement simple et volontairement maladroit fait par un débutant dans MS Paint
- ${backgroundInstruction}
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

function parseBackgroundColor(name, hex) {
  const normalizedName = String(name || "blanc").trim().slice(0, 50);
  const normalizedHex = String(hex || "#FFFFFF").trim().toUpperCase();
  if (
    !normalizedName ||
    /[\r\n<>]/.test(normalizedName) ||
    !/^#[0-9A-F]{6}$/.test(normalizedHex)
  ) {
    return null;
  }
  return { name: normalizedName, hex: normalizedHex };
}

function getBackgroundColorInstruction(backgroundColor) {
  const color = backgroundColor || { name: "blanc", hex: "#FFFFFF" };
  return `fond entièrement rempli d’une couleur uniforme ${color.name} (${color.hex}), exactement cette couleur sur toute la surface, sans dégradé ni texture, avec beaucoup d’espace vide`;
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function formatError(error) {
  if (error?.status === 429) return "Limite API atteinte. Réessaie dans un instant.";
  return error?.error?.message || error?.message || "Une erreur inconnue est survenue.";
}

function getErrorDiagnostics(error) {
  const apiError = error?.error && typeof error.error === "object" ? error.error : {};
  const headers = error?.headers;
  const requestIdFromHeaders =
    headers && typeof headers.get === "function" ? headers.get("x-request-id") : null;
  const cause = error?.cause;

  return {
    name: error?.name || null,
    message:
      apiError.message || error?.message || "Une erreur inconnue est survenue.",
    status: error?.status || apiError.status || null,
    code: apiError.code || error?.code || null,
    type: apiError.type || error?.type || null,
    param: apiError.param || error?.param || null,
    requestId:
      error?.request_id ||
      error?.requestId ||
      error?._request_id ||
      requestIdFromHeaders ||
      null,
    cause:
      cause && cause !== error
        ? {
            name: cause.name || null,
            message: cause.message || String(cause),
            code: cause.code || null,
          }
        : null,
    stack: error?.stack || null,
  };
}

function redactLogValue(value) {
  if (typeof value === "string") {
    return value
      .replace(/sk-[a-zA-Z0-9_-]{8,}/g, "sk-[REDACTED]")
      .replace(/(Bearer\s+)[a-zA-Z0-9._-]+/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactLogValue(entry)]),
    );
  }
  return value;
}

function logJob(job, level, event, message, details = {}) {
  const entry = redactLogValue({
    timestamp: new Date().toISOString(),
    level,
    event,
    serverRunId,
    pid: process.pid,
    projectId: job?.id || null,
    phase: job?.phase || null,
    progress: job?.progress ?? null,
    message,
    ...details,
  });
  const line = JSON.stringify(entry);
  const print = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  print(`[generation] ${line}`);

  if (!job?.projectDir || job.deleted) return Promise.resolve();
  job.logChain = (job.logChain || Promise.resolve())
    .catch(() => {})
    .then(() =>
      fs.promises.appendFile(
        path.join(job.projectDir, diagnosticLogFilename),
        `${line}\n`,
        "utf8",
      ),
    )
    .catch((logError) => {
      console.error(
        `[generation] Impossible d’écrire ${diagnosticLogFilename} pour ${job.id}:`,
        logError,
      );
    });
  return job.logChain;
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

function getImageStart(image) {
  return Number.isFinite(image.timelineStart) ? image.timelineStart : image.start;
}

function getExportSignature(job) { return exportSignature(job, crypto); }

function toPublicExport(job) {
  const currentSignature = getExportSignature(job);
  const exportState = job.export || { status: "idle" };
  const isCurrent = exportState.signature === currentSignature;
  return {
    status: exportState.status,
    isCurrent,
    canExport: Boolean(job.audioFilename && job.images.length && job.images.every((image) => image.src && !image.error)),
    error: exportState.error || null,
    requestedAt: exportState.requestedAt || null,
    completedAt: exportState.completedAt || null,
    downloadUrl:
      exportState.status === "ready"
        ? `/api/projects/${job.id}/download`
        : null,
  };
}

function projectSnapshot(job) {
  return {
    version: 2,
    revision: job.revision || 0,
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
    audioDuration: job.audioDuration || null,
    audioPreparation: job.audioPreparation || null,
    queuedAt: job.queuedAt || null,
    source: job.source,
    sourceFilename: job.sourceFilename || null,
    pipeline: job.pipeline,
    timelineHistory: job.timelineHistory || [],
    export: job.export || null,
    visualFormat: job.visualFormat,
    backgroundColor: job.backgroundColor || {
      name: "blanc",
      hex: "#FFFFFF",
    },
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

function normalizeImageVersions(job, image) {
  if (!Number.isFinite(image.timelineStart)) {
    image.timelineStart = image.start;
  }
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
    export: toPublicExport(job),
    audioPreparation: publicAudioPreparation(job),
    audioUrl: snapshot.audioFilename
      ? `/api/projects/${job.id}/audio`
      : null,
  };
}

function queueSave(job) {
  if (job.deleted) return Promise.resolve();
  job.updatedAt = new Date().toISOString();
  job.revision = (job.revision || 0) + 1;
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
        timelineHistory: saved.timelineHistory || [],
        visualFormat: saved.visualFormat || getVisualFormat("horizontal"),
        backgroundColor: saved.backgroundColor || {
          name: "blanc",
          hex: "#FFFFFF",
        },
        projectDir,
        saveChain: Promise.resolve(),
        logChain: Promise.resolve(),
        images: saved.images || [],
        segments: saved.segments || [],
        words: saved.words || [],
        pipeline: saved.pipeline || {},
        revision: saved.revision || 0,
      };
      job.images = job.images.map((image) => normalizeImageVersions(job, image));
      ensureScenes(job);
      if (job.audioPreparation?.task?.status === "running") job.audioPreparation.task.status = "queued";
      for (const image of job.images) {
        for (const task of [image.initialTask, image.regeneration]) {
          if (task?.status === "running") task.status = "queued";
        }
      }
      if (["rendering", "running"].includes(job.export?.status) ||
          (job.export?.status === "failed" && job.export.error?.includes("redémarrage"))) {
        job.export.status = "queued";
        job.export.error = null;
      }
      if (["queued", "working"].includes(job.status) || job.phase === "Traitement interrompu") {
        job.status = "queued";
        job.phase = "Reprise en attente…";
        job.error = null;
      }
      await queueSave(job);
      jobs.set(job.id, job);
    } catch (error) {
      await logJob(
        null,
        "error",
        "project.load_failed",
        `Projet illisible ignoré : ${entry.name}`,
        { error: getErrorDiagnostics(error) },
      );
    }
  }
}

async function startServer() {
  await imageRateState.load();
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
    const ordered = [...jobs.values()].sort((a, b) => (a.queuedAt || a.createdAt).localeCompare(b.queuedAt || b.createdAt));
    for (const job of ordered) {
      if (job.status === "draft" && activeTask(job.audioPreparation?.task)) audioWork.schedule(job);
      for (const image of job.images) {
        if (activeTask(image.regeneration)) imageWork.scheduleImage(job, image, image.regeneration, false);
      }
      if (activeTask(job.export)) exportWork.schedule(job);
      if (job.status === "queued") scheduleProject(job);
    }
    void logJob(null, "info", "server.started", "Serveur Stickman Generator démarré.", {
      url: `http://localhost:${port}`,
      environment: process.env.NODE_ENV || "production",
      loadedProjects: jobs.size,
      imageModel: "gpt-image-2",
      imageQuality,
      imageReloadQuality,
      imageConcurrency: getImageConcurrency(),
    });
  });
}

process.on("uncaughtExceptionMonitor", (error, origin) => {
  void logJob(null, "error", "server.uncaught_exception", "Exception non interceptée.", {
    origin,
    error: getErrorDiagnostics(error),
  });
});

void startServer().catch((error) => {
  void logJob(null, "error", "server.start_failed", "Le serveur n’a pas pu démarrer.", {
    error: getErrorDiagnostics(error),
  });
  process.exitCode = 1;
});
