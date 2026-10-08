import React, { useEffect, useState } from "react";
import { readJson, trackWrite } from "./project-sync.js";

export const SeriesCreator = ({ onCreated, onCancel, disabled = false }) => {
  const [name, setName] = useState("");
  const [image, setImage] = useState(null);
  const [preview, setPreview] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
    <label>Image d’introduction obligatoire<input type="file" accept="image/png,image/jpeg,image/webp" disabled={disabled || busy} onChange={(event) => setImage(event.target.files?.[0] || null)} /></label>
    <p className="editor-hint">PNG, JPEG ou WebP · 20 Mo maximum. Une image 9:16 remplit le cadre vertical.</p>
    {preview ? <img className="series-image-preview" src={preview} alt="Image de la série" /> : null}
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
