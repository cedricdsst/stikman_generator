import React from "react";
import { Audio } from "@remotion/media";
import {
  AbsoluteFill,
  Img,
  Sequence,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { imageRectangle, introCamera, introFrames, verticalLayout } from "../lib/video-layout.js";
import { CanvasTitle } from "./CompositionEditor";

const Scene = ({ scene, project }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const rectangle = project ? imageRectangle(project) : null;
  const positioned = project && verticalLayout(project);
  const background = positioned ? project.backgroundColor?.hex || "#fff" : "#fff";
  const bounds = positioned ? { position: "absolute", ...rectangle, left: rectangle.x, top: rectangle.y, overflow: "hidden" } : { position: "absolute", inset: 0, overflow: "hidden" };

  if (!scene.src) {
    return (
      <AbsoluteFill style={{ backgroundColor: background }}><div
        style={{ ...bounds, display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#fff",
          color: "#171717",
          fontFamily: "Arial, sans-serif",
          fontSize: 42,
          textAlign: "center",
          padding: 100,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 28, border: "5px dashed #aaa", padding: 50, maxWidth: "100%" }}>
          <strong>Scène {scene.index + 1}</strong>
          <span style={{ fontSize: 32 }}>{scene.description || scene.text}</span>
          <small style={{ fontSize: 24 }}>{scene.error ? "Image à régénérer" : "Image en cours de préparation"}</small>
        </div>
      </div></AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: background, overflow: "hidden" }}><div style={bounds}>
      <Img
        src={scene.src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: positioned ? "contain" : "cover",
          scale: positioned ? 1 : interpolate(frame, [0, 4 * fps], [1, 1.025], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      />
    </div></AbsoluteFill>
  );
};

const SeriesIntro = ({ intro, background }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const camera = introCamera(intro, frame / fps);
  return <AbsoluteFill style={{ backgroundColor: background, overflow: "hidden" }}>
    <AbsoluteFill style={{ backgroundColor: background, transformOrigin: "0 0", transform: `translate(${-camera.x / camera.size * width}px, ${-camera.y / camera.size * height}px) scale(${1 / camera.size})` }}>
      <Img src={intro.src} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
    </AbsoluteFill>
  </AbsoluteFill>;
};

export const StoryboardVideo = ({ audioUrl, scenes, audioDuration, project }) => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: project && verticalLayout(project) ? project.backgroundColor?.hex || "#fff" : "#fff" }}>
      {audioUrl ? <Audio src={audioUrl} /> : null}
      {scenes.map((scene, index) => {
        const sceneStart = scene.timelineStart ?? scene.start;
        const nextScene = scenes[index + 1];
        const nextStart = nextScene
          ? (nextScene.timelineStart ?? nextScene.start)
          : audioDuration;
        const from = Math.max(0, Math.round(sceneStart * fps));
        const until = Math.round((nextStart ?? scene.end) * fps);

        return (
          <Sequence
            key={`${scene.index}-${sceneStart}`}
            from={from}
            durationInFrames={Math.max(1, until - from)}
            premountFor={fps}
          >
            <Scene scene={scene} project={project} />
          </Sequence>
        );
      })}
      {project && verticalLayout(project) && project.videoLayout.title.text.trim() ?
        project.titleUrl ? <Img src={project.titleUrl} style={{ position: "absolute", width: "100%", height: "100%" }} /> : <CanvasTitle project={project} /> : null}
      {project?.intro ? <Sequence from={0} durationInFrames={Math.max(1, Math.min(introFrames(project.intro), Math.ceil(audioDuration * fps)))}>
        <SeriesIntro intro={project.intro} background={project.backgroundColor?.hex || "#fff"} />
      </Sequence> : null}
    </AbsoluteFill>
  );
};
