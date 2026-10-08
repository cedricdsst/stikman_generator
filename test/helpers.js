import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { deflateSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";

export async function until(predicate, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error("Timed out waiting for test state");
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 2;
export const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 235, 220, 170, 235, 220, 170, 0, 235, 220, 170, 235, 220, 170]))), chunk("IEND", Buffer.alloc(0))]);

export function wav(seconds = 8) {
  const audio = Buffer.alloc(44 + seconds * 8000 * 2);
  audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
  return audio;
}

export function projectFixture(id, { status = "completed", count = 4, ready = count } = {}) {
  const segments = Array.from({ length: count }, (_, index) => ({ start: index * 2, end: (index + 1) * 2, text: `Scène ${index + 1} : le personnage présente son idée.`, visualPrompt: `${id}-scene-${index}` }));
  return {
    version: 2, id, title: `Projet ${id}`, status, phase: status === "completed" ? "Terminé" : "Génération…", progress: status === "completed" ? 100 : 30,
    revision: 1, createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-01T10:00:00.000Z",
    audioFilename: "audio.wav", audioMime: "audio/wav", source: { originalName: "test.wav", mimeType: "audio/wav" },
    transcript: "Transcription de test", words: segments.map((segment, index) => ({ index, word: segment.text, start: segment.start, end: segment.end })), segments,
    images: segments.map((segment, index) => ({
      index, ...segment, timestamp: `0:0${index * 2}`, timelineStart: segment.start,
      ...(index < ready ? { filename: `${index}.png`, src: `/api/projects/${id}/images/${index}.png`, selectedVersionId: "original", versions: [{ id: "original", filename: `${index}.png` }] } : { versions: [] }),
      initialTask: { id: `${id}:initial:${index}`, status: index < ready ? "succeeded" : "queued", attempts: 0 },
    })),
    pipeline: { transcription: { done: true }, segmentation: { done: true }, visualDirection: { done: true }, imageGeneration: { quality: "medium" } },
    visualFormat: { id: "horizontal", label: "Horizontal 16:9", width: 320, height: 180, imageSize: "1536x864", ratio: "16:9", prompt: "Horizontal 16:9" },
    backgroundColor: { name: "blanc", hex: "#FFFFFF" }, timelineHistory: [],
  };
}

export async function createHarness({ concurrency = 3 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "stickman-queue-test-"));
  const projects = path.join(root, "projects");
  await fs.mkdir(projects);
  const records = [];
  let active = 0;
  let peak = 0;
  let autoImages = false;
  const fake = http.createServer(async (req, res) => {
    let body = "";
    for await (const data of req) body += data.toString();
    const record = { url: req.url, body, res, finished: false };
    records.push(record);
    const json = (value, status = 200) => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); record.finished = true;
    };
    if (req.url.startsWith("/v1/images/")) {
      active++; peak = Math.max(peak, active);
      res.on("close", () => { active--; record.closed = true; });
      record.complete = (status = 200, error = null) => json(status === 200 ? { data: [{ b64_json: png.toString("base64") }] } : { error: error || { message: "Temporary limit", type: "rate_limit_error", code: "rate_limit_exceeded" } }, status);
      if (autoImages) record.complete();
    } else if (req.url === "/v1/audio/transcriptions") {
      json({ text: "Un personnage avance puis présente une idée.", words: Array.from({ length: 8 }, (_, index) => ({ word: `mot${index}`, start: index, end: index + 1 })) });
    } else if (req.url === "/v1/responses") {
      const input = JSON.parse(body);
      const type = input.text.format.name;
      const value = type === "video_segments" ? { segments: Array.from({ length: 4 }, (_, index) => ({ firstWord: index * 2, lastWord: index * 2 + 1 })) }
        : type === "visual_storyboard" ? { styleBible: "Personnage bâton", scenes: JSON.parse(input.input).map((scene) => ({ index: scene.index, visualPrompt: `Illustration ${scene.index}` })) }
          : { prompt: "Une illustration pédagogique simple" };
      json({ id: "resp_test", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(value), annotations: [] }] }] });
    } else json({ error: { message: "Unexpected fake API endpoint" } }, 404);
  });
  fake.listen(0, "127.0.0.1"); await once(fake, "listening");
  let child;
  let port;
  let output = "";
  const harness = {
    root, projects, records, png,
    get peak() { return peak; },
    get url() { return `http://127.0.0.1:${port}`; },
    set autoImages(value) { autoImages = value; },
    pending() { return records.filter((record) => record.complete && !record.finished && !record.closed); },
    async seed(project) {
      const dir = path.join(projects, project.id);
      await fs.mkdir(path.join(dir, "images"), { recursive: true });
      await fs.writeFile(path.join(dir, "audio.wav"), wav());
      for (const image of project.images) {
        for (const version of image.versions || []) await fs.writeFile(path.join(dir, "images", version.filename), png);
      }
      await fs.writeFile(path.join(dir, "project.json"), JSON.stringify(project));
    },
    async start() {
      const listener = http.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
      port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
      output = "";
      child = spawn(process.execPath, ["server.js"], {
        cwd: path.resolve(import.meta.dirname, ".."), windowsHide: true,
        env: { ...process.env, OPENAI_API_KEY: "test-key-not-real", OPENAI_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`,
          PROJECTS_ROOT: projects, UPLOADS_ROOT: path.join(root, "uploads"), IMAGE_CONCURRENCY: String(concurrency), IMAGE_REQUESTS_PER_MINUTE: "60000", MAX_SCENE_DURATION: "2.5", NODE_ENV: "production", PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", (data) => { output = (output + data).slice(-30_000); });
      child.stderr.on("data", (data) => { output = (output + data).slice(-30_000); });
      try {
        await until(async () => {
          if (child.exitCode !== null) throw new Error(output);
          try { return (await fetch(`${harness.url}/api/health`, { signal: AbortSignal.timeout(300) })).ok; } catch { return false; }
        });
      } catch (error) { throw new Error(`${error.message}\n${output}`); }
    },
    async stop() {
      if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
      child = null;
    },
    async get(id) { return (await fetch(`${harness.url}/api/projects/${id}`)).json(); },
    async post(url, body = {}) {
      const response = await fetch(`${harness.url}${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    },
    async create(name) {
      const body = new FormData(); body.set("audio", new Blob([wav()], { type: "audio/wav" }), name); body.set("format", "horizontal");
      const response = await fetch(`${harness.url}/api/jobs`, { method: "POST", body });
      if (response.status !== 202) throw new Error(await response.text());
      return (await response.json()).id;
    },
    async cleanup() {
      await harness.stop();
      fake.closeAllConnections();
      await new Promise((resolve) => fake.close(resolve));
      const resolved = path.resolve(root);
      if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("stickman-queue-test-")) throw new Error("Unsafe test cleanup path");
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return harness;
}
