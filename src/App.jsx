import React, { useEffect, useMemo, useRef, useState } from "react";
import { Player } from "@remotion/player";
import { StoryboardVideo } from "./StoryboardVideo";

const FPS = 30;

export const App = () => {
  const [file, setFile] = useState(null);
  const [job, setJob] = useState(null);
  const [imagesByIndex, setImagesByIndex] = useState({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const receivedCount = useRef(0);
  const pollTimer = useRef(null);

  useEffect(() => () => window.clearTimeout(pollTimer.current), []);

  const images = useMemo(
    () => Object.values(imagesByIndex).sort((a, b) => a.index - b.index),
    [imagesByIndex],
  );

  const durationInFrames = useMemo(() => {
    const lastEnd = job?.segments?.at(-1)?.end || images.at(-1)?.end || 1;
    return Math.max(1, Math.ceil(lastEnd * FPS));
  }, [job?.segments, images]);

  const selectFiles = (files) => {
    if (files?.[0]) setFile(files[0]);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!file) return;

    window.clearTimeout(pollTimer.current);
    setError("");
    setJob(null);
    setImagesByIndex({});
    receivedCount.current = 0;
    setBusy(true);

    try {
      const body = new FormData();
      body.append("audio", file);
      const response = await fetch("/api/jobs", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Impossible de démarrer.");
      poll(data.id);
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  };

  const poll = async (id) => {
    try {
      const response = await fetch(`/api/jobs/${id}?since=${receivedCount.current}`);
      const nextJob = await response.json();
      if (!response.ok) throw new Error(nextJob.error || "Tâche introuvable.");

      if (nextJob.images.length) {
        receivedCount.current += nextJob.images.length;
        setImagesByIndex((current) => {
          const updated = { ...current };
          for (const image of nextJob.images) updated[image.index] = image;
          return updated;
        });
      }

      setJob(nextJob);
      if (nextJob.status === "failed") throw new Error(nextJob.error);
      if (nextJob.status === "completed") {
        setBusy(false);
        return;
      }
      pollTimer.current = window.setTimeout(() => poll(id), 1300);
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  };

  const successfulCount = images.filter((image) => !image.error).length;

  return (
    <>
      <header>
        <a className="brand" href="/">
          <span className="logo" aria-hidden="true">☺</span>
          <span>Stickman Generator</span>
        </a>
        <span className="badge">MVP</span>
      </header>

      <main>
        <section className="hero">
          <p className="eyebrow">AUDIO → STORYBOARD → VIDÉO</p>
          <h1>Transforme ta voix en<br /><span>dessins affreusement simples.</span></h1>
          <p className="intro">
            Dépose un audio ou une vidéo. L’application en extrait la voix, la découpe, dirige une série
            d’illustrations cohérentes, puis assemble automatiquement la vidéo.
          </p>
        </section>

        <form className="upload-card" onSubmit={submit}>
          <label
            className={`drop-zone ${dragging ? "dragging" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              selectFiles(event.dataTransfer.files);
            }}
          >
            <span className="upload-icon">↑</span>
            <strong>{file?.name || "Dépose ton fichier audio ou vidéo ici"}</strong>
            <span>{file ? formatBytes(file.size) : "ou clique pour choisir un fichier · vidéo de 250 Mo maximum"}</span>
            <input
              type="file"
              accept="audio/*,video/*,.mp3,.wav,.m4a,.webm,.mp4,.mov,.mkv,.avi"
              disabled={busy}
              onChange={(event) => selectFiles(event.target.files)}
            />
          </label>
          <button type="submit" disabled={busy || !file}>
            <span>{busy ? "Génération en cours…" : "Créer ma vidéo"}</span>
            <span aria-hidden="true">→</span>
          </button>
        </form>

        {job ? (
          <section className="progress-section" aria-live="polite">
            <div className="progress-copy">
              <strong>{job.phase}</strong>
              <span>{job.progress} %</span>
            </div>
            <div className="progress-track">
              <div id="progress-bar" style={{ width: `${job.progress}%` }} />
            </div>
            <p id="progress-detail">
              {job.segments.length
                ? `${job.segments.length} scènes · ${images.length} image(s) terminée(s).`
                : "Analyse de l’audio en cours…"}
            </p>
          </section>
        ) : null}

        {job?.status === "completed" ? (
          <section className="video-section">
            <div className="section-title">
              <div>
                <p className="eyebrow">MONTAGE SYNCHRONISÉ</p>
                <h2>Ta vidéo est prête à regarder</h2>
              </div>
              <span className="count">{formatDuration(durationInFrames / FPS)}</span>
            </div>
            <div className="player-shell">
              <Player
                component={StoryboardVideo}
                inputProps={{ audioUrl: job.audioUrl, scenes: images }}
                durationInFrames={durationInFrames}
                compositionWidth={1536}
                compositionHeight={864}
                fps={FPS}
                controls
                style={{ width: "100%", aspectRatio: "16 / 9" }}
                initiallyShowControls
              />
            </div>
          </section>
        ) : null}

        {job?.segments?.length ? (
          <section className="results">
            <div className="section-title">
              <div>
                <p className="eyebrow">TON STORYBOARD</p>
                <h2>{job.status === "completed" ? "Toutes les scènes" : "Les images arrivent…"}</h2>
              </div>
              <span className="count">{successfulCount} image{successfulCount > 1 ? "s" : ""}</span>
            </div>
            <div className="gallery">
              {images.map((image) => (
                <article className="scene" key={image.index} style={{ order: image.index }}>
                  {image.error ? (
                    <div className="scene-error">{image.error}</div>
                  ) : (
                    <img src={image.src} alt={`Illustration à ${image.timestamp} : ${image.text}`} loading="lazy" />
                  )}
                  <div className="scene-copy">
                    <span className="timestamp">{image.timestamp}</span>
                    <p>{image.text}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {error ? <section className="error-box" role="alert">{error}</section> : null}
      </main>
    </>
  );
};

const formatBytes = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} Ko`
    : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

const formatDuration = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
