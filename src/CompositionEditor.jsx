import React, { useEffect, useMemo, useRef, useState } from "react";
import { clamp, drawEpisodeTitle, FPS, imageRectangle, introDuration, normalizeIntro, normalizeLayout, outputFormat, verticalLayout } from "../lib/video-layout.js";
import { INTRO_DEFAULTS, VERTICAL_DEFAULTS } from "../video-defaults.js";

export const CanvasTitle = ({ project }) => {
  const output = outputFormat(project);
  const title = project.videoLayout?.title;
  const src = useMemo(() => {
    if (!title?.text.trim()) return null;
    const canvas = document.createElement("canvas"); canvas.width = output.width; canvas.height = output.height;
    drawEpisodeTitle(canvas.getContext("2d"), title, output.width, output.height);
    return canvas.toDataURL("image/png");
  }, [title, output.width, output.height]);
  return src ? <img src={src} className="canvas-title" alt="" draggable="false" /> : null;
};

const DurationField = ({ label, value, min = 0, onCommit }) => {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(Math.round(value * 1000) / 1000)); }, [value, focused]);
  const commit = () => {
    setFocused(false);
    const parsed = Number(text.replace(",", "."));
    if (!text.trim() || !Number.isFinite(parsed)) { setText(String(value)); return; }
    const next = clamp(parsed, min, 30); setText(String(next)); onCommit(next);
  };
  return <label className="duration-field"><span>{label}</span><span><input aria-label={label} inputMode="decimal" value={text} onFocus={() => setFocused(true)} onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /> s</span></label>;
};

