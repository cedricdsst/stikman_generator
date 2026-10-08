import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { activeTask, ensureScenes } from "./project-state.js";

export function createImageWork({ imageQueue, queueSave, logJob, formatError, getErrorDiagnostics, normalizeImageVersions, createCompliantRetryImagePrompt, getBackgroundColorInstruction, imageQuality, imageReloadQuality, observeImageLimits, saveRateState }) {
  async function regenerate(req, res, job) {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: "OPENAI_API_KEY est absente." });
    const index = Number(req.params.index);
    const image = job.images.find((candidate) => candidate.index === index);
    if (!image || !job.segments[index]?.visualPrompt) return res.status(409).json({ error: "Cette scène n’est pas encore prête à être régénérée." });
    if (activeTask(image.initialTask) || activeTask(image.regeneration)) {
      return res.status(409).json({ error: "Une génération est déjà prévue pour cette scène." });
    }
    normalizeImageVersions(job, image);
    const reference = image.versions.find((version) => version.id === image.selectedVersionId);
    if (reference && !fs.existsSync(path.join(job.projectDir, "images", reference.filename))) {
      return res.status(404).json({ error: "L’image de référence est introuvable." });
    }
    const id = crypto.randomUUID();
    image.regeneration = {
      id, status: "queued", attempts: 0, createdAt: new Date().toISOString(),
      instructions: String(req.body?.instructions || "").trim().slice(0, 1500),
      referenceVersionId: reference?.id || null, referenceFilename: reference?.filename || null,
      selectionRevision: image.selectionRevision || 0,
      filename: `${String(index).padStart(4, "0")}-v-${id}.png`,
      versionId: `v-${id}`, quality: imageReloadQuality,
    };
    await queueSave(job);
    scheduleImage(job, image, image.regeneration, false);
    return true;
  }

  async function generateInitial(job) {
    ensureScenes(job);
    const pending = job.images.filter((image) => activeTask(image.initialTask));
    for (const image of pending) {
      Object.assign(image.initialTask, {
        filename: `${String(image.index).padStart(4, "0")}.png`, versionId: "original",
        prompt: job.segments[image.index].visualPrompt,
        quality: job.pipeline.imageGeneration.quality || imageQuality,
      });
    }
    refreshProgress(job);
    await queueSave(job);
    const results = await Promise.allSettled(pending.map((image) => scheduleImage(job, image, image.initialTask, true)));
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  function refreshProgress(job) {
    if (job.status !== "working") return;
    const completed = job.images.filter((image) => ["succeeded", "failed"].includes(image.initialTask?.status)).length;
    job.phase = `Génération : ${completed}/${job.segments.length} images terminées…`;
    job.progress = Math.round(30 + completed / Math.max(1, job.segments.length) * 70);
  }

  function scheduleImage(job, image, task, initial) {
    const work = imageQueue.add({
      id: task.id, projectId: job.id, priority: !initial, attempts: task.attempts || 0,
      availableAt: task.nextAttemptAt || 0,
      firstAttemptAt: task.firstAttemptAt || 0,
      onStart: async (attempt) => {
        task.status = "running";
        task.attempts = attempt;
        task.nextAttemptAt = null;
        task.error = null;
        task.firstAttemptAt ||= Date.now();
        await saveRateState();
        await queueSave(job);
        await logJob(job, "info", initial ? "image.started" : "image.regeneration_started", "Génération d’image démarrée.", { sceneIndex: image.index, taskId: task.id, attempt });
      },
      onRetry: async (error, _attempt, availableAt) => {
        task.status = "retrying";
        task.nextAttemptAt = availableAt;
        task.error = formatError(error);
        await saveRateState();
        await queueSave(job);
        await logJob(job, "warn", "image.retry_scheduled", "Nouvelle tentative programmée.", { sceneIndex: image.index, nextAttemptAt: availableAt, error: getErrorDiagnostics(error) });
      },
      run: () => executeImage(job, image, task, initial),
    }).catch(async (error) => {
      task.status = "failed";
      task.error = formatError(error);
      task.nextAttemptAt = null;
      if (initial && !image.src) image.error = task.error;
      refreshProgress(job);
      await queueSave(job);
      await logJob(job, "error", "image.failed", "Génération d’image échouée.", { sceneIndex: image.index, taskId: task.id, error: getErrorDiagnostics(error) });
    });
    // Detached HTTP requests still have durable outcomes and handled failures.
    void work.catch((error) => console.error("Impossible de sauvegarder une tâche image", error));
    return work;
  }

  async function executeImage(job, image, task, initial) {
    const filename = task.filename;
    const outputPath = path.join(job.projectDir, "images", filename);
    // Recover a complete PNG saved just before the manifest could be committed.
    if (!fs.existsSync(outputPath)) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
      if (!task.prompt) {
        if (task.referenceFilename) {
          task.prompt = [
            "Reproduis l’image de référence en conservant son style MS Paint amateur, la composition et l’identité des personnages, sauf les modifications demandées.",
            job.segments[image.index].visualPrompt,
            `Instructions : ${task.instructions || "Créer une variante très fidèle avec de petites différences de dessin."}`,
            job.visualFormat.prompt, getBackgroundColorInstruction(job.backgroundColor),
          ].join("\n\n");
        } else {
          const rewritten = await createCompliantRetryImagePrompt(openai, job, job.segments[image.index], task.instructions);
          task.prompt = rewritten.prompt;
        }
        await queueSave(job);
      }
      const options = { model: "gpt-image-2", prompt: task.prompt, size: job.visualFormat.imageSize, quality: task.quality, output_format: "png" };
      const request = task.referenceFilename
        ? openai.images.edit({ ...options, image: await toFile(fs.createReadStream(path.join(job.projectDir, "images", task.referenceFilename)), task.referenceFilename, { type: "image/png" }) })
        : openai.images.generate(options);
      const { data, response } = await request.withResponse();
      observeImageLimits(response.headers);
      await saveRateState();
      const base64 = data.data?.[0]?.b64_json;
      if (!base64) throw new Error("La réponse de l’API ne contient pas de donnée PNG.");
      const temporaryPath = `${outputPath}.tmp`;
      await fs.promises.writeFile(temporaryPath, Buffer.from(base64, "base64"));
      await fs.promises.rename(temporaryPath, outputPath);
      task.requestId = data._request_id || response.headers.get("x-request-id");
    }
    normalizeImageVersions(job, image);
    const version = {
      id: task.versionId, filename, src: `/api/projects/${job.id}/images/${filename}`,
      createdAt: new Date().toISOString(), basedOnVersionId: task.referenceVersionId || null,
      instructions: task.instructions || "", prompt: task.prompt, quality: task.quality,
    };
    if (!image.versions.some((candidate) => candidate.id === version.id)) image.versions.push(version);
    // A deliberate selection made while waiting takes precedence over auto-selection.
    if (!image.src || (image.selectionRevision || 0) === (task.selectionRevision || 0)) {
      image.selectedVersionId = version.id;
      image.filename = version.filename;
      image.src = version.src;
      image.error = null;
    }
    task.status = "succeeded";
    task.error = null;
    task.completedAt = new Date().toISOString();
    refreshProgress(job);
    await queueSave(job);
    await logJob(job, "info", initial ? "image.succeeded" : "image.regeneration_succeeded", "Image sauvegardée.", { sceneIndex: image.index, taskId: task.id, requestId: task.requestId });
  }

  return { regenerate, generateInitial, scheduleImage };
}
