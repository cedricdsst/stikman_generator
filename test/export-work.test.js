import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createHarness, projectFixture, until } from "./helpers.js";
import { TaskQueue } from "../lib/task-queue.js";
import { createExportWork } from "../lib/export-work.js";
import { exportSignature } from "../lib/project-state.js";
import { rateState } from "../lib/rate-state.js";

test("exports are serial and immutable, repeated clicks do not start another writer", async (t) => {
  const h = await createHarness(); t.after(() => h.cleanup());
  const a = projectFixture("export-a"), b = projectFixture("export-b");
  a.images[0].timelineStart = 0.5;
  a.audioDuration = 10; // The approved track can include a pause after the last word (at 8 s).
  for (const job of [a, b]) { await h.seed(job); job.projectDir = path.join(h.projects, job.id); }
  const started = [];
  const releases = [];
  const exportQueue = new TaskQueue();
  const work = createExportWork({ exportQueue, queueSave: async () => {}, formatError: (error) => error.message,
    getExportSignature: (job) => exportSignature(job, crypto),
    runFfmpeg: async (args) => {
      started.push(await fs.readFile(args[args.indexOf("-i") + 1], "utf8"));
      await new Promise((resolve) => releases.push(resolve));
      await fs.writeFile(args.at(-1), "test movie");
    },
  });
  await work.request(a);
  const exportId = a.export.id;
  await until(() => started.length === 1);
  assert.ok(started[0].includes("-blank.png"));
  assert.ok(started[0].includes("duration 0.500"));
  assert.equal(a.export.snapshot.duration, 10);
  assert.ok(started[0].includes("duration 4.000"), "the last image covers the complete approved audio");
  a.images[1].timelineStart = 1.2;
  a.images[0].filename = "replacement.png";
  await work.request(a); await work.request(b);
  assert.equal(a.export.id, exportId);
  assert.equal(a.export.snapshot.images[1].start, 2);
  assert.equal(a.export.snapshot.images[0].filename, "0.png");
  assert.equal(started.length, 1);
  assert.equal(b.export.status, "queued");
  releases[0]();
  await until(() => started.length === 2);
  assert.equal(a.export.status, "ready");
  releases[1]();
  await until(() => b.export.status === "ready");
  assert.notEqual(a.export.filename, b.export.filename);
});

test("saved rate window survives restart", async (t) => {
  const h = await createHarness(); t.after(() => h.cleanup());
  const filename = path.join(h.root, "rate.json");
  const first = new TaskQueue(); first.starts = [Date.now() - 20_000]; first.cooldownUntil = Date.now() + 30_000;
  await rateState(first, filename).save();
  const second = new TaskQueue(); await rateState(second, filename).load();
  assert.deepEqual(second.starts, first.starts);
  assert.equal(second.cooldownUntil, first.cooldownUntil);
});

test("restart resumes an interrupted export from its original snapshot", { timeout: 15_000 }, async (t) => {
  const h = await createHarness(); t.after(() => h.cleanup());
  const job = projectFixture("export-recovery");
  job.export = { id: "interrupted", status: "running", filename: "export-interrupted.mp4", signature: exportSignature(job, crypto),
    snapshot: { images: job.images.map((image) => ({ index: image.index, filename: image.filename, start: image.timelineStart })), audioFilename: job.audioFilename, duration: 8, visualFormat: job.visualFormat } };
  job.images[1].timelineStart = 1.5;
  await h.seed(job); await h.start();
  const completed = await until(async () => {
    const project = await h.get(job.id);
    if (project.export.status === "failed") throw new Error(project.export.error);
    return project.export.status === "ready" && project;
  });
  assert.equal(completed.export.isCurrent, false);
  assert.equal(h.records.length, 0);
  assert.equal((await fetch(`${h.url}${completed.export.downloadUrl}`)).status, 200);
});
