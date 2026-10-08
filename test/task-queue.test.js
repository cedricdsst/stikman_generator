import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { TaskQueue, retryDelay } from "../lib/task-queue.js";
import { ensureScenes } from "../lib/project-state.js";
import { latestProject, withTimings } from "../src/project-sync.js";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const tick = () => delay(0);

test("global ceiling, priority at next free slot, one retouch lane and no preemption", async () => {
  const queue = new TaskQueue({ concurrency: 3 });
  const gates = Array.from({ length: 7 }, deferred);
  const starts = [];
  let peak = 0;
  const add = (index, priority = false) => queue.add({ id: String(index), projectId: index % 2 ? "B" : "A", priority, run: async () => {
    starts.push(index); peak = Math.max(peak, queue.active); await gates[index].promise;
  } });
  const work = [add(0), add(1), add(2), add(3), add(4)];
  await tick();
  work.push(add(5, true), add(6, true));
  await tick();
  assert.deepEqual(starts, [0, 1, 2]);
  gates[0].resolve(); await tick();
  assert.deepEqual(starts, [0, 1, 2, 5]);
  gates[1].resolve(); await tick();
  assert.deepEqual(starts, [0, 1, 2, 5, 3]);
  gates[5].resolve(); await tick();
  assert.deepEqual(starts, [0, 1, 2, 5, 3, 6]);
  gates.forEach((gate) => gate.resolve());
  await Promise.all(work);
  assert.equal(peak, 3);
  assert.equal(queue.snapshot().active, 0);
});

test("new project pipeline queue is FIFO and survives a failed project", async () => {
  const queue = new TaskQueue();
  const first = deferred();
  const starts = [];
  const a = queue.add({ id: "A", run: async () => { starts.push("A"); await first.promise; throw new Error("broken"); } }).catch(() => {});
  const b = queue.add({ id: "B", run: async () => starts.push("B") });
  await tick(); assert.deepEqual(starts, ["A"]);
  first.resolve(); await Promise.all([a, b]);
  assert.deepEqual(starts, ["A", "B"]);
});

test("retry releases its slot, respects cooldown and persists a retry time", async () => {
  const queue = new TaskQueue({ concurrency: 1, getRetryDelay: () => 35 });
  const starts = [];
  let retryAt;
  let attempt = 0;
  const a = queue.add({ id: "a", run: async () => {
    starts.push("a");
    if (++attempt === 1) throw Object.assign(new Error("limited"), { status: 429 });
  }, onRetry: async (_error, _attempt, time) => { retryAt = time; } });
  await tick();
  const b = queue.add({ id: "b", priority: true, run: async () => { assert.ok(Date.now() >= retryAt); starts.push("b"); } });
  await Promise.all([a, b]);
  assert.deepEqual(starts, ["a", "b", "a"]);
});

test("per-minute pacing applies across generation and editing requests", async () => {
  const queue = new TaskQueue({ concurrency: 5, requestsPerMinute: 6000 });
  const times = [];
  await Promise.all(Array.from({ length: 4 }, (_, index) => queue.add({ id: String(index), priority: index === 1, run: async () => times.push(Date.now()) })));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 9);
});

test("retries are bounded and quota/content errors are not automatically retried", async () => {
  const queue = new TaskQueue({ getRetryDelay: () => 0, maxAttempts: 3 });
  let calls = 0;
  await assert.rejects(queue.add({ id: "fail", run: async () => { calls++; throw new Error("error"); } }));
  assert.equal(calls, 3);
  assert.equal(retryDelay({ status: 429, code: "insufficient_quota" }, 1), null);
  assert.equal(retryDelay({ status: 400 }, 1), null);
  assert.equal(retryDelay({ status: 429, headers: new Headers({ "retry-after": "7" }) }, 1), 7000);
});

test("placeholders preserve timings and versions when later prompts arrive", () => {
  const job = { id: "p", images: [], segments: [{ start: 0, end: 4, text: "Une scène" }, { start: 4, end: 8, text: "La suite" }] };
  ensureScenes(job);
  job.images[1].timelineStart = 3.2;
  job.images[0].versions.push({ id: "v" });
  job.segments[1].visualPrompt = "Prompt complet";
  ensureScenes(job);
  assert.equal(job.images[1].timelineStart, 3.2);
  assert.equal(job.images[0].versions[0].id, "v");
  assert.equal(job.images[1].description, "La suite");
});

test("stale responses cannot roll back a newer edit and polling preserves unsaved drags", () => {
  const current = { id: "a", revision: 8, images: [{ index: 0, src: "new.png", timelineStart: 1 }] };
  const stale = { ...current, revision: 7, images: [{ index: 0, src: "old.png", timelineStart: 0 }] };
  assert.equal(latestProject(current, stale), current);
  const pending = new Map([[0, { start: 2 }]]);
  const merged = withTimings(current, pending);
  assert.equal(merged.images[0].timelineStart, 2);
  assert.equal(merged.images[0].src, "new.png");
  assert.equal(current.images[0].timelineStart, 1);
});
