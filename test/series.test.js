import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createHarness, projectFixture, until, wav } from "./helpers.js";
import { INTRO_DEFAULTS, VERTICAL_DEFAULTS } from "../video-defaults.js";
import { introCamera, normalizeIntro, imageRectangle } from "../lib/video-layout.js";

async function multipart(h, route, fields, image) {
  const body = new FormData();
  for (const [key, value] of Object.entries(fields)) body.set(key, value);
  if (image) body.set("image", new Blob([image], { type: "image/png" }), "series.png");
  const response = await fetch(`${h.url}${route}`, { method: "POST", body });
  return { status: response.status, data: await response.json() };
}

test("series require an image, persist on restart and create independent intros without changing generation", { timeout: 20_000 }, async (t) => {
  const h = await createHarness(); t.after(() => h.cleanup()); await h.start();
  assert.equal((await multipart(h, "/api/series", { name: "Sans image" })).status, 400);
  assert.equal((await multipart(h, "/api/series", { name: "" }, h.png)).status, 400);
  assert.equal((await multipart(h, "/api/series", { name: "Image invalide" }, Buffer.from("not an image"))).status, 400);
  const folder = await multipart(h, "/api/series", { name: "Une série" }, h.png);
  assert.equal(folder.status, 201);
  assert.equal((await fetch(`${h.url}${folder.data.imageUrl}`)).status, 200);
  const create = async (seriesId = "") => {
    const body = new FormData(); body.set("audio", new Blob([wav()], { type: "audio/wav" }), "episode.wav");
    body.set("format", "vertical"); body.set("seriesId", seriesId);
    const response = await fetch(`${h.url}/api/jobs`, { method: "POST", body });
    return { status: response.status, data: await response.json() };
  };
  assert.equal((await create("missing-folder")).status, 400);
  const a = await create(folder.data.id), b = await create(folder.data.id), standalone = await create();
  assert.equal(a.status, 202); assert.equal(b.status, 202);
  await until(() => h.pending().length > 0);
  let first = await h.get(a.data.id);
  assert.equal(first.intro.targetConfigured, false);
  for (const key of Object.keys(INTRO_DEFAULTS)) assert.equal(first.intro[key], INTRO_DEFAULTS[key]);
  assert.equal(first.visualFormat.imageSize, "1024x1280");
  assert.deepEqual(first.outputFormat, { width: 1080, height: 1920 });
  assert.equal((await h.post(`/api/projects/${a.data.id}/export`)).status, 409);
  assert.equal((await h.post(`/api/projects/${a.data.id}/composition`, { intro: "bad" })).status, 400);
  assert.equal((await h.post(`/api/projects/${a.data.id}/composition`, { intro: { zoom: "bad" } })).status, 400);
  const changed = await h.post(`/api/projects/${a.data.id}/composition`, { intro: { fullDuration: 0.6, zoom: 4, targetX: 0.8, targetY: 0.8, targetConfigured: true, filename: "../malicious.png" }, videoLayout: { imagePosition: 0.5, title: { text: "Épisode du jour", x: 0.4 } } });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.intro.filename, "series-intro.png");
  assert.equal((await h.get(b.data.id)).intro.fullDuration, INTRO_DEFAULTS.fullDuration);
  assert.equal((await h.get(standalone.data.id)).intro, null);
  h.autoImages = true; h.pending().forEach((record) => record.complete());
  await until(async () => (await h.get(standalone.data.id)).status === "completed");
  first = await h.get(a.data.id);
  assert.equal(first.images.length, first.segments.length);
  assert.equal(first.images[0].timelineStart, first.segments[0].start);
  assert.equal(first.export.canExport, true);
  await h.stop(); await h.start();
  const folders = await (await fetch(`${h.url}/api/series`)).json();
  assert.equal(folders.length, 1); assert.equal(folders[0].projectCount, 2);
  const restored = await h.get(a.data.id);
  assert.equal(restored.intro.fullDuration, 0.6); assert.equal(restored.intro.targetX, 0.8);
  assert.equal(restored.videoLayout.title.text, "Épisode du jour");
  assert.equal((await fetch(`${h.url}${restored.titleUrl}`)).headers.get("content-type"), "image/png");
});

