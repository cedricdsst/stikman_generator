export const defaultAudioSettings = Object.freeze({
  preset: "natural", intensity: 55, pauseReduction: 85, speed: 104,
  sibilanceReduction: 45, minimumPauseMs: 180, localVariations: true, seed: 42,
});

export function parseAudioSettings(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Réglages audio invalides.");
  const settings = { ...defaultAudioSettings };
  if (input.preset !== undefined) {
    if (!["natural", "podcast", "studio"].includes(input.preset)) throw new Error("Profil audio invalide.");
    settings.preset = input.preset;
  }
  for (const [key, min, max] of [
    ["intensity", 0, 100], ["pauseReduction", 0, 100], ["speed", 80, 120],
    ["sibilanceReduction", 0, 100], ["minimumPauseMs", 80, 1000], ["seed", 0, 2147483647],
  ]) {
    if (input[key] === undefined) continue;
    if (!Number.isInteger(input[key]) || input[key] < min || input[key] > max) throw new Error(`Réglage audio invalide : ${key}.`);
    settings[key] = input[key];
  }
  if (input.localVariations !== undefined) {
    if (typeof input.localVariations !== "boolean") throw new Error("Variations locales invalides.");
    settings.localVariations = input.localVariations;
  }
  return settings;
}
