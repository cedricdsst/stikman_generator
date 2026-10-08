export const pendingWrites = new Set();

export function trackWrite(promise) {
  pendingWrites.add(promise);
  promise.then(() => pendingWrites.delete(promise), () => pendingWrites.delete(promise));
  return promise;
}

export async function readJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Impossible d’enregistrer cette modification.");
  return data;
}

export function writeJson(url, body = {}) {
  return trackWrite(readJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

export function latestProject(current, incoming) {
  if (!current || current.id !== incoming.id || (incoming.revision || 0) > (current.revision || 0)) return incoming;
  return current;
}

export function withTimings(project, pending) {
  if (!project || !pending.size) return project;
  return { ...project, images: project.images.map((image) => pending.has(image.index)
    ? { ...image, timelineStart: pending.get(image.index).start } : image) };
}
