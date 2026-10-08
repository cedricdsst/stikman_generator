// Adapted from AudioHumanifier (HumanTone).
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import ffmpegStaticModule from "ffmpeg-static";
import { buildAudioFilter } from "./presets.js";
import { planSegments } from "./segments.js";
const packagedFfmpeg = typeof ffmpegStaticModule === "string" ? ffmpegStaticModule : ffmpegStaticModule.default;
const resolvedFfmpegPath = process.env.FFMPEG_PATH || packagedFfmpeg;
if (!resolvedFfmpegPath) {
    throw new Error("FFmpeg est introuvable. Définissez FFMPEG_PATH.");
}
const ffmpegPath = resolvedFfmpegPath;
export async function encodePreview(inputPath, outputPath) {
    await runProcess(ffmpegPath, ["-y", "-hide_banner", "-i", inputPath,
        "-map", "0:a:0", "-vn", "-ar", "44100", "-ac", "1", "-c:a", "libmp3lame", "-b:a", "96k", outputPath]);
}
function runProcess(executable, args, timeoutMs = 10 * 60 * 1000) {
    return new Promise((resolve, reject)=>{
        const process1 = spawn(executable, args, {
            windowsHide: true,
            stdio: [
                "ignore",
                "pipe",
                "pipe"
            ]
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(()=>{
            process1.kill();
            reject(new Error("Le traitement audio a dépassé le délai autorisé."));
        }, timeoutMs);
        process1.stdout.on("data", (chunk)=>stdout += chunk.toString());
        process1.stderr.on("data", (chunk)=>stderr += chunk.toString());
        process1.on("error", (error)=>{
            clearTimeout(timer);
            reject(error);
        });
        process1.on("close", (code)=>{
            clearTimeout(timer);
            if (code === 0) resolve({
                stdout,
                stderr
            });
            else reject(new Error(stderr.split(/\r?\n/).slice(-8).join("\n")));
        });
    });
}
export async function analyzeAudio(inputPath) {
    const stat = await fs.stat(inputPath);
    const { stderr } = await runProcess(ffmpegPath, [
        "-hide_banner",
        "-i",
        inputPath,
        "-map", "0:a:0", "-vn",
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-"
    ]);
    const durationMatch = stderr.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    const formatMatch = stderr.match(/Input #0,\s*([^,]+)/);
    const maxVolumeMatch = stderr.match(/max_volume:\s*(-?[\d.]+)\s*dB/i);
    let durationSeconds = null;
    if (durationMatch) {
        durationSeconds = Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3]);
    }
    return {
        durationSeconds,
        inputBytes: stat.size,
        inputFormat: formatMatch?.[1]?.trim() ?? "inconnu",
        maxVolumeDb: maxVolumeMatch ? Number(maxVolumeMatch[1]) : null
    };
}
export async function processAudio(job, outputPath) {
    const outputDir = path.dirname(job.inputPath);
    const filter = "aformat=sample_rates=48000:channel_layouts=mono," + buildAudioFilter(job.preset, job.intensity, job.seed, job.pauseReduction, job.speed, job.sibilanceReduction);
    const shouldSegment = job.pauseReduction > 0 || job.localVariations;
    if (!shouldSegment) {
        await runProcess(ffmpegPath, [
            "-y",
            "-hide_banner",
            "-i",
            job.inputPath,
            "-vn",
            "-af",
            filter,
            "-ar",
            "48000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s24le",
            outputPath
        ]);
        return outputPath;
    }
    const metadata = await analyzeAudio(job.inputPath);
    if (!metadata.durationSeconds) throw new Error("Durée audio indétectable.");
    const silences = await detectSilences(job.inputPath, metadata.durationSeconds);
    const segments = planSegments(metadata.durationSeconds, silences, {
        pauseReduction: job.pauseReduction,
        minimumPauseMs: job.minimumPauseMs,
        localVariations: job.localVariations,
        seed: job.seed
    });
    if (segments.length === 0) throw new Error("Aucun segment audio exploitable.");
    const splitLabels = segments.map((_, index)=>`[src${index}]`).join("");
    const statements = [
        `[0:a]aformat=sample_rates=48000:channel_layouts=mono,asplit=${segments.length}${splitLabels}`
    ];
    segments.forEach((segment, index)=>{
        const duration = segment.end - segment.start;
        const chain = [
            `[src${index}]atrim=start=${segment.start.toFixed(6)}:end=${segment.end.toFixed(6)}`,
            "asetpts=PTS-STARTPTS"
        ];
        if (segment.kind === "speech" && job.localVariations) {
            const localTempo = segment.tempoFactor / segment.pitchFactor;
            chain.push(`asetrate=${(48000 * segment.pitchFactor).toFixed(3)}`, "aresample=48000", ...atempoChain(localTempo));
        } else if (segment.kind === "silence" && Math.abs(segment.outputDuration - duration) > 0.001) {
            chain.push(...atempoChain(duration / segment.outputDuration));
        }
        statements.push(`${chain.join(",")}[part${index}]`);
    });
    const concatInputs = segments.map((_, index)=>`[part${index}]`).join("");
    statements.push(`${concatInputs}concat=n=${segments.length}:v=0:a=1,${filter}[out]`);
    const scriptPath = path.join(outputDir, `filter-${Date.now()}.txt`);
    await fs.writeFile(scriptPath, statements.join(";\n"), "utf8");
    try {
        await runProcess(ffmpegPath, [
            "-y",
            "-hide_banner",
            "-i",
            job.inputPath,
            "-vn",
            "-filter_complex_script",
            scriptPath,
            "-map",
            "[out]",
            "-ar",
            "48000",
            "-ac",
            "1",
            "-c:a",
            "pcm_s24le",
            outputPath
        ]);
    } finally{
        await fs.rm(scriptPath, {
            force: true
        });
    }
    return outputPath;
}
function atempoChain(ratio) {
    const filters = [];
    let remaining = Math.max(0.25, Math.min(4, ratio));
    while(remaining > 2){
        filters.push("atempo=2");
        remaining /= 2;
    }
    while(remaining < 0.5){
        filters.push("atempo=0.5");
        remaining /= 0.5;
    }
    filters.push(`atempo=${remaining.toFixed(6)}`);
    return filters;
}
async function detectSilences(inputPath, duration) {
    const { stderr } = await runProcess(ffmpegPath, [
        "-hide_banner",
        "-i",
        inputPath,
        "-map", "0:a:0", "-vn",
        "-af",
        "silencedetect=noise=-42dB:d=0.08",
        "-f",
        "null",
        "-"
    ]);
    const intervals = [];
    const events = /silence_(start|end):\s*([\d.]+)/g;
    let currentStart = null;
    for (const match of stderr.matchAll(events)){
        const value = Number(match[2]);
        if (match[1] === "start") currentStart = value;
        else if (currentStart !== null) {
            intervals.push({
                start: currentStart,
                end: value
            });
            currentStart = null;
        }
    }
    if (currentStart !== null) intervals.push({
        start: currentStart,
        end: duration
    });
    return intervals;
}