export const CompositionEditor = ({ project, onChange, playerRef }) => {
  const [introDraft, setIntroDraft] = useState(project.intro);
  const [layoutDraft, setLayoutDraft] = useState(project.videoLayout);
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState("");
  const drag = useRef(null);
  const introRef = useRef(introDraft);
  const layoutRef = useRef(layoutDraft);
  const introSurface = useRef(null);
  const layoutSurface = useRef(null);
  useEffect(() => { if (!drag.current) { setIntroDraft(project.intro); introRef.current = project.intro; setLayoutDraft(project.videoLayout); layoutRef.current = project.videoLayout; } }, [project.intro, project.videoLayout]);
  const save = async (patch) => {
    setSaving((count) => count + 1); setError("");
    try { await onChange(patch); }
    catch (caught) { setError(caught.message); setIntroDraft(project.intro); introRef.current = project.intro; setLayoutDraft(project.videoLayout); layoutRef.current = project.videoLayout; }
    finally { setSaving((count) => count - 1); }
  };
  const editIntro = (patch, persist = true) => {
    const next = normalizeIntro({ ...introRef.current, ...patch });
    introRef.current = next; setIntroDraft(next);
    if (persist) void save({ intro: Object.fromEntries(["fullDuration", "zoomDuration", "holdDuration", "zoom", "targetX", "targetY", "targetConfigured"].map((key) => [key, next[key]])) });
  };
  const editLayout = (patch, persist = true) => {
    const next = normalizeLayout({ ...layoutRef.current, ...patch, title: { ...layoutRef.current?.title, ...patch.title } });
    layoutRef.current = next; setLayoutDraft(next);
    if (persist) void save({ videoLayout: next });
  };
  const beginIntro = (event, resize = false) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = introSurface.current.getBoundingClientRect();
    drag.current = { kind: resize ? "resize" : "intro", pointerId: event.pointerId, x: event.clientX, size: 1 / introRef.current.zoom, bounds };
    if (!resize) editIntro({ targetX: (event.clientX - bounds.left) / bounds.width, targetY: (event.clientY - bounds.top) / bounds.height, targetConfigured: true }, false);
  };
  const moveIntro = (event) => {
    const action = drag.current;
    if (!action || action.pointerId !== event.pointerId || !["intro", "resize"].includes(action.kind)) return;
    if (action.kind === "resize") editIntro({ zoom: 1 / clamp(action.size + 2 * (event.clientX - action.x) / action.bounds.width, 1 / 8, 1), targetConfigured: true }, false);
    else editIntro({ targetX: (event.clientX - action.bounds.left) / action.bounds.width, targetY: (event.clientY - action.bounds.top) / action.bounds.height, targetConfigured: true }, false);
  };
  const endIntro = (event) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null; editIntro({}, true);
  };
  const beginLayout = (event, kind) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { kind, pointerId: event.pointerId, originX: event.clientX, originY: event.clientY, layout: structuredClone(layoutRef.current), bounds: layoutSurface.current.getBoundingClientRect() };
  };
  const moveLayout = (event) => {
    const action = drag.current;
    if (!action || action.pointerId !== event.pointerId || !["title", "images"].includes(action.kind)) return;
    const dx = (event.clientX - action.originX) / action.bounds.width;
    const dy = (event.clientY - action.originY) / action.bounds.height;
    if (action.kind === "title") editLayout({ title: { x: action.layout.title.x + dx, y: action.layout.title.y + dy } }, false);
    else {
      const rect = imageRectangle({ ...project, videoLayout: action.layout });
      editLayout({ imagePosition: action.layout.imagePosition + dy * 1920 / (1920 - rect.height) }, false);
    }
  };
  const endLayout = (event) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null; editLayout({}, true);
  };
  const previewProject = { ...project, videoLayout: layoutDraft };
  const rect = imageRectangle(previewProject);
  const frame = outputFormat(previewProject);
  const firstImage = project.images.find((image) => image.src);
  if (!project.intro && project.visualFormat.id !== "vertical") return null;
  return <div className="composition-editor">
    {project.intro && introDraft ? <details className="composition-panel" open>
      <summary>Introduction de série · {project.series?.name || "Série"}</summary>
      <div className="composition-panel-body">
        <div className="intro-crop-surface" ref={introSurface} style={{ aspectRatio: `${outputFormat(project).width}/${outputFormat(project).height}`, background: project.backgroundColor?.hex }} onPointerDown={(event) => beginIntro(event)} onPointerMove={moveIntro} onPointerUp={endIntro} onPointerCancel={endIntro}>
          <img src={project.intro.src} alt="Clique sur l’épisode à mettre en avant" draggable="false" />
          <div className="intro-crop-frame" style={{ width: `${100 / introDraft.zoom}%`, height: `${100 / introDraft.zoom}%`, left: `${(introDraft.targetX - 0.5 / introDraft.zoom) * 100}%`, top: `${(introDraft.targetY - 0.5 / introDraft.zoom) * 100}%` }}>
            <span>Cadrage final</span><button type="button" aria-label="Redimensionner le cadrage du zoom" className="crop-resize-handle" onPointerDown={(event) => beginIntro(event, true)} onPointerMove={moveIntro} onPointerUp={endIntro} onPointerCancel={endIntro} />
          </div>
        </div>
        <div className="composition-controls">
          <p className="editor-hint">Clique et glisse sur l’épisode du jour. Ajuste le zoom ou la poignée du cadre pour choisir ce qui remplira l’écran.</p>
          <label className="control-slider">Degré de zoom <strong>×{introDraft.zoom.toFixed(2)}</strong><input aria-label="Degré de zoom" type="range" min={1} max={8} step={0.05} value={introDraft.zoom} onChange={(event) => editIntro({ zoom: Number(event.target.value), targetConfigured: true })} /></label>
          <DurationField label="Image entière" value={introDraft.fullDuration} onCommit={(value) => editIntro({ fullDuration: value })} />
          <DurationField label="Mouvement de zoom" value={introDraft.zoomDuration} min={1 / FPS} onCommit={(value) => editIntro({ zoomDuration: value })} />
          <DurationField label="Image zoomée" value={introDraft.holdDuration} onCommit={(value) => editIntro({ holdDuration: value })} />
          <p className="editor-hint">Durée totale : {introDuration(introDraft).toFixed(2)} s. L’audio et les illustrations continuent sous l’introduction.</p>
          <div className="series-actions"><button type="button" className="secondary-button" onClick={() => { playerRef.current?.seekTo(0); playerRef.current?.play(); }}>▶ Voir l’introduction</button><button type="button" className="secondary-button" onClick={() => editIntro(INTRO_DEFAULTS)}>Durées par défaut</button></div>
          <p className={introDraft.targetConfigured ? "editor-hint" : "intro-required"}>{introDraft.targetConfigured ? "Cadrage choisi pour cet épisode." : "Choisis le cadrage de cet épisode avant d’exporter."}</p>
        </div>
      </div>
    </details> : null}
    {project.visualFormat.id === "vertical" ? <details className="composition-panel" open>
      <summary>Mise en page verticale · Vidéo 9:16, illustrations 4:5</summary>
      {!verticalLayout(previewProject) ? <div className="composition-controls"><p>Ce projet utilise encore son ancien cadre 4:5.</p><button type="button" onClick={() => editLayout({ ...VERTICAL_DEFAULTS, enabled: true })}>Adapter le montage au 9:16</button></div> : <div className="composition-panel-body">
        <div ref={layoutSurface} className="layout-preview" style={{ background: project.backgroundColor?.hex }}>
          <div className="layout-preview-images" style={{ left: `${rect.x / frame.width * 100}%`, top: `${rect.y / frame.height * 100}%`, width: `${rect.width / frame.width * 100}%`, height: `${rect.height / frame.height * 100}%` }} onPointerDown={(event) => beginLayout(event, "images")} onPointerMove={moveLayout} onPointerUp={endLayout} onPointerCancel={endLayout}>
            {firstImage ? <img src={firstImage.src} alt="Déplacer toutes les illustrations" draggable="false" /> : <span>Illustrations 4:5</span>}
          </div>
          <CanvasTitle project={previewProject} />
          {layoutDraft.title.text.trim() ? <button type="button" className="title-drag-handle" aria-label="Déplacer le titre" style={{ left: `${layoutDraft.title.x * 100}%`, top: `${layoutDraft.title.y * 100}%` }} onPointerDown={(event) => beginLayout(event, "title")} onPointerMove={moveLayout} onPointerUp={endLayout} onPointerCancel={endLayout}>↔ Déplacer le titre</button> : null}
          <span className="subtitle-guide">Zone disponible pour les sous-titres TikTok</span>
        </div>
        <div className="composition-controls">
          <label className="field-label">Titre de l’épisode<textarea value={layoutDraft.title.text} rows={2} maxLength={200} placeholder="Ex. : Les Yakuza" onChange={(event) => editLayout({ title: { text: event.target.value } })} /></label>
          <p className="editor-hint">Glisse le titre et les illustrations dans le cadre. Tous les dessins se déplacent ensemble. Le titre est masqué pendant l’introduction.</p>
          <label className="control-slider">Position verticale des illustrations<input aria-label="Position verticale des illustrations" type="range" min={0} max={1} step={0.005} value={layoutDraft.imagePosition} onChange={(event) => editLayout({ imagePosition: Number(event.target.value) })} /></label>
          <label className="control-slider">Taille de toutes les illustrations <strong>{Math.round(layoutDraft.imageScale * 100)} %</strong><input aria-label="Taille de toutes les illustrations" type="range" min={0.5} max={1} step={0.01} value={layoutDraft.imageScale} onChange={(event) => editLayout({ imageScale: Number(event.target.value) })} /></label>
          <label className="control-slider">Taille du titre<input aria-label="Taille du titre" type="range" min={24} max={140} step={1} value={layoutDraft.title.fontSize} onChange={(event) => editLayout({ title: { fontSize: Number(event.target.value) } })} /></label>
          <div className="title-controls"><label>Couleur du titre <input type="color" value={layoutDraft.title.color} onChange={(event) => editLayout({ title: { color: event.target.value } })} /></label><button type="button" className="secondary-button" onClick={() => editLayout({ title: { x: 0.5, y: 0.07 } })}>Recentrer le titre en haut</button></div>
          <p className="editor-hint">Le guide des sous-titres sert de repère dans l’éditeur. Les sous-titres seront ajoutés ensuite dans TikTok.</p>
        </div>
      </div>}
    </details> : null}
    <p className="composition-save-status" role="status">{error || (saving ? "Sauvegarde des réglages…" : "Réglages sauvegardés automatiquement")}</p>
  </div>;
};
