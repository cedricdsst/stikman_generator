import React, { useEffect, useRef, useState } from "react";
import { readJson, trackWrite } from "./project-sync.js";

export const SeriesCreator = ({ onCreated, onCancel, disabled = false }) => {
  const [name, setName] = useState("");
  const [image, setImage] = useState(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);
  const dragDepth = useRef(0);
  const locked = disabled || busy;
  const selectImage = (file) => {
    if (!file || locked) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setError("Choisis une image PNG, JPEG ou WebP."); return;
    }
    if (file.size > 20 * 1024 * 1024) {
      setError("L’image ne doit pas dépasser 20 Mo."); return;
    }
    setError(""); setImage(file);
  };
  useEffect(() => {
    if (!image) { setPreview(""); return; }
    const url = URL.createObjectURL(image); setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [image]);
  const create = async () => {
    if (!name.trim() || !image || busy) return;
    setBusy(true); setError("");
    try {
      const body = new FormData(); body.set("name", name); body.set("image", image);
      const response = await trackWrite(fetch("/api/series", { method: "POST", body }));
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Impossible de créer le dossier.");
      onCreated(data);
    } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  };
  return <div className="series-creator">
    <label>Nom de la série<input value={name} maxLength={100} disabled={disabled || busy} onChange={(event) => setName(event.target.value)} placeholder="Ex. : Les organisations criminelles" /></label>
    <div className="series-image-field">
      <span className="series-image-heading">Image d’introduction <small>Obligatoire</small></span>
      <label className={`series-image-drop ${dragging ? "dragging" : ""} ${locked ? "disabled" : ""}`}
        role="button" tabIndex={locked ? -1 : 0} aria-disabled={locked}
        aria-label={image ? "Changer l’image d’introduction" : "Ajouter une image d’introduction"}
        onKeyDown={(event) => {
          if (!locked && ["Enter", " "].includes(event.key)) { event.preventDefault(); inputRef.current?.click(); }
        }}
        onDragEnter={(event) => { event.preventDefault(); if (!locked) { dragDepth.current += 1; setDragging(true); } }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = locked ? "none" : "copy"; }}
        onDragLeave={(event) => { event.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false); selectImage(event.dataTransfer.files?.[0]); }}>
        {preview ? <img className="series-image-preview" src={preview} alt="Image de la série" draggable="false" /> : null}
        <span className="series-image-plus" aria-hidden="true">+</span>
        <strong>{dragging ? "Dépose ton image ici" : image ? "Changer l’image" : "Ajouter l’image d’introduction"}</strong>
        <span className="series-image-drop-help">Clique pour choisir un fichier ou glisse-dépose ton image ici</span>
        {image ? <span className="series-image-filename">{image.name}</span> : null}
        <input ref={inputRef} hidden tabIndex={-1} type="file" accept="image/png,image/jpeg,image/webp" disabled={locked}
          onChange={(event) => { selectImage(event.target.files?.[0]); event.target.value = ""; }} />
      </label>
    </div>
    <p className="editor-hint">PNG, JPEG ou WebP · 20 Mo maximum. Une image 9:16 remplit le cadre vertical.</p>
    {error ? <p role="alert" className="scene-action-error">{error}</p> : null}
    <div className="series-actions">
      <button type="button" disabled={disabled || busy || !name.trim() || !image} onClick={create}>{busy ? "Création…" : "Créer ce dossier"}</button>
      {onCancel ? <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Annuler</button> : null}
    </div>
  </div>;
};

export const SeriesPicker = ({ value, onChange, disabled }) => {
  const [series, setSeries] = useState([]);
  const [error, setError] = useState("");
  useEffect(() => { let cancelled = false; readJson("/api/series").then((data) => { if (!cancelled) setSeries(data); }).catch((caught) => { if (!cancelled) setError(caught.message); }); return () => { cancelled = true; }; }, []);
  const selected = series.find((entry) => entry.id === value);
  return <fieldset className="series-picker">
    <legend>Dossier de série</legend>
    <label className="field-label">Associer cette vidéo à une série
      <select disabled={disabled} value={value || ""} onChange={(event) => onChange(event.target.value)}>
        <option value="">Sans dossier</option>
        {series.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        <option value="__new__">+ Créer un nouveau dossier</option>
      </select>
    </label>
    {error ? <p role="alert" className="scene-action-error">{error}</p> : null}
    {value === "__new__" ? <SeriesCreator disabled={disabled} onCreated={(entry) => { setSeries((current) => [...current, entry]); onChange(entry.id); }} /> : null}
    {selected ? <div className="selected-series"><img src={selected.imageUrl} alt="Image d’introduction" /><p>L’image de « {selected.name} » sera ajoutée sur une piste au-dessus des illustrations. Tu choisiras le cadrage du zoom dans le montage.</p></div> : null}
  </fieldset>;
};
