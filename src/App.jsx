import React, { useEffect, useRef, useState } from "react";
import { Player } from "@remotion/player";
import { StoryboardVideo } from "./StoryboardVideo";
import { TimelineEditor } from "./TimelineEditor";
import { QueueStatus } from "./QueueStatus";
import { AudioPreparation, ApprovedAudio } from "./AudioPreparation";
import { useProject } from "./useProject";
import { pendingWrites, trackWrite, writeJson } from "./project-sync.js";
import { SeriesPicker, SeriesCreator } from "./SeriesPicker";
import { CompositionEditor } from "./CompositionEditor";
import { outputFormat } from "../lib/video-layout.js";

const FPS = 30;

export const App = () => {
  useEffect(() => {
    const protectPendingSave = (event) => {
      if (pendingWrites.size) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", protectPendingSave);
    return () => window.removeEventListener("beforeunload", protectPendingSave);
  }, []);
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
        <ProjectPage id={projectMatch[1]} key={projectMatch[1]} />
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
  <div onClick={async (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || link.origin !== window.location.origin || !pendingWrites.size) return;
    event.preventDefault();
    const result = await Promise.allSettled([...pendingWrites]);
    if (result.every((entry) => entry.status === "fulfilled")) window.location.assign(link.href);
  }}>
    <Header />
    <main><QueueStatus />{children}</main>
  </div>
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
  const [seriesId, setSeriesId] = useState(new URLSearchParams(window.location.search).get("series") || "");
  const [backgroundName, setBackgroundName] = useState("blanc");
  const [backgroundHex, setBackgroundHex] = useState("#FFFFFF");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  const selectFiles = (files) => {
    if (files?.[0]) setFile(files[0]);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!file || seriesId === "__new__") return;

    setError("");
    setBusy(true);

    try {
      const body = new FormData();
      body.append("audio", file);
      body.append("format", format);
      if (seriesId) body.append("seriesId", seriesId);
      body.append("backgroundName", backgroundName);
      body.append("backgroundHex", backgroundHex);
      body.append("prepareAudio", "true");
      const response = await trackWrite(fetch("/api/jobs", { method: "POST", body }));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Impossible de démarrer.");
      window.location.assign(`/projects/${data.id}`);
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
          Dépose un audio ou une vidéo, ajuste ta voix et écoute le résultat.
          Quand il te convient, lance la génération. Ton projet reste sauvegardé dans le dashboard.
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
            <span><strong>Vertical</strong><small>Vidéo 9:16 · Images 4:5</small></span>
          </label>
        </fieldset>
        <SeriesPicker value={seriesId} onChange={setSeriesId} disabled={busy} />
        <fieldset className="background-picker">
          <legend>Couleur de l’arrière-plan</legend>
          <div
            className="background-swatch"
            style={{
              backgroundColor: /^#[0-9a-f]{6}$/i.test(backgroundHex)
                ? backgroundHex
                : "#FFFFFF",
            }}
            aria-hidden="true"
          />
          <label>
            <span>Nom de la couleur</span>
            <input
              type="text"
              value={backgroundName}
              maxLength={50}
              disabled={busy}
              placeholder="Ex. : beige clair"
              required
              onChange={(event) => setBackgroundName(event.target.value)}
            />
          </label>
          <label>
            <span>Code hexadécimal</span>
            <input
              type="text"
              value={backgroundHex}
              maxLength={7}
              disabled={busy}
              placeholder="#F5F0E6"
              pattern="#[0-9A-Fa-f]{6}"
              title="Utilise un code à six chiffres, par exemple #F5F0E6."
              required
              onChange={(event) => setBackgroundHex(event.target.value)}
            />
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
          <span>{file ? formatBytes(file.size) : "ou clique pour choisir un fichier · 250 Mo et 30 minutes maximum"}</span>
          <input
            type="file"
            accept="audio/*,video/*,.mp3,.wav,.m4a,.flac,.webm,.mp4,.mov,.mkv,.avi"
            disabled={busy}
            onChange={(event) => selectFiles(event.target.files)}
          />
        </label>
        <button type="submit" disabled={busy || !file || seriesId === "__new__"}>
          <span>{busy ? "Import en cours…" : "Préparer mon audio"}</span>
          <span aria-hidden="true">→</span>
        </button>
      </form>

      {error ? <section className="error-box" role="alert">{error}</section> : null}
    </>
  );
};

