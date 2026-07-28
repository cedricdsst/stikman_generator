import React, { useEffect, useState } from "react";
import { Player } from "@remotion/player";
import { StoryboardVideo } from "./StoryboardVideo";

const FPS = 30;

export const App = () => {
  const path = window.location.pathname;
  const projectMatch = /^\/projects\/([^/]+)$/.exec(path);

  if (path === "/dashboard") {
    return (
      <Page>
        <Dashboard />
      </Page>
    );
  }

  if (projectMatch) {
    return (
      <Page>
        <ProjectPage id={projectMatch[1]} />
      </Page>
    );
  }

  return (
    <Page>
      <Generator />
    </Page>
  );
};

const Page = ({ children }) => (
  <>
    <Header />
    <main>{children}</main>
  </>
);

const Header = () => (
  <header>
    <a className="brand" href="/">
      <span className="logo" aria-hidden="true">☺</span>
      <span>Stickman Generator</span>
    </a>
    <nav className="header-actions">
      <a className="nav-button" href="/dashboard">Dashboard</a>
      <a className="nav-button nav-button-primary" href="/">+ Nouvelle vidéo</a>
    </nav>
  </header>
);

const Generator = () => {
  const [file, setFile] = useState(null);
  const [format, setFormat] = useState("horizontal");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const selectFiles = (files) => {
    if (files?.[0]) setFile(files[0]);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!file) return;

    setError("");
    setBusy(true);

    try {
      const body = new FormData();
      body.append("audio", file);
      body.append("format", format);
      const response = await fetch("/api/jobs", { method: "POST", body });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Impossible de démarrer.");
      window.location.assign(`/dashboard?created=${data.id}`);
    } catch (caught) {
      setError(caught.message);
      setBusy(false);
    }
  };

  return (
    <>
      <section className="hero">
        <p className="eyebrow">AUDIO → STORYBOARD → VIDÉO</p>
        <h1>Transforme ta voix en<br /><span>dessins affreusement simples.</span></h1>
        <p className="intro">
          Dépose un audio ou une vidéo. Chaque génération est automatiquement
          sauvegardée et pourra être rouverte depuis le dashboard.
        </p>
      </section>

      <form className="upload-card" onSubmit={submit}>
        <fieldset className="format-picker">
          <legend>Format du projet</legend>
          <label className={format === "horizontal" ? "selected" : ""}>
            <input
              type="radio"
              name="format"
              value="horizontal"
              checked={format === "horizontal"}
              disabled={busy}
              onChange={() => setFormat("horizontal")}
            />
            <span className="format-icon format-icon-horizontal" />
            <span><strong>Horizontal</strong><small>16:9 · YouTube</small></span>
          </label>
          <label className={format === "vertical" ? "selected" : ""}>
            <input
              type="radio"
              name="format"
              value="vertical"
              checked={format === "vertical"}
              disabled={busy}
              onChange={() => setFormat("vertical")}
            />
            <span className="format-icon format-icon-vertical" />
            <span><strong>Vertical</strong><small>4:5 · Mobile</small></span>
          </label>
        </fieldset>
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

      {error ? <section className="error-box" role="alert">{error}</section> : null}
    </>
  );
};

const Dashboard = () => {
  const [projects, setProjects] = useState([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const loadProjects = async () => {
      try {
        const response = await fetch("/api/projects");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Impossible de charger les projets.");
        if (cancelled) return;
        setProjects(data);
        setError("");
        setLoading(false);

        if (data.some((project) => ["queued", "working"].includes(project.status))) {
          timer = window.setTimeout(loadProjects, 1500);
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught.message);
          setLoading(false);
        }
      }
    };

    loadProjects();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <section className="dashboard">
      <div className="section-title">
        <div>
          <p className="eyebrow">BIBLIOTHÈQUE</p>
          <h1 className="dashboard-title">Tes projets sauvegardés</h1>
        </div>
        <span className="count">{projects.length} projet{projects.length > 1 ? "s" : ""}</span>
      </div>

      {loading ? <p className="empty-state">Chargement des projets…</p> : null}
      {error ? <section className="error-box" role="alert">{error}</section> : null}
      {!loading && !error && !projects.length ? (
        <div className="empty-state">
          <strong>Aucun projet pour l’instant.</strong>
          <p>Ta première génération apparaîtra automatiquement ici.</p>
          <a className="inline-link" href="/">Créer une vidéo →</a>
        </div>
      ) : null}

      <div className="projects-grid">
        {projects.map((project) => (
          <a className="project-card" href={`/projects/${project.id}`} key={project.id}>
            <div className={`project-thumbnail ${project.visualFormat?.id === "vertical" ? "vertical" : ""}`}>
              {project.thumbnail ? (
                <img src={project.thumbnail} alt="" />
              ) : (
                <span className={["queued", "working"].includes(project.status) ? "project-spinner" : ""} aria-hidden="true">
                  {["queued", "working"].includes(project.status) ? "" : "☺"}
                </span>
              )}
              {project.thumbnail && ["queued", "working"].includes(project.status) ? (
                <span className="project-spinner project-spinner-overlay" aria-hidden="true" />
              ) : null}
              <span className={`status-pill status-${project.status}`}>
                {statusLabel(project.status)}
              </span>
              <span className="format-pill">{project.visualFormat?.label || "Horizontal 16:9"}</span>
            </div>
            <div className="project-card-copy">
              <strong>{project.title}</strong>
              <span>{formatDate(project.createdAt)}</span>
              <div className="project-meta">
                <span>{project.imageCount} image{project.imageCount > 1 ? "s" : ""}</span>
                <span>{formatDuration(project.duration)}</span>
              </div>
            </div>
          </a>
        ))}
      </div>
    </section>
  );
};

