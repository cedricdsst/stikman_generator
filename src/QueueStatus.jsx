import React, { useEffect, useState } from "react";

export const QueueStatus = () => {
  const [state, setState] = useState(null);
  useEffect(() => {
    let cancelled = false;
    let timer;
    const load = async () => {
      try {
        const response = await fetch("/api/queue");
        if (response.ok && !cancelled) setState(await response.json());
      } catch { /* Project views report connection failures. */ }
      finally { if (!cancelled) timer = window.setTimeout(load, 1500); }
    };
    load();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);
  if (!state) return null;
  const images = state.images;
  return (
    <details className="queue-status">
      <summary>
        <strong>Travaux en arrière-plan</strong>
        <span>{images.active}/{images.concurrency} générations · {state.projects.length} projet(s) · {images.priorityQueued} retouche(s) en attente</span>
      </summary>
      <p>{images.requestsPerMinute} demandes d’image/min maximum. Les retouches prennent la prochaine place libre. Les nouveaux projets passent dans l’ordre.</p>
      {images.cooldownUntil ? <p role="status">L’API demande une attente. Reprise automatique des générations.</p> : null}
      {state.projects.map((project, index) => (
        <a key={project.id} href={`/projects/${project.id}`}>
          <strong>{index + 1}. {project.title}</strong><span>{project.phase} · {project.progress} %</span>
        </a>
      ))}
      <p>{state.exports.active} export en cours · {state.exports.queued} en attente.</p>
      {state.audio ? <p>{state.audio.active} traitement audio en cours · {state.audio.queued} en attente.</p> : null}
      {state.audio?.projects.map((project) => <a key={project.id} href={`/projects/${project.id}`}><strong>{project.title}</strong><span>{project.phase}</span></a>)}
    </details>
  );
};
