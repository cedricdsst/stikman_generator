// Adapted from AudioHumanifier (HumanTone).
import { seededUnit } from "./presets.js";
export function planSegments(duration, silences, settings) {
    const segments = [];
    const reduction = Math.max(0, Math.min(100, settings.pauseReduction)) / 100;
    const minimumPause = Math.max(80, Math.min(1000, settings.minimumPauseMs)) / 1000;
    let cursor = 0;
    let speechIndex = 0;
    let pauseIndex = 0;
    const addSpeech = (start, end)=>{
        if (end - start < 0.005) return;
        const pitchSemitones = settings.localVariations ? (seededUnit(settings.seed + speechIndex * 101 + 11) * 2 - 1) * 0.38 : 0;
        const tempoFactor = settings.localVariations ? 0.988 + seededUnit(settings.seed + speechIndex * 101 + 37) * 0.024 : 1;
        const pitchFactor = 2 ** (pitchSemitones / 12);
        segments.push({
            kind: "speech",
            start,
            end,
            outputDuration: (end - start) / tempoFactor,
            pitchFactor,
            tempoFactor
        });
        speechIndex += 1;
    };
    for (const silence of silences){
        const start = Math.max(cursor, Math.min(duration, silence.start));
        const end = Math.max(start, Math.min(duration, silence.end));
        addSpeech(cursor, start);
        const originalDuration = end - start;
        if (originalDuration >= 0.005) {
            let outputDuration = originalDuration;
            if (reduction > 0 && originalDuration >= minimumPause) {
                const proportionalFactor = 1 - reduction * 0.72;
                const jitter = 0.94 + seededUnit(settings.seed + pauseIndex * 131 + 71) * 0.12;
                outputDuration = Math.min(originalDuration, Math.max(0.08, originalDuration * proportionalFactor * jitter));
            }
            segments.push({
                kind: "silence",
                start,
                end,
                outputDuration,
                pitchFactor: 1,
                tempoFactor: 1
            });
            pauseIndex += 1;
        }
        cursor = end;
    }
    addSpeech(cursor, duration);
    return segments;
}
