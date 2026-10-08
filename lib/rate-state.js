import fs from "node:fs/promises";

// Keep the rolling request window across process restarts as well as task state.
export function rateState(queue, filename) {
  let chain = Promise.resolve();
  return {
    async load() {
      try {
        const state = JSON.parse(await fs.readFile(filename, "utf8"));
        queue.starts = (state.starts || []).filter((time) => Number.isFinite(time) && time > Date.now() - 60_000);
        queue.cooldownUntil = Number.isFinite(state.cooldownUntil) ? state.cooldownUntil : 0;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    },
    save() {
      chain = chain.catch(() => {}).then(async () => {
        const data = JSON.stringify({ starts: queue.starts, cooldownUntil: queue.cooldownUntil });
        await fs.writeFile(`${filename}.tmp`, data, "utf8");
        await fs.rename(`${filename}.tmp`, filename);
      });
      return chain;
    },
  };
}
