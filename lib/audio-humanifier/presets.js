// Adapted from AudioHumanifier (HumanTone).
export const presets = {
    natural: {
        label: "Naturel",
        description: "Traitement équilibré, discret et polyvalent.",
        highpass: 65,
        lowShelfGain: 0.7,
        presenceGain: -0.5,
        compressionRatio: 2.0,
        tempoRange: 0.012
    },
    podcast: {
        label: "Podcast",
        description: "Voix plus présente et niveau plus homogène.",
        highpass: 75,
        lowShelfGain: 1.5,
        presenceGain: 1.0,
        compressionRatio: 2.8,
        tempoRange: 0.008
    },
    studio: {
        label: "Studio",
        description: "Correction minimale et résultat propre.",
        highpass: 55,
        lowShelfGain: 0.3,
        presenceGain: 0.2,
        compressionRatio: 1.6,
        tempoRange: 0.004
    }
};
export function seededUnit(seed) {
    let value = seed | 0;
    value = Math.imul(value ^ value >>> 16, 0x45d9f3b);
    value = Math.imul(value ^ value >>> 16, 0x45d9f3b);
    value ^= value >>> 16;
    return (value >>> 0) / 0xffffffff;
}
export function buildAudioFilter(presetName, intensity, seed, pauseReduction = 0, speed = 100, sibilanceReduction = 45) {
    const preset = presets[presetName];
    const amount = Math.max(0, Math.min(1, intensity / 100));
    const tempoDelta = (seededUnit(seed) * 2 - 1) * preset.tempoRange * amount;
    const safeSpeed = Math.max(80, Math.min(120, speed)) / 100;
    const tempo = (safeSpeed * (1 + tempoDelta)).toFixed(5);
    const ratio = (1 + (preset.compressionRatio - 1) * amount).toFixed(2);
    const lowGain = (preset.lowShelfGain * amount).toFixed(2);
    const presenceGain = (preset.presenceGain * amount).toFixed(2);
    const filters = [
        `highpass=f=${preset.highpass}`,
        "lowpass=f=16500:p=2",
        `lowshelf=f=160:g=${lowGain}:w=0.7`,
        `equalizer=f=3200:t=q:w=1.1:g=${presenceGain}`
    ];
    const deEssAmount = Math.max(0, Math.min(100, sibilanceReduction)) / 100;
    if (deEssAmount > 0) {
        const trigger = (0.35 + deEssAmount * 0.4).toFixed(2);
        const ducking = (0.2 + deEssAmount * 0.55).toFixed(2);
        const originalContent = (0.8 - deEssAmount * 0.35).toFixed(2);
        filters.push(`deesser=i=${trigger}:m=${ducking}:f=${originalContent}:s=o`);
    }
    filters.push(`acompressor=threshold=0.18:ratio=${ratio}:attack=25:release=220:makeup=1:knee=3`);
    filters.push(`atempo=${tempo}`, "loudnorm=I=-18:LRA=10:TP=-3", "alimiter=limit=0.82:attack=8:release=80");
    return filters.join(",");
}
