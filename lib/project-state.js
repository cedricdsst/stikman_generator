export const activeTask = (task) => ["queued", "running", "retrying"].includes(task?.status);

export function ensureScenes(job) {
  const existing = new Map(job.images.map((image) => [image.index, image]));
  job.images = job.segments.map((segment, index) => {
    const image = existing.get(index) || {
      index, start: segment.start, end: segment.end, timelineStart: segment.start,
      timestamp: `${Math.floor(segment.start / 60)}:${String(Math.floor(segment.start % 60)).padStart(2, "0")}`,
      text: segment.text, versions: [], selectedVersionId: null,
    };
    image.description = (segment.text || "Illustration de la scène").replace(/\s+/g, " ").slice(0, 180);
    image.initialTask ||= {
      id: `${job.id}:initial:${index}`,
      status: image.src ? "succeeded" : image.error ? "failed" : "queued",
      attempts: 0,
    };
    return image;
  });
  return job.images;
}

export function exportSignature(job, crypto) {
  return crypto.createHash("sha256").update(JSON.stringify({
    audioFilename: job.audioFilename, visualFormat: job.visualFormat,
    ...(job.intro ? { intro: job.intro } : {}),
    ...(job.videoLayout ? { videoLayout: job.videoLayout } : {}),
    images: [...job.images].sort((a, b) => a.index - b.index).map((image) => ({
      index: image.index, filename: image.filename, start: image.timelineStart ?? image.start,
    })),
  })).digest("hex");
}
