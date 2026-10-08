import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { clamp, introDuration } from "../lib/video-layout.js";

const getStart = (image) => image.timelineStart ?? image.start;

const useCurrentPlayerFrame = (playerRef) => {
  const subscribe = useCallback(
    (onStoreChange) => {
      const player = playerRef.current;
      if (!player) return () => undefined;
      const update = () => onStoreChange();
      player.addEventListener("frameupdate", update);
      return () => player.removeEventListener("frameupdate", update);
    },
    [playerRef],
  );

  return useSyncExternalStore(
    subscribe,
    () => playerRef.current?.getCurrentFrame() ?? 0,
    () => 0,
  );
};

export const TimelineEditor = ({
  project,
  playerRef,
  fps,
  onTimingChange,
  onCompositionChange,
}) => {
  const [peaks, setPeaks] = useState([]);
  const [pixelsPerSecond, setPixelsPerSecond] = useState(100);
  const [drag, setDrag] = useState(null);
  const [introDrag, setIntroDrag] = useState(null);
  const latestIntro = useRef(null);
  const [scrubbing, setScrubbing] = useState(null);
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 20 });
  const [snapLabel, setSnapLabel] = useState("");
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState("");
  const latestStart = useRef(null);
  const scrollRef = useRef(null);
  const scrollFrame = useRef(null);
  const currentFrame = useCurrentPlayerFrame(playerRef);
  const currentTime = currentFrame / fps;

  const words = project.words || [];
  const audioDuration =
    project.audioDuration || words.at(-1)?.end || project.segments.at(-1)?.end || 1;
  const timelineWidth = Math.max(900, Math.ceil(audioDuration * pixelsPerSecond));
  const intro = introDrag?.value || project.intro;
  const orderedImages = useMemo(
    () => project.images.map((image) => image.index === drag?.imageIndex
      ? { ...image, timelineStart: drag.start ?? drag.originStart } : image).sort((a, b) => a.index - b.index),
    [project.images, drag],
  );

  const updateVisibleRange = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    setVisibleRange({
      start: Math.max(0, viewport.scrollLeft / pixelsPerSecond - 2),
      end:
        (viewport.scrollLeft + viewport.clientWidth) / pixelsPerSecond + 2,
    });
  }, [pixelsPerSecond]);

  useEffect(() => {
    updateVisibleRange();
    window.addEventListener("resize", updateVisibleRange);
    return () => {
      window.removeEventListener("resize", updateVisibleRange);
      if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
    };
  }, [updateVisibleRange]);

  useEffect(() => {
    let cancelled = false;
    let context;

    const loadWaveform = async () => {
      try {
        const response = await fetch(project.audioUrl);
        if (!response.ok) throw new Error("Impossible de charger la piste audio.");
        const audioData = await response.arrayBuffer();
        context = new AudioContext();
        const buffer = await context.decodeAudioData(audioData);
        const channel = buffer.getChannelData(0);
        const pointCount = Math.min(
          6000,
          Math.max(300, Math.ceil(buffer.duration * 24)),
        );
        const blockSize = Math.max(1, Math.floor(channel.length / pointCount));
        const nextPeaks = [];

        for (let point = 0; point < pointCount; point += 1) {
          let peak = 0;
          const start = point * blockSize;
          const end = Math.min(channel.length, start + blockSize);
          for (let sample = start; sample < end; sample += 1) {
            peak = Math.max(peak, Math.abs(channel[sample]));
          }
          nextPeaks.push(peak);
        }

        if (!cancelled) setPeaks(nextPeaks);
      } catch (caught) {
        if (!cancelled) setError(caught.message);
      } finally {
        if (context && context.state !== "closed") void context.close().catch(() => {});
      }
    };

    if (project.audioUrl) loadWaveform();
    return () => {
      cancelled = true;
      if (context && context.state !== "closed") void context.close().catch(() => {});
    };
  }, [project.audioUrl]);

  const waveformPath = useMemo(() => {
    if (!peaks.length) return "";
    const top = peaks
      .map((peak, index) => `${index},${50 - peak * 43}`)
      .join(" L ");
    const bottom = [...peaks]
      .reverse()
      .map((peak, reversedIndex) => {
        const index = peaks.length - 1 - reversedIndex;
        return `${index},${50 + peak * 43}`;
      })
      .join(" L ");
    return `M ${top} L ${bottom} Z`;
  }, [peaks]);

  const seekToClientX = useCallback(
    (clientX) => {
      const viewport = scrollRef.current;
      if (!viewport) return;
      const bounds = viewport.getBoundingClientRect();
      const seconds = Math.min(
        audioDuration,
        Math.max(
          0,
          (clientX - bounds.left + viewport.scrollLeft) / pixelsPerSecond,
        ),
      );
      playerRef.current?.seekTo(Math.round(seconds * fps));
    },
    [audioDuration, fps, pixelsPerSecond, playerRef],
  );

  const beginScrub = (event) => {
    if (event.button !== 0 || event.target.closest(".clip-handle, .intro-handle")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(event.pointerId);
    seekToClientX(event.clientX);
  };

  const moveScrub = (event) => {
    if (scrubbing !== event.pointerId) return;
    seekToClientX(event.clientX);
  };

  const endScrub = (event) => {
    if (scrubbing === event.pointerId) setScrubbing(null);
  };

  const beginDrag = (event, image) => {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      imageIndex: image.index,
      pointerId: event.pointerId,
      originX: event.clientX,
      originStart: getStart(image),
    });
    latestStart.current = getStart(image);
    playerRef.current?.seekTo(Math.round(getStart(image) * fps));
    setError("");
  };

  const moveDrag = (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const position = orderedImages.findIndex(
      (image) => image.index === drag.imageIndex,
    );
    const previous = orderedImages[position - 1];
    const next = orderedImages[position + 1];
    const minimum = previous ? getStart(previous) + 0.05 : 0;
    const maximum = next
      ? getStart(next) - 0.05
      : Math.max(minimum, audioDuration - 0.05);
    let start =
      drag.originStart + (event.clientX - drag.originX) / pixelsPerSecond;
    start = Math.min(maximum, Math.max(minimum, start));

    const snapDistance = 12 / pixelsPerSecond;
    const nearbyWords = words.filter(
      (word) => word.start >= start - snapDistance && word.start <= start + snapDistance,
    );
    const closestWord = nearbyWords.reduce((closest, word) => {
      const distance = Math.abs(word.start - start);
      return !closest || distance < closest.distance
        ? { word, distance }
        : closest;
    }, null);

    if (
      closestWord &&
      closestWord.word.start >= minimum &&
      closestWord.word.start <= maximum
    ) {
      start = closestWord.word.start;
      setSnapLabel(
        `Aimanté sur « ${closestWord.word.word} » · ${formatPreciseTime(start)}`,
      );
    } else {
      setSnapLabel("");
    }

    const roundedStart = Math.round(start * 1000) / 1000;
    setDrag((current) => ({ ...current, start: roundedStart }));
    latestStart.current = roundedStart;
    playerRef.current?.seekTo(Math.round(roundedStart * fps));
  };

  const finishDrag = async (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const imageIndex = drag.imageIndex;
    const savedStart = latestStart.current;
    setDrag(null);
    setSnapLabel("");
    setSaving((count) => count + 1);

    try {
      await onTimingChange(imageIndex, savedStart);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setSaving((count) => count - 1);
    }
  };

  const handleScroll = () => {
    if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(updateVisibleRange);
  };

  const beginIntroDrag = (event, boundary) => {
    if (event.button !== 0) return;
    event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    latestIntro.current = { ...project.intro };
    setIntroDrag({ boundary, pointerId: event.pointerId, originX: event.clientX, original: { ...project.intro }, value: { ...project.intro } });
    setError("");
  };
  const moveIntroDrag = (event) => {
    if (!introDrag || event.pointerId !== introDrag.pointerId) return;
    const original = introDrag.original;
    const delta = (event.clientX - introDrag.originX) / pixelsPerSecond;
    const fullEnd = original.fullDuration;
    const zoomEnd = fullEnd + original.zoomDuration;
    const total = introDuration(original);
    let value = { ...original }, time;
    if (introDrag.boundary === "full") {
      time = clamp(fullEnd + delta, 0, zoomEnd - 1 / fps);
      value.fullDuration = time; value.zoomDuration = zoomEnd - time;
    } else if (introDrag.boundary === "zoom") {
      time = clamp(zoomEnd + delta, fullEnd + 1 / fps, total);
      value.zoomDuration = time - fullEnd; value.holdDuration = total - time;
    } else {
      time = clamp(total + delta, zoomEnd, Math.max(zoomEnd, audioDuration));
      value.holdDuration = time - zoomEnd;
    }
    value = { ...value, fullDuration: Math.round(value.fullDuration * 1000) / 1000, zoomDuration: Math.round(value.zoomDuration * 1000) / 1000, holdDuration: Math.round(value.holdDuration * 1000) / 1000 };
    latestIntro.current = value; setIntroDrag((current) => ({ ...current, value }));
    playerRef.current?.seekTo(Math.min(Math.ceil(audioDuration * fps) - 1, Math.round(time * fps)));
  };
  const finishIntroDrag = async (event) => {
    if (!introDrag || event.pointerId !== introDrag.pointerId) return;
    const value = latestIntro.current; setIntroDrag(null); setSaving((count) => count + 1);
    try { await onCompositionChange({ intro: { fullDuration: value.fullDuration, zoomDuration: value.zoomDuration, holdDuration: value.holdDuration } }); }
    catch (caught) { setError(caught.message); }
    finally { setSaving((count) => count - 1); }
  };

  const visibleWords = words.filter(
    (word) => word.end >= visibleRange.start && word.start <= visibleRange.end,
  );
  const firstTick = Math.max(0, Math.floor(visibleRange.start));
  const lastTick = Math.min(Math.ceil(audioDuration), Math.ceil(visibleRange.end));
  const rulerSeconds = Array.from(
    { length: Math.max(0, lastTick - firstTick + 1) },
    (_, index) => firstTick + index,
  );

  return (
    <section className="timeline-section">
      <div className="timeline-header">
        <div>
          <p className="eyebrow">TIMELINE</p>
          <p className="timeline-help">
            Clique ou glisse sur la timeline pour naviguer. Déplace une poignée
            rouge pour recaler une image sur un mot.
            {project.intro ? " Les poignées bleues règlent les phases de l’introduction sur la piste du dessus." : ""}
          </p>
        </div>
        <label className="timeline-zoom">
          Zoom
          <input
            type="range"
            min="50"
            max="400"
            step="10"
            value={pixelsPerSecond}
            onChange={(event) => setPixelsPerSecond(Number(event.target.value))}
          />
          <strong>{pixelsPerSecond} px/s</strong>
        </label>
      </div>

      <div className="timeline-status">
        <span>
          {snapLabel ||
            (saving ? "Sauvegarde du timing…" : "Aimantation aux mots active")}
        </span>
        <span>
          {formatPreciseTime(currentTime)} / {formatPreciseTime(audioDuration)}
        </span>
      </div>

      <div
        className={`timeline-scroll ${scrubbing !== null ? "scrubbing" : ""}`}
        ref={scrollRef}
        onScroll={handleScroll}
      >
        <div
          className="timeline-inner"
          style={{ width: timelineWidth, ...(intro ? { height: 370 } : {}) }}
          onPointerDown={beginScrub}
          onPointerMove={moveScrub}
          onPointerUp={endScrub}
          onPointerCancel={endScrub}
        >
          <div
            className="timeline-playhead"
            style={{ left: Math.min(audioDuration, currentTime) * pixelsPerSecond }}
          >
            <span />
          </div>

          <div className="timeline-ruler">
            {rulerSeconds.map((second) => (
              <span
                className="timeline-tick"
                style={{ left: second * pixelsPerSecond }}
                key={second}
              >
                {formatRulerTime(second)}
              </span>
            ))}
          </div>

          <div className="audio-track">
            <svg
              className="waveform"
              viewBox={`0 0 ${Math.max(1, peaks.length - 1)} 100`}
              preserveAspectRatio="none"
              aria-label="Forme d’onde audio"
            >
              <path d={waveformPath} />
            </svg>
            <div className="word-overlay">
              {visibleWords.map((word) => (
                <span
                  className="timeline-word"
                  style={{
                    left: word.start * pixelsPerSecond,
                    width: Math.max(
                      24,
                      (word.end - word.start) * pixelsPerSecond,
                    ),
                  }}
                  title={`${word.word} · ${formatPreciseTime(word.start)}`}
                  key={`${word.index}-${word.start}`}
                >
                  {word.word}
                </span>
              ))}
            </div>
          </div>

          {intro ? <div className="intro-track">
            <span className="track-label">Introduction · au-dessus des illustrations</span>
            <div className="timeline-intro-clip" style={{ width: Math.min(audioDuration, introDuration(intro)) * pixelsPerSecond }}>
              <img src={project.intro.src} alt="" draggable="false" />
              <div className="intro-phase intro-phase-full" style={{ left: 0, width: intro.fullDuration * pixelsPerSecond }} title={`Image entière · ${intro.fullDuration.toFixed(2)} s`}>Image entière</div>
              <div className="intro-phase intro-phase-zoom" style={{ left: intro.fullDuration * pixelsPerSecond, width: intro.zoomDuration * pixelsPerSecond }} title={`Zoom · ${intro.zoomDuration.toFixed(2)} s`}>Zoom</div>
              <div className="intro-phase intro-phase-hold" style={{ left: (intro.fullDuration + intro.zoomDuration) * pixelsPerSecond, width: intro.holdDuration * pixelsPerSecond }} title={`Image zoomée · ${intro.holdDuration.toFixed(2)} s`}>Image zoomée</div>
            </div>
            {[{ id: "full", label: "Déplacer le début du zoom", time: intro.fullDuration }, { id: "zoom", label: "Déplacer la fin du zoom", time: intro.fullDuration + intro.zoomDuration }, { id: "end", label: "Ajuster la fin de l’introduction", time: Math.min(audioDuration, introDuration(intro)) }].map((boundary) => <button key={boundary.id} type="button" className="intro-handle" style={{ left: Math.min(audioDuration, boundary.time) * pixelsPerSecond }} aria-label={boundary.label} title={boundary.label} onPointerDown={(event) => beginIntroDrag(event, boundary.id)} onPointerMove={moveIntroDrag} onPointerUp={finishIntroDrag} onPointerCancel={finishIntroDrag} />)}
          </div> : null}

          <div className="image-track">
            {intro ? <span className="track-label">Illustrations générées · piste du dessous</span> : null}
            {orderedImages.map((image, position) => {
              const start = getStart(image);
              const next = orderedImages[position + 1];
              const end = next ? getStart(next) : audioDuration;
              return (
                <div
                  className={`timeline-clip ${
                    drag?.imageIndex === image.index ? "dragging" : ""
                  }`}
                  style={{
                    left: start * pixelsPerSecond,
                    width: Math.max(42, (end - start) * pixelsPerSecond),
                  }}
                  key={image.index}
                >
                  <button
                    className="clip-handle"
                    type="button"
                    title="Déplacer le début de cette image"
                    onPointerDown={(event) => beginDrag(event, image)}
                    onPointerMove={moveDrag}
                    onPointerUp={finishDrag}
                    onPointerCancel={finishDrag}
                  />
                  {image.src ? (
                    <img src={image.src} alt="" draggable="false" />
                  ) : <div className="timeline-placeholder" title={image.description || image.text}>
                    <strong>Scène {image.index + 1}</strong><small>{image.description || image.text}</small>
                  </div>}
                  <span>
                    #{image.index + 1} · {formatPreciseTime(start)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {error ? <p className="scene-action-error">{error}</p> : null}
    </section>
  );
};

const formatPreciseTime = (seconds) => {
  const safeSeconds = Number.isFinite(seconds) ? seconds : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${remainder
    .toFixed(2)
    .padStart(5, "0")}`;
};

const formatRulerTime = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
