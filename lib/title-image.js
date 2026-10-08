import { createCanvas } from "@napi-rs/canvas";
import { drawEpisodeTitle, outputFormat } from "./video-layout.js";

export function renderTitle(project) {
  const { width, height } = outputFormat(project);
  const canvas = createCanvas(width, height);
  drawEpisodeTitle(canvas.getContext("2d"), project.videoLayout?.title, width, height);
  return canvas.toBuffer("image/png");
}
