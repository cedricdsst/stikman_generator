import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { activeTask } from "./project-state.js";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { FPS, imageRectangle, introFrames, outputFormat, verticalLayout } from "./video-layout.js";
import { renderTitle } from "./title-image.js";

export function createExportWork({ exportQueue, queueSave, runFfmpeg, getExportSignature, formatError }) {
  function snapshot(job) {
    return structuredClone({
      images: [...job.images].sort((a, b) => a.index - b.index).map((image) => ({
        index: image.index, filename: image.filename, start: image.timelineStart ?? image.start,
      })),
      audioFilename: job.audioFilename,
      duration: job.audioDuration || job.words.at(-1)?.end || job.segments.at(-1)?.end,
      visualFormat: job.visualFormat,
      ...(job.intro ? { intro: job.intro } : {}),
      ...(job.videoLayout ? { videoLayout: job.videoLayout } : {}),
      backgroundColor: job.backgroundColor,
    });
  }

  async function request(job) {
    if (activeTask(job.export)) return;
    const signature = getExportSignature(job);
    if (job.export?.status === "ready" && job.export.signature === signature &&
        fs.existsSync(path.join(job.projectDir, job.export.filename || "export.mp4"))) return;
    const id = crypto.randomUUID();
    job.export = { id, status: "queued", signature, snapshot: snapshot(job), filename: `export-${id}.mp4`,
      error: null, requestedAt: new Date().toISOString(), completedAt: null };
    await queueSave(job);
    schedule(job);
  }

  function schedule(job) {
    const task = job.export;
    task.id ||= crypto.randomUUID();
    // Legacy interrupted exports did not store a snapshot; restart from the saved edit.
    if (!task.snapshot) {
      task.snapshot = snapshot(job);
      task.signature = getExportSignature(job);
      task.filename = `export-${task.id}.mp4`;
    }
    void exportQueue.add({ id: task.id, projectId: job.id, run: async () => {
      task.status = "running";
      await queueSave(job);
      const resultPath = path.join(job.projectDir, task.filename);
      if (!fs.existsSync(resultPath)) await render(job, task);
      task.status = "ready";
      task.completedAt = new Date().toISOString();
      task.error = null;
      await queueSave(job);
    } }).catch(async (error) => {
      task.status = "failed";
      task.error = formatError(error);
      await queueSave(job);
    }).catch((error) => console.error("Impossible de sauvegarder l’export", error));
  }

  async function render(job, task) {
    const { images, audioFilename, duration } = task.snapshot;
    if (!images.length || images.some((image) => !image.filename)) throw new Error("Toutes les scènes doivent avoir une image avant l’export.");
    const concatPath = path.join(job.projectDir, `export-${task.id}.txt`);
    const temporaryPath = path.join(job.projectDir, `export-${task.id}.partial.mp4`);
    const blankPath = path.join(job.projectDir, `export-${task.id}-blank.png`);
    const introPath = path.join(job.projectDir, `export-${task.id}-intro.png`);
    const titlePath = path.join(job.projectDir, `export-${task.id}-title.png`);
    const escapePath = (filename) => filename.replaceAll("\\", "/").replaceAll("'", "'\\''");
    const imagePath = (image) => escapePath(path.join(job.projectDir, "images", image.filename));
    const lines = [];
    // A shifted first scene leaves the same empty lead-in as the preview.
    if (images[0].start > 0) lines.push(`file '${escapePath(blankPath)}'`, `duration ${images[0].start.toFixed(3)}`);
    images.forEach((image, index) => {
      const start = image.start;
      const end = images[index + 1]?.start ?? duration;
      lines.push(`file '${imagePath(image)}'`, `duration ${Math.max(0.05, end - start).toFixed(3)}`);
    });
    lines.push(`file '${imagePath(images.at(-1))}'`);
    try {
      // An opaque white RGB PNG keeps the concat stream in the same image codec.
      if (images[0].start > 0) await fs.promises.writeFile(blankPath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC", "base64"));
      await fs.promises.writeFile(concatPath, `${lines.join("\n")}\n`, "utf8");
      const frame = outputFormat(task.snapshot);
      const rectangle = imageRectangle(task.snapshot);
      const { width, height } = frame;
      const background = verticalLayout(task.snapshot) || task.snapshot.intro ? task.snapshot.backgroundColor?.hex || "#FFFFFF" : "white";
      const inputArgs = [
        "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatPath,
        "-i", path.join(job.projectDir, audioFilename),
      ];
      const filters = [`[0:v]scale=${rectangle.width}:${rectangle.height}:force_original_aspect_ratio=decrease,pad=${rectangle.width}:${rectangle.height}:(ow-iw)/2:(oh-ih)/2:color=${background},fps=${FPS},setsar=1,pad=${width}:${height}:${rectangle.x}:${rectangle.y}:color=${background}[base]`];
      let current = "base", nextInput = 2;
      if (verticalLayout(task.snapshot) && task.snapshot.videoLayout.title.text.trim()) {
        await fs.promises.writeFile(titlePath, renderTitle(task.snapshot));
        inputArgs.push("-loop", "1", "-framerate", String(FPS), "-i", titlePath);
        filters.push(`[${current}][${nextInput++}:v]overlay=0:0:shortest=1[title]`);
        current = "title";
      }
      if (task.snapshot.intro) {
        const intro = task.snapshot.intro;
        // Normalize the complete series image to the output frame before moving
        // the camera. Oversampling reduces rounding artefacts during the zoom.
        const canvas = createCanvas(width * 2, height * 2);
        const context = canvas.getContext("2d");
        const image = await loadImage(path.join(job.projectDir, "images", intro.filename));
        const scale = Math.min(canvas.width / image.width, canvas.height / image.height);
        context.fillStyle = background;
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, (canvas.width - image.width * scale) / 2, (canvas.height - image.height * scale) / 2, image.width * scale, image.height * scale);
        await fs.promises.writeFile(introPath, canvas.toBuffer("image/png"));
        inputArgs.push("-loop", "1", "-framerate", String(FPS), "-t", String(introFrames(intro) / FPS), "-i", introPath);
        const p = `min(1,max(0,(on/${FPS}-${intro.fullDuration})/${intro.zoomDuration}))`;
        const ease = `(${p}*${p}*(3-2*${p}))`;
        const zoom = `1/(1+(${1 / intro.zoom}-1)*${ease})`;
        filters.push(`[${nextInput}:v]zoompan=z='${zoom}':x='iw*${intro.targetX - 0.5 / intro.zoom}*${ease}':y='ih*${intro.targetY - 0.5 / intro.zoom}*${ease}':d=1:s=${width}x${height}:fps=${FPS}[intro]`);
        filters.push(`[${current}][intro]overlay=0:0:enable='lt(n,${introFrames(intro)})':eof_action=pass:repeatlast=0[composite]`);
        current = "composite";
      }
      filters.push(`[${current}]format=yuv420p[out]`);
      await runFfmpeg([
        ...inputArgs, "-filter_complex", filters.join(";"), "-map", "[out]", "-map", "1:a:0", "-t", String(duration),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", temporaryPath,
      ]);
      await fs.promises.rename(temporaryPath, path.join(job.projectDir, task.filename));
    } finally {
      await fs.promises.rm(concatPath, { force: true }).catch(() => {});
      await fs.promises.rm(blankPath, { force: true }).catch(() => {});
      await fs.promises.rm(introPath, { force: true }).catch(() => {});
      await fs.promises.rm(titlePath, { force: true }).catch(() => {});
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  return { request, schedule };
}