test("camera reaches the exact selected viewport and keeps it inside the image", () => {
  const intro = normalizeIntro({ ...INTRO_DEFAULTS, zoom: 4, targetX: 0.99, targetY: -0.2 });
  assert.deepEqual(introCamera(intro, 0), { size: 1, x: 0, y: 0 });
  const end = introCamera(intro, 2);
  assert.equal(end.size, 0.25); assert.equal(end.x, 0.75); assert.equal(end.y, 0);
  const rect = imageRectangle({ visualFormat: { id: "vertical" }, videoLayout: { ...VERTICAL_DEFAULTS, imagePosition: 1, imageScale: 0.8 } });
  assert.equal(rect.width / rect.height, 4 / 5);
  assert.equal(rect.y + rect.height, 1920);
});

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [], errors = [];
    child.stdout.on("data", (data) => chunks.push(data)); child.stderr.on("data", (data) => errors.push(data));
    child.on("error", reject);
    child.on("close", (code) => code ? reject(new Error(Buffer.concat(errors).toString())) : resolve(Buffer.concat(chunks)));
  });
}
async function readFrame(filename, seconds) {
  const bytes = await run(["-hide_banner", "-loglevel", "error", "-ss", String(seconds), "-i", filename, "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
  const image = await loadImage(bytes); const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, context, pixel: (x, y) => [...context.getImageData(x, y, 1, 1).data] };
}

test("real MP4: full frame intro zooms to the chosen area, then reveals the current 4:5 scene and title; audio starts at zero", { timeout: 60_000 }, async (t) => {
  const h = await createHarness(); t.after(() => h.cleanup());
  const job = projectFixture("vertical-export", { count: 2 });
  job.audioDuration = 3;
  job.visualFormat = { id: "vertical", width: 1024, height: 1280, imageSize: "1024x1280", ratio: "4:5" };
  job.images[1].timelineStart = 1;
  job.videoLayout = { ...structuredClone(VERTICAL_DEFAULTS), title: { ...VERTICAL_DEFAULTS.title, text: "L’épisode : 100 % !", fontSize: 70 } };
  job.intro = normalizeIntro({ filename: "series-intro.png", fullDuration: 0.3, zoomDuration: 0.3, holdDuration: 0.8, zoom: 3, targetX: 5 / 6, targetY: 5 / 6, targetConfigured: true });
  await h.seed(job);
  const dir = path.join(h.projects, job.id);
  const canvas = createCanvas(540, 960); const context = canvas.getContext("2d");
  context.fillStyle = "#ffff00"; context.fillRect(0, 0, 540, 960);
  context.fillStyle = "#ff0000"; context.fillRect(360, 640, 180, 320);
  await fs.writeFile(path.join(dir, "images", "series-intro.png"), canvas.toBuffer("image/png"));
  const scene = createCanvas(320, 400);
  for (const [index, color] of [[0, "#00ff00"], [1, "#0000ff"]]) {
    scene.getContext("2d").fillStyle = color; scene.getContext("2d").fillRect(0, 0, 320, 400);
    await fs.writeFile(path.join(dir, "images", `${index}.png`), scene.toBuffer("image/png"));
  }
  const audio = wav(3);
  for (let sample = 0; sample < 1000; sample++) audio.writeInt16LE(Math.round(Math.sin(sample / 4) * 12000), 44 + sample * 2);
  await fs.writeFile(path.join(dir, "audio.wav"), audio);
  await h.start();
  assert.equal((await h.post(`/api/projects/${job.id}/export`)).status, 202);
  await h.post(`/api/projects/${job.id}/composition`, { intro: { targetX: 0.5 }, videoLayout: { title: { text: "Titre modifié pendant l’export" } } });
  const ready = await until(async () => { const state = await h.get(job.id); if (state.export.status === "failed") throw new Error(state.export.error); return state.export.status === "ready" && state; }, 45_000);
  assert.equal(ready.export.isCurrent, false);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "project.json")));
  assert.equal(manifest.export.snapshot.intro.targetX, 5 / 6);
  assert.equal(manifest.export.snapshot.videoLayout.title.text, "L’épisode : 100 % !");
  const movie = path.join(dir, manifest.export.filename);
  const wide = await readFrame(movie, 0.1), zoomed = await readFrame(movie, 0.9), revealed = await readFrame(movie, 1.7);
  assert.equal(wide.width, 1080); assert.equal(wide.height, 1920);
  assert.ok(wide.pixel(540, 960)[0] > 220 && wide.pixel(540, 960)[1] > 220, "whole introduction at the beginning");
  assert.ok(zoomed.pixel(540, 960)[0] > 220 && zoomed.pixel(540, 960)[1] < 30, "chosen red episode fills the frame after zoom");
  assert.ok(revealed.pixel(540, 960)[2] > 220 && revealed.pixel(540, 960)[0] < 30, "the second generated scene continues at its original timestamp");
  assert.ok(revealed.pixel(540, 1850).slice(0, 3).every((value) => value > 230), "space below the 4:5 illustration remains available");
  assert.ok(wide.pixel(540, 134)[1] > 220, "episode title is covered by the introduction");
  const band = revealed.context.getImageData(100, 70, 880, 130).data;
  assert.ok(band.some((value, index) => index % 4 !== 3 && value < 80), "episode title is present after the introduction");
  const pcm = await run(["-hide_banner", "-loglevel", "error", "-i", movie, "-vn", "-t", "0.1", "-f", "s16le", "-ar", "8000", "-ac", "1", "pipe:1"]);
  assert.ok(Array.from({ length: pcm.length / 2 }, (_, index) => Math.abs(pcm.readInt16LE(index * 2))).some((value) => value > 1000), "the original sound begins during the intro");
  const last = await readFrame(movie, 2.9);
  assert.equal(last.height, 1920, "the movie continues after the intro stream ends");
});