const ProjectPage = ({ id }) => {
  const [project, setProject] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let timer;

    const loadProject = async () => {
      try {
        const response = await fetch(`/api/projects/${id}`);
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Projet introuvable.");
        if (cancelled) return;
        setProject(data);
        setError("");

        if (["queued", "working"].includes(data.status)) {
          timer = window.setTimeout(loadProject, 1300);
        }
      } catch (caught) {
        if (!cancelled) setError(caught.message);
      }
    };

    loadProject();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [id]);

  if (error) return <section className="error-box" role="alert">{error}</section>;
  if (!project) return <p className="empty-state">Chargement du projet…</p>;

  return (
    <>
      <section className="project-heading">
        <a className="back-link" href="/dashboard">← Retour au dashboard</a>
        <h1 className="project-title">{project.title}</h1>
        <p className="project-date">
          Créé le {formatDate(project.createdAt)} · {project.images.length} scène(s) ·{" "}
          {formatDuration(project.segments.at(-1)?.end || 0)} ·{" "}
          {project.visualFormat?.label || "Horizontal 16:9"}
        </p>
      </section>
      {project.status !== "completed" ? (
        <Progress project={project} completedImages={project.images.length} />
      ) : null}
      <ProjectContent
        project={project}
        live={["queued", "working"].includes(project.status)}
        editable
        onProjectChange={setProject}
      />
      <details className="technical-data">
        <summary>Données techniques et réponses IA</summary>
        <div className="technical-grid">
          <div>
            <h3>Transcript</h3>
            <p>{project.transcript || "Aucun transcript disponible."}</p>
          </div>
          <div>
            <h3>Pipeline sauvegardé</h3>
            <pre>{JSON.stringify(project.pipeline, null, 2)}</pre>
          </div>
          <div>
            <h3>Timestamps Whisper</h3>
            <pre>{JSON.stringify(project.words, null, 2)}</pre>
          </div>
        </div>
      </details>
    </>
  );
};

const Progress = ({ project, completedImages }) => (
  <section className="progress-section" aria-live="polite">
    <div className="progress-copy">
      <strong>{project.phase}</strong>
      <span>{project.progress} %</span>
    </div>
    <div className="progress-track">
      <div id="progress-bar" style={{ width: `${project.progress}%` }} />
    </div>
    <p id="progress-detail">
      {project.segments.length
        ? `${project.segments.length} scènes · ${completedImages} image(s) terminée(s).`
        : "Analyse de l’audio en cours…"}
    </p>
  </section>
);

