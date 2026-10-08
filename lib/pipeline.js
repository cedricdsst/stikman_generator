import fs from "node:fs";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { ensureScenes } from "./project-state.js";

export function createPipeline({ queueSave, logJob, isVideoFile, extractAudioAsMp3, createSegments, createVisualPrompts, generateInitial, sceneMaxDuration, imageQuality, imageReloadQuality, getImageConcurrency }) {
  return async function runJob(job) {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    job.status = "working";
    job.error = null;
    await logJob(job, "info", "pipeline.started", "Traitement ou reprise du projet.");
    if (!job.audioFilename || !fs.existsSync(path.join(job.projectDir, job.audioFilename))) {
      const sourcePath = path.join(job.projectDir, job.sourceFilename || "source-missing");
      if (!fs.existsSync(sourcePath)) throw new Error("Le fichier source est introuvable. Les données déjà produites sont conservées.");
      let media = { path: sourcePath, originalname: job.source.originalName, mimetype: job.source.mimeType };
      let extracted = false;
      if (isVideoFile(media)) {
        job.phase = "Extraction de l’audio…";
        job.progress = 2;
        await queueSave(job);
        media = await extractAudioAsMp3(media);
        extracted = true;
      }
      const stats = await fs.promises.stat(media.path);
      if (stats.size > 25 * 1024 * 1024) throw new Error("La piste audio dépasse 25 Mo.");
      const extension = path.extname(media.originalname).toLowerCase();
      job.audioFilename = `audio${[".mp3", ".wav", ".m4a", ".webm", ".mp4", ".mpeg", ".mpga"].includes(extension) ? extension : ".mp3"}`;
      job.audioMime = media.mimetype;
      await fs.promises.copyFile(media.path, path.join(job.projectDir, job.audioFilename));
      await queueSave(job);
      if (extracted) await fs.promises.unlink(media.path).catch(() => {});
    }
    if (!job.pipeline.transcription || !job.words.length) {
      job.phase = "Transcription mot à mot…";
      job.progress = 5;
      await queueSave(job);
      await logJob(job, "info", "transcription.started", "Transcription OpenAI démarrée.");
      const transcription = await openai.audio.transcriptions.create({
        file: await toFile(fs.createReadStream(path.join(job.projectDir, job.audioFilename)), job.audioFilename, { type: job.audioMime }),
        model: "whisper-1", response_format: "verbose_json", timestamp_granularities: ["word"],
      });
      job.words = (transcription.words || []).map((word, index) => ({ index, word: word.word, start: Number(word.start), end: Number(word.end) }));
      if (!job.words.length) throw new Error("Aucun mot horodaté n’a été détecté dans cet audio.");
      job.transcript = transcription.text;
      job.pipeline.transcription = { model: "whisper-1", text: transcription.text, words: job.words };
      await queueSave(job);
      await logJob(job, "info", "transcription.succeeded", "Transcription sauvegardée.", { wordCount: job.words.length });
    }
    if (!job.pipeline.segmentation || !job.segments.length) {
      job.phase = "Découpage du script en plans…";
      job.progress = 15;
      await queueSave(job);
      const segmentation = await createSegments(openai, job.words);
      job.segments = segmentation.segments;
      job.pipeline.segmentation = { model: process.env.SEGMENTATION_MODEL || "gpt-5.6-sol", maxSceneDuration: sceneMaxDuration, instructions: segmentation.instructions, response: segmentation.response };
      ensureScenes(job);
      await queueSave(job);
      await logJob(job, "info", "segmentation.succeeded", "Scènes disponibles pour le montage.", { sceneCount: job.segments.length });
    }
    ensureScenes(job);
    if (!job.pipeline.visualDirection || job.segments.some((segment) => !segment.visualPrompt)) {
      job.phase = "Création de la direction visuelle…";
      job.progress = 22;
      await queueSave(job);
      const direction = await createVisualPrompts(openai, job.segments, job.visualFormat, job.backgroundColor);
      job.segments = direction.segments;
      job.pipeline.visualDirection = { model: process.env.PROMPT_MODEL || "gpt-5.6-sol", instructions: direction.instructions, response: direction.response };
      await queueSave(job);
      await logJob(job, "info", "visual_direction.succeeded", "Prompts visuels sauvegardés.");
    }
    job.pipeline.imageGeneration ||= { model: "gpt-image-2", quality: imageQuality, reloadQuality: imageReloadQuality, size: job.visualFormat.imageSize, concurrency: getImageConcurrency() };
    await generateInitial(job);
    job.status = "completed";
    job.phase = "Terminé";
    job.progress = 100;
    await queueSave(job);
    await logJob(job, "info", "pipeline.completed", "Génération initiale terminée.", { successfulImages: job.images.filter((image) => image.src).length, failedImages: job.images.filter((image) => image.error).length });
  };
}
