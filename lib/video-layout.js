import { INTRO_DEFAULTS, VERTICAL_DEFAULTS } from "../video-defaults.js";

export const FPS = 30;
export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const number = (value, fallback, min, max) => Number.isFinite(value) ? clamp(value, min, max) : fallback;
export const introDuration = (intro) => intro ? intro.fullDuration + intro.zoomDuration + intro.holdDuration : 0;
export const introFrames = (intro) => Math.round(introDuration(intro) * FPS);
export const verticalLayout = (project) => project.visualFormat?.id === "vertical" && project.videoLayout?.enabled === true;
export function outputFormat(project) {
  return verticalLayout(project) ? { width: 1080, height: 1920 } : project.visualFormat || { width: 1536, height: 864 };
}

export function normalizeLayout(input = {}) {
  const title = input.title || {};
  return {
    enabled: input.enabled === true,
    imageScale: number(input.imageScale, VERTICAL_DEFAULTS.imageScale, 0.5, 1),
    imagePosition: number(input.imagePosition, VERTICAL_DEFAULTS.imagePosition, 0, 1),
    title: {
      text: typeof title.text === "string" ? title.text.slice(0, 200) : "",
      x: number(title.x, 0.5, 0, 1), y: number(title.y, 0.07, 0, 1),
      fontSize: number(title.fontSize, 64, 24, 140),
      color: /^#[\da-f]{6}$/i.test(title.color) ? title.color : "#171717",
    },
  };
}

export function imageRectangle(project) {
  const output = outputFormat(project);
  if (!verticalLayout(project)) return { x: 0, y: 0, ...output };
  const layout = normalizeLayout(project.videoLayout);
  // Multiples of 8 keep an exact 4:5 ratio and even dimensions for H.264.
  const width = Math.round(output.width * layout.imageScale / 8) * 8;
  const height = width * 1.25;
  return { width, height, x: (output.width - width) / 2, y: Math.round((output.height - height) * layout.imagePosition / 2) * 2 };
}

export function normalizeIntro(input = {}) {
  const zoom = number(input.zoom, 1, 1, 8);
  const margin = 0.5 / zoom;
  return {
    ...input,
    fullDuration: number(input.fullDuration, INTRO_DEFAULTS.fullDuration, 0, 30),
    zoomDuration: number(input.zoomDuration, INTRO_DEFAULTS.zoomDuration, 1 / FPS, 30),
    holdDuration: number(input.holdDuration, INTRO_DEFAULTS.holdDuration, 0, 30),
    zoom,
    targetX: number(input.targetX, 0.5, margin, 1 - margin),
    targetY: number(input.targetY, 0.5, margin, 1 - margin),
    targetConfigured: input.targetConfigured === true,
  };
}

// One camera model for the editor, Remotion and FFmpeg: interpolate the viewport,
// rather than a CSS transform origin, so the selected area ends up centered.
export function introCamera(intro, seconds) {
  const progress = clamp((seconds - intro.fullDuration) / intro.zoomDuration, 0, 1);
  const eased = progress * progress * (3 - 2 * progress);
  const size = 1 + (1 / intro.zoom - 1) * eased;
  return { size, x: (intro.targetX - 0.5 / intro.zoom) * eased, y: (intro.targetY - 0.5 / intro.zoom) * eased };
}

export function drawEpisodeTitle(context, title, width, height) {
  context.clearRect(0, 0, width, height);
  if (!title?.text.trim()) return;
  context.font = `bold ${title.fontSize}px Arial, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillStyle = title.color;
  const maxWidth = width * 0.9;
  const lines = [];
  for (const paragraph of title.text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/)) {
      // Break very long words as well, so even an unbroken title stays in frame.
      const pieces = [];
      let piece = "";
      for (const character of word) {
        if (piece && context.measureText(piece + character).width > maxWidth) { pieces.push(piece); piece = ""; }
        piece += character;
      }
      if (piece) pieces.push(piece);
      for (const part of pieces) {
        const candidate = line ? `${line} ${part}` : part;
        if (line && context.measureText(candidate).width > maxWidth) { lines.push(line); line = part; }
        else line = candidate;
      }
    }
    lines.push(line);
  }
  const lineHeight = title.fontSize * 1.2;
  const widest = Math.max(...lines.map((line) => context.measureText(line).width));
  const x = clamp(title.x * width, widest / 2 + 8, width - widest / 2 - 8);
  const blockHeight = lines.length * lineHeight;
  const y = clamp(title.y * height, blockHeight / 2 + 8, height - blockHeight / 2 - 8);
  lines.forEach((line, index) => context.fillText(line, x, y + (index - (lines.length - 1) / 2) * lineHeight));
}
