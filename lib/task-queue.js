export function retryDelay(error, attempt) {
  if (["insufficient_quota", "billing_hard_limit_reached", "billing_not_active"].includes(error?.code)) return null;
  if (![408, 409, 429, 500, 502, 503, 504].includes(error?.status) &&
      !["APIConnectionError", "APIConnectionTimeoutError"].includes(error?.name)) return null;
  const header = error.headers?.get?.("retry-after") ?? error.headers?.["retry-after"];
  const seconds = header == null ? NaN : Number(header);
  const hinted = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Math.max(0, Number.isFinite(hinted) ? hinted : Math.min(60_000, 2000 * 2 ** (attempt - 1)) + Math.random() * 1000);
}

// All entry points share this queue. Priority work occupies at most one slot,
// and takes the next free slot without interrupting requests already running.
export class TaskQueue {
  constructor({ concurrency = 1, requestsPerMinute = 0, getRetryDelay = () => null, maxAttempts = 6, maxRetryMs = 15 * 60_000 } = {}) {
    this.concurrency = concurrency;
    this.requestsPerMinute = requestsPerMinute;
    this.getRetryDelay = getRetryDelay;
    this.maxAttempts = maxAttempts;
    this.maxRetryMs = maxRetryMs;
    this.entries = new Map();
    this.active = 0;
    this.activePriority = 0;
    this.starts = [];
    this.cooldownUntil = 0;
  }

  add({ id, projectId, priority = false, attempts = 0, availableAt = 0, firstAttemptAt = 0, run, onStart, onRetry }) {
    if (this.entries.has(id)) return this.entries.get(id).promise;
    const entry = { id, projectId, priority, attempts, availableAt, run, onStart, onRetry, running: false, firstAttemptAt };
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    this.entries.set(id, entry);
    queueMicrotask(() => this.drain());
    return entry.promise;
  }

  hasProject(projectId) { return [...this.entries.values()].some((entry) => entry.projectId === projectId); }

  snapshot() {
    const entries = [...this.entries.values()];
    return {
      concurrency: this.concurrency, active: this.active,
      queued: entries.filter((entry) => !entry.running).length,
      priorityActive: this.activePriority,
      priorityQueued: entries.filter((entry) => entry.priority && !entry.running).length,
      cooldownUntil: this.cooldownUntil > Date.now() ? this.cooldownUntil : null,
      requestsPerMinute: this.requestsPerMinute || null,
    };
  }

  drain() {
    clearTimeout(this.timer);
    this.timer = null;
    const now = Date.now();
    this.starts = this.starts.filter((time) => time > now - 60_000);
    let blockedUntil = this.cooldownUntil;
    if (this.requestsPerMinute && this.starts.length) {
      blockedUntil = Math.max(blockedUntil, this.starts.at(-1) + Math.ceil(60_000 / this.requestsPerMinute));
    }
    if (this.requestsPerMinute && this.starts.length >= this.requestsPerMinute) {
      blockedUntil = Math.max(blockedUntil, this.starts[0] + 60_000);
    }
    if (blockedUntil > now) {
      if (this.entries.size) this.timer = setTimeout(() => this.drain(), blockedUntil - now + 1);
      return;
    }
    while (this.active < this.concurrency) {
      const waiting = [...this.entries.values()].filter((entry) => !entry.running);
      const ready = waiting.filter((entry) => entry.availableAt <= Date.now());
      const entry = (!this.activePriority && ready.find((task) => task.priority)) || ready.find((task) => !task.priority);
      if (!entry) {
        const next = Math.min(...waiting.filter((task) => !task.priority || !this.activePriority).map((task) => task.availableAt));
        if (Number.isFinite(next) && next > Date.now()) this.timer = setTimeout(() => this.drain(), next - Date.now() + 1);
        return;
      }
      entry.running = true;
      this.active++;
      if (entry.priority) this.activePriority++;
      this.starts.push(Date.now());
      void this.execute(entry);
      if (this.requestsPerMinute) {
        this.timer = setTimeout(() => this.drain(), Math.ceil(60_000 / this.requestsPerMinute) + 1);
        return;
      }
    }
  }

  async execute(entry) {
    let retry = false;
    try {
      entry.firstAttemptAt ||= Date.now();
      entry.attempts++;
      await entry.onStart?.(entry.attempts);
      entry.resolve(await entry.run());
    } catch (error) {
      const delay = this.getRetryDelay(error, entry.attempts);
      if (delay !== null && entry.attempts < this.maxAttempts && Date.now() + delay - entry.firstAttemptAt <= this.maxRetryMs) {
        entry.availableAt = Date.now() + delay;
        if ([429, 503].includes(error.status)) this.cooldownUntil = Math.max(this.cooldownUntil, entry.availableAt);
        try {
          await entry.onRetry?.(error, entry.attempts, entry.availableAt);
          retry = true;
        } catch (saveError) { entry.reject(saveError); }
      } else entry.reject(error);
    } finally {
      this.active--;
      if (entry.priority) this.activePriority--;
      if (retry) entry.running = false;
      else this.entries.delete(entry.id);
      this.drain();
    }
  }
}
