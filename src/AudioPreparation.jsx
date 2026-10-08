import React, { useEffect, useRef, useState } from "react";
import { defaultAudioSettings } from "../lib/audio-humanifier/settings.js";
import { presets } from "../lib/audio-humanifier/presets.js";
import { trackWrite, writeJson } from "./project-sync.js";

const duration = (seconds) => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, "0")}`;
const sameSettings = (left, right) => right && Object.keys(defaultAudioSettings).every((key) => left[key] === right[key]);

export const AudioPreparation = ({ project, onProjectChange }) => {
  const preparation = project.audioPreparation;
  const [settings, setSettings] = useState(preparation.settings);
  const [selectedId, setSelectedId] = useState(preparation.selectedVersionId);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(0);
  const [error, setError] = useState("");
  const saveChain = useRef(Promise.resolve());
  const originalPlayer = useRef(null);
  const resultPlayer = useRef(null);
  const active = ["queued", "running"].includes(preparation.task?.status);
  const disabled = busy || active;
  const selected = preparation.versions.find((version) => version.id === selectedId);
  const changed = selected && !sameSettings(settings, selected.settings);
  const endpoint = `/api/projects/${project.id}/audio-preparation`;

  useEffect(() => {
    if (preparation.task?.status === "succeeded") setSelectedId(preparation.selectedVersionId);
  }, [preparation.task?.id, preparation.task?.status]);

  function persist(nextSettings, nextId) {
    setSaving((count) => count + 1);
    const promise = saveChain.current.catch(() => {}).then(() => writeJson(`${endpoint}/settings`, {
      settings: nextSettings, selectedVersionId: nextId,
    }));
    saveChain.current = promise;
    trackWrite(promise).then((data) => { onProjectChange(data); setError(""); })
      .catch((caught) => setError(caught.message)).finally(() => setSaving((count) => count - 1));
  }

  function change(key, value) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    persist(next, selectedId);
  }

  function choose(id) {
    const next = preparation.versions.find((version) => version.id === id)?.settings || settings;
    setSelectedId(id);
    setSettings(next);
    persist(next, id);
  }

  async function perform(action, body) {
    setError(""); setBusy(true);
    originalPlayer.current?.pause(); resultPlayer.current?.pause();
    try {
      await saveChain.current.catch(() => {});
      onProjectChange(await writeJson(`${endpoint}/${action}`, body));
    } catch (caught) { setError(caught.message); }
    finally { setBusy(false); }
  }

  const slider = (key, label, min, max, unit, hint, step = 1) => (
    <label className="audio-slider">
      <span><strong>{label}</strong><output>{settings[key]}{unit}</output></span>
      <input type="range" min={min} max={max} step={step} value={settings[key]} aria-label={label}
        onChange={(event) => change(key, Number(event.target.value))} />
      <small>{hint}</small>
    </label>
  );

  return (
    <section className="audio-workspace">
      <div className="audio-step-heading">
        <div><p className="eyebrow">ÉTAPE 1 · PRÉPARER LA VOIX</p><h2>Écoute, ajuste, puis crée ta vidéo.</h2></div>
        <span className="count">AudioHumanifier · local</span>
      </div>
      <p className="audio-intro">Les réglages et les essais restent sauvegardés dans ce projet. Chaque traitement repart de ton fichier d’origine. La génération des images attend ta validation.</p>
      <div className="audio-layout">
        <div className="audio-controls">
          <fieldset disabled={disabled}>
            <legend>Caractère de la voix</legend>
            <div className="audio-presets">
              {Object.entries(presets).map(([id, preset]) => (
                <label className={settings.preset === id ? "selected" : ""} key={id}>
                  <input type="radio" name="audio-preset" value={id} checked={settings.preset === id} onChange={() => change("preset", id)} />
                  <strong>{preset.label}</strong><small>{preset.description}</small>
                </label>
              ))}
            </div>
            <div className="audio-sliders">
              {slider("intensity", "Intensité", 0, 100, " %", "Du traitement discret à une voix plus marquée.")}
              {slider("pauseReduction", "Réduction des pauses", 0, 100, " %", "Raccourcit les blancs en conservant de courtes pauses naturelles.")}
              {slider("speed", "Vitesse", 80, 120, " %", "Ajuste le débit sans changer la hauteur globale.")}
              {slider("sibilanceReduction", "Sifflantes S / CH", 0, 100, " %", "Atténue les consonnes sifflantes.")}
              {slider("minimumPauseMs", "Pause minimale intacte", 80, 1000, " ms", "Les pauses sous ce seuil restent intactes.", 20)}
            </div>
            <label className="audio-toggle"><input type="checkbox" checked={settings.localVariations} onChange={(event) => change("localVariations", event.target.checked)} />
              <span><strong>Variations locales par phrase</strong><small>De légères variations de hauteur et de rythme.</small></span>
            </label>
            <button className="audio-secondary" type="button" onClick={() => change("seed", Math.floor(Math.random() * 2147483647))}>Varier les nuances au prochain essai</button>
          </fieldset>
          <p className="audio-save-state" role="status">{saving ? "Enregistrement des réglages…" : error ? "Vérifie le message d’erreur avant de continuer." : "Réglages sauvegardés"}</p>
          <button disabled={disabled} type="button" onClick={() => perform("process", { settings })}>
            {active ? project.phase : !preparation.original ? "Réessayer l’import audio" : preparation.versions.length ? "Créer un nouvel essai audio" : "Humaniser la voix"}<span aria-hidden="true">→</span>
          </button>
        </div>
        <div className="audio-listening">
          <div className="audio-player-card">
            <p className="eyebrow">AVANT · ORIGINAL</p>
            {preparation.original ? <><audio ref={originalPlayer} controls preload="metadata" src={preparation.original.previewUrl} onPlay={() => resultPlayer.current?.pause()} aria-label="Écouter l’audio original" />
              <small>{duration(preparation.original.analysis.durationSeconds)}</small></> : <p role="status">{active ? project.phase : "L’audio n’a pas encore pu être préparé."}</p>}
          </div>
          <div className="audio-player-card audio-result-card">
            <p className="eyebrow">APRÈS · VERSION À UTILISER</p>
            <label className="audio-version-label">Choisir une version
              <select value={selectedId} disabled={disabled || !preparation.original} onChange={(event) => choose(event.target.value)}>
                <option value="original">Original · sans humanisation</option>
                {preparation.versions.map((version, index) => <option key={version.id} value={version.id}>Essai {index + 1} · {presets[version.settings.preset].label} · {duration(version.analysis.durationSeconds)}</option>)}
              </select>
            </label>
            {selected ? <>
              <audio key={selected.id} ref={resultPlayer} controls preload="metadata" src={selected.previewUrl} onPlay={() => originalPlayer.current?.pause()} aria-label="Écouter l’audio traité" />
              <p>{duration(selected.analysis.durationSeconds)} · Pic : {selected.analysis.maxVolumeDb?.toFixed(1) ?? "—"} dBFS</p>
              <a className="inline-link" href={selected.downloadUrl} download>Télécharger cet essai en WAV ↓</a>
              {selected.qualityWarning ? <p role="status">{selected.qualityWarning}</p> : null}
            </> : <p>Tu peux utiliser l’original ou créer un essai avec les réglages à gauche.</p>}
            {changed ? <p className="audio-notice" role="status">Les réglages ont changé. Crée un nouvel essai pour les écouter avant de valider.</p> : null}
          </div>
          {active ? <p className="audio-notice" role="status">{project.phase} Tu peux revenir au dashboard : le traitement continue.</p> : null}
          {preparation.task?.error ? <p className="error-box" role="alert">{preparation.task.error}</p> : null}
          {error ? <p className="error-box" role="alert">{error}</p> : null}
          <div className="audio-approval">
            <strong>La voix te convient ?</strong>
            <p>La transcription, les images et le montage seront basés sur {selected ? "cet essai" : "l’audio original"}.</p>
            <button disabled={disabled || !preparation.original || Boolean(changed)} type="button" onClick={() => perform("approve", { versionId: selectedId })}>
              {busy ? "Enregistrement…" : selected ? "Valider cet audio et créer la vidéo" : "Créer la vidéo avec l’original"}<span aria-hidden="true">→</span>
            </button>
          </div>
        </div>
      </div>
    </section>
  );
};

export const ApprovedAudio = ({ project }) => {
  const preparation = project.audioPreparation;
  if (!preparation?.approvedVersionId) return null;
  const index = preparation.versions.findIndex((version) => version.id === preparation.approvedVersionId);
  const selected = index < 0 ? preparation.original : preparation.versions[index];
  if (!selected) return null;
  return <details className="audio-approved">
    <summary>Audio validé · {index < 0 ? "Original" : `Essai ${index + 1} · ${presets[selected.settings.preset].label}`} · {duration(selected.analysis.durationSeconds)}</summary>
    <p>Cette piste est conservée pour la transcription et le montage. Les réglages audio sont figés pour garder les images synchronisées.</p>
    <a className="inline-link" href={selected.downloadUrl} download>{index < 0 ? "Télécharger le fichier source" : "Télécharger l’essai validé en WAV"} ↓</a>
  </details>;
};
