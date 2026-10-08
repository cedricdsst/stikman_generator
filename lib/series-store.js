import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { loadImage, createCanvas } from "@napi-rs/canvas";

export function createSeriesStore(root) {
  const series = new Map();
  const publicSeries = (entry) => ({ id: entry.id, name: entry.name, createdAt: entry.createdAt, imageUrl: `/api/series/${entry.id}/image`, width: entry.width, height: entry.height });
  async function load() {
    await fs.mkdir(root, { recursive: true });
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const saved = JSON.parse(await fs.readFile(path.join(root, entry.name, "series.json"), "utf8"));
        if (saved.id !== entry.name) continue;
        await fs.access(path.join(root, entry.name, "image.png"));
        series.set(saved.id, saved);
      } catch (error) { console.error(`Dossier de série illisible : ${entry.name}`, error.message); }
    }
  }
  async function create(name, file) {
    const cleanName = typeof name === "string" ? name.trim().slice(0, 100) : "";
    if (!cleanName || !file) throw Object.assign(new Error("Le nom du dossier et son image sont obligatoires."), { status: 400 });
    let image;
    try { image = await loadImage(await fs.readFile(file.path)); }
    catch { throw Object.assign(new Error("Choisis une image PNG, JPEG ou WebP valide."), { status: 400 }); }
    if (!image.width || !image.height || image.width * image.height > 40_000_000) throw Object.assign(new Error("L’image est trop grande (40 millions de pixels maximum)."), { status: 400 });
    const canvas = createCanvas(image.width, image.height);
    canvas.getContext("2d").drawImage(image, 0, 0);
    const id = crypto.randomUUID();
    const folder = path.join(root, id);
    const entry = { id, name: cleanName, width: image.width, height: image.height, createdAt: new Date().toISOString() };
    await fs.mkdir(folder, { recursive: true });
    try {
      await fs.writeFile(path.join(folder, "image.png"), canvas.toBuffer("image/png"));
      await fs.writeFile(path.join(folder, "series.json"), JSON.stringify(entry, null, 2));
      series.set(id, entry);
    } catch (error) { await fs.rm(folder, { recursive: true, force: true }); throw error; }
    return publicSeries(entry);
  }
  return { load, create, get: (id) => series.get(id), list: () => [...series.values()].map(publicSeries), publicSeries,
    imagePath: (id) => path.join(root, id, "image.png") };
}
