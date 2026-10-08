import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { activeTask } from "./project-state.js";
import { analyzeAudio, processAudio, encodePreview } from "./audio-humanifier/audio.js";
import { defaultAudioSettings, parseAudioSettings } from "./audio-humanifier/settings.js";

const exists = (filename) => fs.access(filename).then(() => true, () => false);
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

export function newAudioPreparation() {
  return { settings: { ...defaultAudioSettings }, versions: [], selectedVersionId: "original",
    original: null, task: { id: crypto.randomUUID(), kind: "import", status: "queued", createdAt: new Date().toISOString() } };
}

export function publicAudioPreparation(job) {
  const preparation = job.audioPreparation;
  if (!preparation) return null;
  const media = (version) => version ? { ...version,
    previewUrl: `/api/projects/${job.id}/audio-preparation/${version.id}/listen`,
    downloadUrl: `/api/projects/${job.id}/audio-preparation/${version.id}/download`,
  } : null;
  return { ...preparation, original: media(preparation.original), versions: preparation.versions.map(media) };
}

export function createAudioWork({ audioQueue, queueSave, logJob, formatError }) {
  function editable(job) {
    if (job.status !== "draft" || !job.audioPreparation) throw fail("L’audio est déjà validé pour la génération.");
    if (activeTask(job.audioPreparation.task)) throw fail("Un traitement audio est déjà en cours ou en attente.");
  }

  async function saveSettings(job, input) {
    editable(job);
    let settings;
    try { settings = parseAudioSettings(input.settings); }
    catch (error) { throw fail(error.message, 400); }
    const preparation = job.audioPreparation;
    const id = input.selectedVersionId ?? preparation.selectedVersionId;
    if (id !== "original" && !preparation.versions.some((version) => version.id === id)) throw fail("Version audio introuvable.", 400);
    preparation.settings = settings;
    preparation.selectedVersionId = id;
    await queueSave(job);
  }

  async function request(job, input) {
    editable(job);
    let settings;
    try { settings = parseAudioSettings(input.settings ?? job.audioPreparation.settings); }
    catch (error) { throw fail(error.message, 400); }
    const preparation = job.audioPreparation;
    preparation.settings = settings;
    preparation.task = { id: crypto.randomUUID(), kind: preparation.original ? "process" : "import",
      status: "queued", settings: { ...settings }, createdAt: new Date().toISOString() };
    job.phase = "Traitement audio en attente…";
    await queueSave(job);
    schedule(job);
  }

  function schedule(job) {
    const preparation = job.audioPreparation;
    const task = preparation?.task;
    if (!task || job.status !== "draft" || !activeTask(task)) return;
    const promise = audioQueue.add({
      id: task.id, projectId: job.id,
      onStart: async () => {
        task.status = "running"; task.error = null;
        job.phase = task.kind === "import" ? "Préparation de l’audio…" : "Humanisation de l’audio…";
        await queueSave(job);
      },
      run: async () => {
        const sourcePath = path.join(job.projectDir, job.sourceFilename);
        const sourceAnalysis = preparation.sourceAnalysis || await analyzeAudio(sourcePath);
        if (!(sourceAnalysis.durationSeconds > 0) || sourceAnalysis.durationSeconds > 1800) {
          throw new Error("Choisis un fichier avec une piste audio valide de 30 minutes maximum.");
        }
        preparation.sourceAnalysis = sourceAnalysis;
        const isImport = task.kind === "import";
        const id = isImport ? "original" : task.id;
        const filename = isImport ? job.sourceFilename : `humanified-${id}.wav`;
        const previewFilename = isImport ? "audio-original.mp3" : `humanified-${id}.mp3`;
        const outputPath = path.join(job.projectDir, filename);
        const previewPath = path.join(job.projectDir, previewFilename);
        if (!isImport && !await exists(outputPath)) {
          const temporary = path.join(job.projectDir, `audio-${crypto.randomUUID()}.partial.wav`);
          try {
            await processAudio({ inputPath: sourcePath, ...task.settings }, temporary);
            await fs.rename(temporary, outputPath);
          } finally { await fs.rm(temporary, { force: true }); }
        }
        if (!await exists(previewPath)) {
          const temporary = path.join(job.projectDir, `audio-${crypto.randomUUID()}.partial.mp3`);
          try {
            await encodePreview(outputPath, temporary);
            await fs.rename(temporary, previewPath);
          } finally { await fs.rm(temporary, { force: true }); }
        }
        const analysis = await analyzeAudio(previewPath);
        if (analysis.inputBytes > 25 * 1024 * 1024) throw new Error("La piste finale dépasse 25 Mo. Réduis la durée du fichier source.");
        const version = { id, filename, previewFilename, analysis, settings: isImport ? null : task.settings,
          createdAt: new Date().toISOString(), qualityWarning: analysis.maxVolumeDb !== null && analysis.maxVolumeDb > -1 ? "Le pic de sortie dépasse −1 dBFS." : null };
        if (isImport) preparation.original = version;
        else if (!preparation.versions.some((entry) => entry.id === id)) preparation.versions.push(version);
        preparation.selectedVersionId = id;
        task.status = "succeeded";
        job.phase = "Audio à écouter et à valider";
        await queueSave(job);
        await logJob(job, "info", "audio.prepared", "Version audio prête à écouter.", { versionId: id });
      },
    });
    void promise.catch(async (error) => {
      task.status = "failed";
      task.error = formatError(error);
      job.phase = "Traitement audio à reprendre";
      await queueSave(job);
      await logJob(job, "error", "audio.failed", "Échec du traitement audio.", { error: task.error });
    }).catch(console.error);
    return promise;
  }

  async function approve(job, versionId) {
    // Retrying a lost HTTP response must not enqueue the project twice.
    if (job.audioPreparation?.approvedVersionId) {
      if (job.audioPreparation.approvedVersionId === versionId) return;
      throw fail("L’audio de ce projet a déjà été validé.");
    }
    editable(job);
    if (!process.env.OPENAI_API_KEY) throw fail("OPENAI_API_KEY est absente. Ajoute-la dans le fichier .env.", 400);
    const preparation = job.audioPreparation;
    const selected = versionId === "original" ? preparation.original : preparation.versions.find((version) => version.id === versionId);
    if (!selected) throw fail("Écoute et choisis une version prête avant de lancer la vidéo.", 400);
    // Files are immutable and created before the version is saved in the manifest.
    job.audioFilename = selected.previewFilename;
    job.audioMime = "audio/mpeg";
    job.audioDuration = selected.analysis.durationSeconds;
    preparation.approvedVersionId = versionId;
    preparation.selectedVersionId = versionId;
    preparation.approvedAt = new Date().toISOString();
    job.queuedAt = preparation.approvedAt;
    job.status = "queued";
    job.phase = "En attente du projet précédent…";
    await queueSave(job);
  }

  return { saveSettings, request, schedule, approve };
}
