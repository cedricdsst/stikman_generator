import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHarness, projectFixture, until, wav } from "./helpers.js";
import { defaultAudioSettings, parseAudioSettings } from "../lib/audio-humanifier/settings.js";
import { planSegments } from "../lib/audio-humanifier/segments.js";
import { newAudioPreparation } from "../lib/audio-work.js";

function voiceFixture() {
  const buffer = wav(8);
  // Synthetic voiced regions separated by two long silences; no external audio/API.
  for (let index = 0; index < 8 * 8000; index++) {
    const second = index / 8000;
    if (second < 1.5 || (second > 3.5 && second < 5) || second > 7) {
      buffer.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 260 * second)), 44 + index * 2);
    }
  }
  return buffer;
}

async function importDraft(h, contents = voiceFixture(), name = "voix.wav") {
  const body = new FormData(); body.set("audio", new Blob([contents], { type: "audio/wav" }), name); body.set("prepareAudio", "true");
  const response = await fetch(`${h.url}/api/jobs`, { method: "POST", body });
  assert.equal(response.status, 202);
  return (await response.json()).id;
}
const done = async (h, id) => until(async () => {
  const project = await h.get(id);
  if (project.audioPreparation.task.status === "failed") throw new Error(project.audioPreparation.task.error);
  return project.audioPreparation.task.status === "succeeded" && project;
}, 20_000);

test("AudioHumanifier validates settings, preserves short pauses and never lengthens a reduced silence", () => {
  for (const input of [{ speed: 121 }, { minimumPauseMs: 0 }, { intensity: NaN }, { localVariations: "false" }, { preset: "unknown" }]) {
    assert.throws(() => parseAudioSettings(input));
  }
  for (let seed = 0; seed < 100; seed++) {
    const parts = planSegments(4, [{ start: 1, end: 1.1 }, { start: 2, end: 3 }], { ...defaultAudioSettings, pauseReduction: 1, seed });
    assert.equal(parts[1].outputDuration, parts[1].end - parts[1].start);
    assert.ok(parts[3].outputDuration <= 1);
  }
});