const ProjectContent = ({
  project,
  live = false,
  editable = false,
  onProjectChange,
}) => {
  const images = [...project.images].sort((a, b) => a.index - b.index);
  const duration = project.segments.at(-1)?.end || images.at(-1)?.end || 1;
  const durationInFrames = Math.max(1, Math.ceil(duration * FPS));
  const successfulCount = images.filter((image) => !image.error).length;
  const visualFormat = project.visualFormat || {
    id: "horizontal",
    width: 1536,
    height: 864,
  };

  return (
    <>
      {project.status === "completed" ? (
        <section className="video-section">
          <div className="player-shell">
            <Player
              component={StoryboardVideo}
              inputProps={{ audioUrl: project.audioUrl, scenes: images }}
              durationInFrames={durationInFrames}
              compositionWidth={visualFormat.width}
              compositionHeight={visualFormat.height}
              fps={FPS}
              controls
              style={{
                width: visualFormat.id === "vertical" ? "min(100%, 560px)" : "100%",
                aspectRatio: `${visualFormat.width} / ${visualFormat.height}`,
                margin: "0 auto",
              }}
              initiallyShowControls
            />
          </div>
        </section>
      ) : null}

      <section className="results">
        <div className="section-title">
          <div>
            <p className="eyebrow">STORYBOARD</p>
            {live && project.status !== "completed" ? <h2>Les images arrivent…</h2> : null}
          </div>
          <span className="count">{successfulCount} image{successfulCount > 1 ? "s" : ""}</span>
        </div>
        <div className="gallery">
          {images.map((image) => (
            <SceneCard
              image={image}
              projectId={project.id}
              visualFormat={visualFormat}
              editable={editable}
              onProjectChange={onProjectChange}
              key={image.index}
            />
          ))}
        </div>
      </section>
    </>
  );
};

const SceneCard = ({
  image,
  projectId,
  visualFormat,
  editable,
  onProjectChange,
}) => {
  const [showRegeneration, setShowRegeneration] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const versions = image.versions || [];

  const regenerate = async (event) => {
    event.preventDefault();
    setWorking(true);
    setError("");

    try {
      const response = await fetch(
        `/api/projects/${projectId}/scenes/${image.index}/regenerate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instructions }),
        },
      );
      const project = await response.json();
      if (!response.ok) throw new Error(project.error || "Régénération impossible.");
      onProjectChange(project);
      setInstructions("");
      setShowRegeneration(false);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setWorking(false);
    }
  };

  const selectVersion = async (versionId) => {
    if (versionId === image.selectedVersionId || working) return;
    setWorking(true);
    setError("");

    try {
      const response = await fetch(
        `/api/projects/${projectId}/scenes/${image.index}/select-version`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ versionId }),
        },
      );
      const project = await response.json();
      if (!response.ok) throw new Error(project.error || "Sélection impossible.");
      onProjectChange(project);
    } catch (caught) {
      setError(caught.message);
    } finally {
      setWorking(false);
    }
  };

  return (
    <article
      className={`scene ${visualFormat.id === "vertical" ? "scene-vertical" : ""}`}
      style={{ order: image.index }}
    >
      {versions.length > 1 ? (
        <div className="version-strip">
          {versions.map((version, versionIndex) => (
            <button
              className={`version-thumbnail ${version.id === image.selectedVersionId ? "selected" : ""}`}
              type="button"
              title={`Version ${versionIndex + 1}`}
              disabled={working}
              onClick={() => selectVersion(version.id)}
              key={version.id}
            >
              <img src={version.src} alt={`Version ${versionIndex + 1}`} />
            </button>
          ))}
        </div>
      ) : null}

      <div className="scene-image-wrap">
        {image.error ? (
          <div className="scene-error">{image.error}</div>
        ) : (
          <img src={image.src} alt={`Illustration à ${image.timestamp} : ${image.text}`} loading="lazy" />
        )}
        {working ? <div className="scene-working"><span className="project-spinner" /></div> : null}
      </div>

      <div className="scene-copy">
        <div className="scene-copy-heading">
          <span className="timestamp">{image.timestamp}</span>
          {editable && !image.error ? (
            <button
              className="regenerate-toggle"
              type="button"
              onClick={() => setShowRegeneration((current) => !current)}
            >
              ↻ Régénérer
            </button>
          ) : null}
        </div>
        <p>{image.text}</p>

        {showRegeneration ? (
          <form className="regeneration-form" onSubmit={regenerate}>
            <label>
              Instructions supplémentaires
              <textarea
                value={instructions}
                maxLength={1500}
                rows={3}
                placeholder="Ex. : remplace la flèche rouge par une flèche bleue, sans changer le personnage."
                onChange={(event) => setInstructions(event.target.value)}
              />
            </label>
            <button type="submit" disabled={working}>
              <span>{working ? "Régénération…" : "Créer une nouvelle version"}</span>
              <span>→</span>
            </button>
          </form>
        ) : null}
        {error ? <p className="scene-action-error">{error}</p> : null}
      </div>
    </article>
  );
};

const statusLabel = (status) =>
  ({ completed: "Terminé", working: "En cours", queued: "En attente", failed: "Échec" })[status] || status;

const formatDate = (date) =>
  new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));

const formatBytes = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} Ko`
    : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

const formatDuration = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