const Dashboard = () => {
  const [projects, setProjects] = useState([]);
  const [series, setSeries] = useState([]);
  const [activeSeries, setActiveSeries] = useState(new URLSearchParams(window.location.search).get("series") || "");
  const [creatingSeries, setCreatingSeries] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [projectToDelete, setProjectToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const openSeries = (id) => {
    setActiveSeries(id);
    window.history.pushState({}, "", id ? `/dashboard?series=${encodeURIComponent(id)}` : "/dashboard");
  };
  useEffect(() => {
    const handleBack = () => setActiveSeries(new URLSearchParams(window.location.search).get("series") || "");
    window.addEventListener("popstate", handleBack);
    return () => window.removeEventListener("popstate", handleBack);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;

    const loadProjects = async () => {
      try {
        const response = await fetch("/api/projects");
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Impossible de charger les projets.");
        const foldersResponse = await fetch("/api/series");
        const folders = await foldersResponse.json();
        if (!foldersResponse.ok) throw new Error(folders.error || "Impossible de charger les dossiers.");
        if (cancelled) return;
        setSeries(folders);
        setProjects(data);
        setError("");
        setLoading(false);

      } catch (caught) {
        if (!cancelled) {
          setError(caught.message);
          setLoading(false);
        }
      } finally {
        if (!cancelled) timer = window.setTimeout(loadProjects, 1500);
      }
    };

    loadProjects();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const deleteProject = async () => {
    if (!projectToDelete || deleting) return;
    setDeleting(true);
    setDeleteError("");

    try {
      const response = await fetch(`/api/projects/${projectToDelete.id}`, {
        method: "DELETE",
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Impossible de supprimer le projet.");
      }
      setProjects((current) =>
        current.filter((project) => project.id !== projectToDelete.id),
      );
      setProjectToDelete(null);
    } catch (caught) {
      setDeleteError(caught.message);
    } finally {
      setDeleting(false);
    }
  };

  const selectedSeries = series.find((entry) => entry.id === activeSeries);
  const visibleProjects = projects.filter((project) => (project.seriesId || "") === activeSeries);

  return (
    <section className="dashboard">
      <div className="section-title">
        <div>
          <p className="eyebrow">BIBLIOTHÈQUE</p>
          <h1 className="dashboard-title">{selectedSeries?.name || "Tes projets sauvegardés"}</h1>
        </div>
        <span className="count">{activeSeries ? visibleProjects.length : projects.length} vidéo{(activeSeries ? visibleProjects.length : projects.length) > 1 ? "s" : ""}</span>
      </div>
      <div className="dashboard-folder-actions">
        {activeSeries ? <button type="button" className="secondary-button" onClick={() => openSeries("")}>← Tous les dossiers</button> : <button type="button" className="secondary-button" onClick={() => setCreatingSeries((current) => !current)}>+ Nouveau dossier</button>}
        {activeSeries ? <a className="nav-button nav-button-primary" href={`/?series=${encodeURIComponent(activeSeries)}`}>+ Vidéo dans cette série</a> : null}
      </div>
      {creatingSeries && !activeSeries ? <section className="folder-create-card"><SeriesCreator onCreated={(entry) => { setSeries((current) => [...current, { ...entry, projectCount: 0 }]); setCreatingSeries(false); }} onCancel={() => setCreatingSeries(false)} /></section> : null}
      {!activeSeries ? <div className="series-grid">{series.map((entry) => <button type="button" className="series-card" key={entry.id} onClick={() => openSeries(entry.id)}>
        <img src={entry.imageUrl} alt="" /><span><strong>▣ {entry.name}</strong><small>{entry.projectCount} vidéo(s)</small></span>
      </button>)}</div> : null}
      {selectedSeries ? <div className="selected-series dashboard-series"><img src={selectedSeries.imageUrl} alt="Image d’introduction de la série" /><p>Chaque épisode utilise cette image d’introduction avec son propre cadrage du zoom.</p></div> : null}
      {!activeSeries && projects.length ? <h2 className="outside-folder-title">Vidéos sans dossier</h2> : null}

      {loading ? <p className="empty-state">Chargement des projets…</p> : null}
      {error ? <section className="error-box" role="alert">{error}</section> : null}
      {!loading && !error && !visibleProjects.length ? (
        <div className="empty-state">
          <strong>{activeSeries ? "Aucune vidéo dans ce dossier." : "Aucune vidéo sans dossier."}</strong>
          <p>{activeSeries ? "Ajoute le premier épisode de cette série." : "Les vidéos créées sans dossier apparaîtront ici."}</p>
          <a className="inline-link" href={activeSeries ? `/?series=${encodeURIComponent(activeSeries)}` : "/"}>Créer une vidéo →</a>
        </div>
      ) : null}

      <div className="projects-grid">
        {visibleProjects.map((project) => (
          <article className="project-card" key={project.id}>
            <button
              className="project-delete-button"
              type="button"
              title={`Supprimer ${project.title}`}
              aria-label={`Supprimer le projet ${project.title}`}
              onClick={() => {
                setDeleteError("");
                setProjectToDelete(project);
              }}
            >
              ×
            </button>
            <a className="project-card-link" href={`/projects/${project.id}`}>
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
                <span className="format-pill">{project.outputFormat?.height === 1920 ? "Vertical 9:16" : project.visualFormat?.label || "Horizontal 16:9"}</span>
              </div>
              <div className="project-card-copy">
                <strong>{project.title}</strong>
                <span>{formatDate(project.createdAt)}</span>
                <div className="project-meta">
                  <span>{project.imageCount} image{project.imageCount > 1 ? "s" : ""}</span>
                  <span>{formatDuration(project.duration)}</span>
                </div>
                <span>{project.phase} · {project.progress} %</span>
                {project.pendingRetouches ? <span>{project.pendingRetouches} retouche(s) en cours ou en attente</span> : null}
                {["queued", "running"].includes(project.export?.status) ? <span>Export {project.export.status === "queued" ? "en attente" : "en cours"}</span> : null}
                {project.status === "failed" && project.error ? (
                  <p className="project-card-error" role="alert">{project.error}</p>
                ) : null}
              </div>
            </a>
          </article>
        ))}
      </div>

      {projectToDelete ? (
        <div
          className="confirmation-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting) {
              setProjectToDelete(null);
            }
          }}
        >
          <section
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-project-title"
          >
            <p className="eyebrow">SUPPRESSION DÉFINITIVE</p>
            <h2 id="delete-project-title">Supprimer ce projet ?</h2>
            <p>
              « {projectToDelete.title} » ainsi que son audio, ses images,
              leurs différentes versions et toutes les données associées seront
              supprimés.
            </p>
            {deleteError ? (
              <p className="scene-action-error">{deleteError}</p>
            ) : null}
            <div className="confirmation-actions">
              <button
                className="confirmation-cancel"
                type="button"
                disabled={deleting}
                onClick={() => setProjectToDelete(null)}
              >
                Annuler
              </button>
              <button
                className="confirmation-delete"
                type="button"
                disabled={deleting}
                onClick={deleteProject}
              >
                {deleting ? "Suppression…" : "Supprimer"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
};

const ProjectPage = ({ id }) => {
  const { project, error, accept, saveTiming, saveComposition } = useProject(id);
  if (!project) return <p className="empty-state">{error || "Chargement du projet…"}</p>;

  if (project.status === "draft" && project.audioPreparation) return <>
    <section className="project-heading"><a className="back-link" href="/dashboard">← Retour au dashboard</a>
      <h1 className="project-title">{project.title}</h1>
      <p className="project-date">{project.videoLayout?.enabled ? "Vidéo verticale 9:16 · Illustrations 4:5" : project.visualFormat?.label} · Audio à préparer</p>
    </section>
    {error ? <p className="scene-action-error" role="status">{error}</p> : null}
    <AudioPreparation project={project} onProjectChange={accept} />
  </>;

  return (
    <>
      <section className="project-heading">
        <a className="back-link" href="/dashboard">← Retour au dashboard</a>
        <h1 className="project-title">{project.title}</h1>
        <p className="project-date">
          Créé le {formatDate(project.createdAt)} · {project.images.length} scène(s) ·{" "}
          {formatDuration(project.audioDuration || project.segments.at(-1)?.end || 0)} ·{" "}
          {project.videoLayout?.enabled ? "Vidéo verticale 9:16 · Illustrations 4:5" : project.visualFormat?.label || "Horizontal 16:9"}
        </p>
      </section>
      {error ? <p className="scene-action-error" role="status">{error}</p> : null}
      <ApprovedAudio project={project} />
      {project.status !== "completed" ? (
        <Progress project={project} completedImages={project.images.filter((image) => image.src || image.initialTask?.status === "failed").length} />
      ) : null}
      {project.status === "failed" && project.error ? (
        <section className="error-box" role="alert">
          <strong>Cause de l’échec : </strong>{project.error}
          <button type="button" onClick={() => writeJson(`/api/projects/${id}/resume`).then(accept).catch(() => {})}>Reprendre le traitement</button>
        </section>
      ) : null}
      <ProjectContent
        project={project}
        live={["queued", "working"].includes(project.status)}
        editable
        onProjectChange={accept}
        onTimingChange={saveTiming}
        onCompositionChange={saveComposition}
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
  onTimingChange,
  onCompositionChange,
}) => {
  const images = [...project.images].sort((a, b) => a.index - b.index);
  const duration = project.audioDuration || project.segments.at(-1)?.end || images.at(-1)?.end || 1;
  const successfulCount = images.filter((image) => image.src && !image.error).length;
  const visualFormat = project.visualFormat || {
    id: "horizontal",
    width: 1536,
    height: 864,
  };

  return (
    <>
      {project.audioUrl && images.length ? (
        <EditorWorkspace
          project={project}
          images={images}
          duration={duration}
          visualFormat={visualFormat}
          onProjectChange={onProjectChange}
          onTimingChange={onTimingChange}
          onCompositionChange={onCompositionChange}
        />
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

const EditorWorkspace = ({ project, images, duration, visualFormat, onProjectChange, onTimingChange, onCompositionChange }) => {
  const playerRef = useRef(null);
  const [exportError, setExportError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const exportState = project.export || { status: "idle" };
  const exporting = submitting || ["queued", "running"].includes(exportState.status);
  const durationInFrames = Math.max(1, Math.ceil(duration * FPS));
  const output = outputFormat(project);

  useEffect(() => {
    const togglePlayback = (event) => {
      if (event.code !== "Space" || event.repeat) return;

      const target = event.target;
      const isInteractive =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName));

      if (isInteractive) return;

      event.preventDefault();
      const player = playerRef.current;
      if (!player) return;

      if (player.isPlaying()) {
        player.pause();
      } else {
        player.play();
      }
    };

    window.addEventListener("keydown", togglePlayback);
    return () => window.removeEventListener("keydown", togglePlayback);
  }, []);

  const startExport = async () => {
    setSubmitting(true);
    setExportError("");
    try {
      await Promise.all([...pendingWrites]);
      onProjectChange(await writeJson(`/api/projects/${project.id}/export`));
    } catch (caught) {
      setExportError(caught.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
    <section className={`video-section editor-workspace ${project.intro ? "editor-with-intro" : ""}`}>
      <div className="editor-toolbar">
        <div>
          <strong>Montage final</strong>
          <span>
            {exporting
              ? exportState.status === "queued" ? "Export en attente…" : "Création du MP4. Tu peux continuer le montage."
              : exportState.status === "ready"
                ? exportState.isCurrent ? "La vidéo est prête." : "Le montage a changé. L’export disponible correspond à la version précédente."
                : project.intro && !project.intro.targetConfigured ? "Choisis le cadrage du zoom de l’introduction avant d’exporter."
                  : exportState.canExport ? "Tes images, tes versions et tes timings actuels." : "Monte déjà la vidéo : les images remplaceront les scènes provisoires."}
          </span>
        </div>
        {exportState.status === "ready" && exportState.downloadUrl ? (
          <a className="export-button export-ready" href={exportState.downloadUrl}>
            Télécharger la vidéo ↓
          </a>
        ) : null}
        {!(exportState.status === "ready" && exportState.isCurrent) ? (
          <button
            className="export-button"
            type="button"
            disabled={exporting || !exportState.canExport}
            onClick={startExport}
          >
            {exporting
              ? "Export en cours…"
              : exportState.status === "failed"
                ? "Réessayer l’export"
                : "Exporter la vidéo"}
          </button>
        ) : null}
      </div>
      {exportError || exportState.error ? (
        <p className="export-error">{exportError || exportState.error}</p>
      ) : null}
      <div className="player-shell">
        <Player
          ref={playerRef}
          component={StoryboardVideo}
          inputProps={{
            audioUrl: project.audioUrl,
            scenes: images,
            audioDuration: duration,
            project,
          }}
          durationInFrames={durationInFrames}
          compositionWidth={output.width}
          compositionHeight={output.height}
          fps={FPS}
          controls
          style={{
            height: "100%",
            width: "auto",
            maxWidth: "100%",
            maxHeight: "100%",
            aspectRatio: `${output.width} / ${output.height}`,
            margin: "0 auto",
            flex: "0 1 auto",
          }}
          initiallyShowControls
        />
      </div>
      <TimelineEditor
        project={project}
        playerRef={playerRef}
        fps={FPS}
        onTimingChange={onTimingChange}
        onCompositionChange={onCompositionChange}
      />
    </section>
    <CompositionEditor project={project} onChange={onCompositionChange} playerRef={playerRef} />
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
  const initialPending = ["queued", "running", "retrying"].includes(image.initialTask?.status);
  const regenerationPending = ["queued", "running", "retrying"].includes(image.regeneration?.status);
  const task = regenerationPending ? image.regeneration : image.initialTask;
  const taskLabel = task?.status === "running" ? "Génération en cours…"
    : task?.status === "retrying" ? "Attente de l’API · reprise automatique"
      : regenerationPending ? "Retouche prioritaire en attente…" : "Image en attente…";

  const regenerate = async (event) => {
    event.preventDefault();
    setWorking(true);
    setError("");

    try {
      const project = await writeJson(`/api/projects/${projectId}/scenes/${image.index}/regenerate`, { instructions });
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
      const project = await writeJson(`/api/projects/${projectId}/scenes/${image.index}/select-version`, { versionId });
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
        ) : image.src ? (
          <img src={image.src} alt={`Illustration à ${image.timestamp} : ${image.text}`} loading="lazy" />
        ) : (
          <div className="scene-placeholder">
            <strong>Scène {image.index + 1}</strong>
            <p>{image.description || image.text}</p>
            <small>{taskLabel}</small>
          </div>
        )}
        {working || regenerationPending ? <div className="scene-working"><span className="project-spinner" /><span>{working ? "Enregistrement…" : taskLabel}</span></div> : null}
      </div>

      <div className="scene-copy">
        <div className="scene-copy-heading">
          <span className="timestamp">{image.timestamp}</span>
          {editable ? (
            <button
              className="regenerate-toggle"
              type="button"
              disabled={working || initialPending || regenerationPending}
              aria-expanded={showRegeneration}
              onClick={() => setShowRegeneration((current) => !current)}
            >
              ↻ Régénérer
            </button>
          ) : null}
        </div>
        <p>{image.text}</p>

        {showRegeneration ? (
          <form className="regeneration-form" onSubmit={regenerate}>
            {image.error ? (
              <p className="regeneration-help">
                Le prompt de base sera automatiquement reformulé de façon
                claire et conforme avant une nouvelle génération. Tu peux
                ajouter une précision ci-dessous, mais ce n’est pas obligatoire.
              </p>
            ) : null}
            <label>
              {image.error ? "Précisions facultatives" : "Instructions supplémentaires"}
              <textarea
                value={instructions}
                maxLength={1500}
                rows={3}
                placeholder={
                  image.error
                    ? "Ex. : représente le retard avec une horloge et une flèche."
                    : "Ex. : remplace la flèche rouge par une flèche bleue, sans changer le personnage."
                }
                onChange={(event) => setInstructions(event.target.value)}
              />
            </label>
            <button type="submit" disabled={working || initialPending || regenerationPending}>
              <span>
                {working
                  ? image.error
                    ? "Reformulation et génération…"
                    : "Régénération…"
                  : image.error
                    ? "Reformuler et générer l’image"
                    : "Créer une nouvelle version"}
              </span>
              <span>→</span>
            </button>
          </form>
        ) : null}
        {error ? <p className="scene-action-error">{error}</p> : null}
        {image.regeneration?.status === "failed" ? <p className="scene-action-error">{image.regeneration.error}</p> : null}
      </div>
    </article>
  );
};

const statusLabel = (status) =>
  ({ draft: "Audio à préparer", completed: "Terminé", working: "En cours", queued: "En attente", failed: "Échec" })[status] || status;

const formatDate = (date) =>
  new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(date));

const formatBytes = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} Ko`
    : `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

const formatDuration = (seconds) =>
  `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