test("audio previews run alongside images; approval freezes the selected audio for transcription and montage", async (t) => {
  const h = await createHarness({ concurrency: 1 }); t.after(() => h.cleanup());
  await h.seed(projectFixture("background", { status: "queued", ready: 0 }));
  await h.start(); await until(() => h.pending().length === 1);
  const id = await importDraft(h);
  let project = await done(h, id);
  assert.equal(project.status, "draft");
  assert.equal(project.images.length, 0);
  assert.equal(h.records.length, 1, "local preparation does not call OpenAI or cancel the existing request");
  assert.equal(h.pending().length, 1);
  const range = await fetch(`${h.url}${project.audioPreparation.original.previewUrl}`, { headers: { range: "bytes=0-99" } });
  assert.equal(range.status, 206); assert.equal((await range.arrayBuffer()).byteLength, 100);
  const endpoint = `/api/projects/${id}/audio-preparation`;
  assert.equal((await h.post(`${endpoint}/process`, { settings: { speed: 500 } })).status, 400);
  const settings = { ...defaultAudioSettings, intensity: 0, speed: 100, pauseReduction: 100, localVariations: false };
  const original = await fs.readFile(path.join(h.projects, id, project.sourceFilename));
  assert.equal((await h.post(`${endpoint}/process`, { settings })).status, 202);
  assert.equal((await h.post(`${endpoint}/process`, { settings })).status, 409);
  assert.equal((await h.post(`${endpoint}/approve`, { versionId: "original" })).status, 409);
  assert.equal((await fetch(`${h.url}/api/projects/${id}`, { method: "DELETE" })).status, 409);
  project = await done(h, id);
  const first = project.audioPreparation.versions[0];
  assert.ok(first.analysis.durationSeconds < project.audioPreparation.original.analysis.durationSeconds - 1.5, "long pauses must actually shrink");
  assert.ok(first.analysis.durationSeconds > 3, "voiced segments must remain");
  assert.deepEqual(await fs.readFile(path.join(h.projects, id, project.sourceFilename)), original);
  const firstBytes = await fs.readFile(path.join(h.projects, id, first.filename));
  await h.post(`${endpoint}/process`, { settings });
  project = await done(h, id);
  assert.equal(project.audioPreparation.versions.length, 2);
  assert.deepEqual(await fs.readFile(path.join(h.projects, id, project.audioPreparation.versions[1].filename)), firstBytes, "each attempt starts from the unmodified original");
  await h.post(`${endpoint}/settings`, { settings, selectedVersionId: first.id });
  await h.stop(); await h.start();
  project = await h.get(id);
  assert.equal(project.status, "draft", "restart must not approve a draft");
  assert.equal(project.audioPreparation.selectedVersionId, first.id);
  assert.deepEqual(project.audioPreparation.settings, settings);
  const approved = await h.post(`${endpoint}/approve`, { versionId: first.id });
  assert.equal(approved.status, 202);
  assert.equal(approved.data.audioFilename, first.previewFilename);
  assert.equal(approved.data.audioDuration, first.analysis.durationSeconds);
  assert.equal((await h.post(`${endpoint}/approve`, { versionId: first.id })).status, 202);
  assert.equal((await h.post(`${endpoint}/approve`, { versionId: "original" })).status, 409);
  assert.equal((await h.post(`${endpoint}/process`, { settings })).status, 409);
  assert.equal((await h.post(`${endpoint}/settings`, { settings })).status, 409);
  h.autoImages = true;
  for (const request of h.pending()) request.complete();
  await until(async () => (await h.get(id)).status === "completed");
  const transcription = h.records.filter((record) => record.url === "/v1/audio/transcriptions");
  assert.equal(transcription.length, 1);
  assert.ok(transcription[0].body.includes(`filename="${first.previewFilename}"`), "Whisper receives the approved result, not the original");
  const playback = Buffer.from(await (await fetch(`${h.url}/api/projects/${id}/audio`)).arrayBuffer());
  assert.deepEqual(playback, await fs.readFile(path.join(h.projects, id, first.previewFilename)));
});

test("interrupted audio processing resumes; an invalid import remains a draft and does not block the audio queue", async (t) => {
  const h = await createHarness(); t.after(() => h.cleanup());
  const draft = projectFixture("recover-audio", { status: "draft", count: 0 });
  draft.audioFilename = null; draft.pipeline = {}; draft.sourceFilename = "source.wav";
  draft.audioPreparation = newAudioPreparation(); draft.audioPreparation.task.status = "running";
  await h.seed(draft);
  await fs.writeFile(path.join(h.projects, draft.id, "source.wav"), voiceFixture());
  await h.start(); let project = await done(h, draft.id);
  assert.equal(project.status, "draft");
  await h.stop();
  const manifest = path.join(h.projects, draft.id, "project.json");
  const saved = JSON.parse(await fs.readFile(manifest, "utf8"));
  saved.audioPreparation.task = { id: "interrupted-render", kind: "process", status: "running", settings: { ...defaultAudioSettings } };
  await fs.writeFile(manifest, JSON.stringify(saved));
  await h.start(); project = await done(h, draft.id);
  assert.equal(project.audioPreparation.versions[0].id, "interrupted-render");
  assert.deepEqual(project.audioPreparation.versions[0].settings, defaultAudioSettings);
  const badId = await importDraft(h, Buffer.from("Not audio"), "invalid.wav");
  const goodId = await importDraft(h);
  await until(async () => (await h.get(badId)).audioPreparation.task.status === "failed");
  assert.equal((await h.get(badId)).status, "draft");
  await done(h, goodId);
  assert.equal(h.records.length, 0);
  assert.equal((await h.post(`/api/projects/${badId}/audio-preparation/approve`, { versionId: "original" })).status, 400);
  assert.equal((await h.post(`/api/projects/${goodId}/audio-preparation/approve`, { versionId: "does-not-exist" })).status, 400);
});
