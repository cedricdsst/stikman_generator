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

const Scene = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  if (!scene.src) {
    return (
      <AbsoluteFill
        style={{
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
        Image indisponible
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "#fff", overflow: "hidden" }}>
      <Img
        src={scene.src}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          scale: interpolate(frame, [0, 4 * fps], [1, 1.025], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
        }}
      />
    </AbsoluteFill>
  );
};

export const StoryboardVideo = ({ audioUrl, scenes }) => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "#fff" }}>
      {audioUrl ? <Audio src={audioUrl} /> : null}
      {scenes.map((scene, index) => {
        const nextStart = scenes[index + 1]?.start;
        const from = Math.max(0, Math.round(scene.start * fps));
        const until = Math.round((nextStart ?? scene.end) * fps);

        return (
          <Sequence
            key={`${scene.index}-${scene.start}`}
            from={from}
            durationInFrames={Math.max(1, until - from)}
            premountFor={fps}
          >
            <Scene scene={scene} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
