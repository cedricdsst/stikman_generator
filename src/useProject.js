import { useCallback, useEffect, useRef, useState } from "react";
import { latestProject, readJson, trackWrite, withTimings, writeJson } from "./project-sync.js";

export function useProject(id) {
  const [project, setProject] = useState(null);
  const [error, setError] = useState("");
  const serverProject = useRef(null);
  const pending = useRef(new Map());
  const sequence = useRef(0);
  const timingChain = useRef(Promise.resolve());
  const pendingComposition = useRef(new Map());

  const withEdits = (data) => {
    const next = withTimings(data, pending.current);
    if (!next || !pendingComposition.current.size) return next;
    const result = { ...next };
    for (const { patch } of pendingComposition.current.values()) {
      if (patch.intro) result.intro = { ...result.intro, ...patch.intro };
      if (patch.videoLayout) result.videoLayout = { ...result.videoLayout, ...patch.videoLayout, title: { ...result.videoLayout?.title, ...patch.videoLayout.title } };
    }
    // The local title is drawn with the same canvas routine as the exported PNG.
    result.titleUrl = null;
    return result;
  };

  const accept = useCallback((data) => {
    serverProject.current = latestProject(serverProject.current, data);
    setProject(withEdits(serverProject.current));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer;
    const load = async () => {
      try {
        const data = await readJson(`/api/projects/${id}`);
        if (!cancelled) { accept(data); setError(""); }
      } catch (caught) {
        if (!cancelled) setError(`Connexion interrompue, nouvelle tentative automatique. ${caught.message}`);
      } finally {
        if (!cancelled) timer = window.setTimeout(load, 1300);
      }
    };
    load();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [id, accept]);

  const saveTiming = (imageIndex, start) => {
    const token = ++sequence.current;
    pending.current.set(imageIndex, { start, token });
    setProject(withEdits(serverProject.current));
    const work = timingChain.current.catch(() => {}).then(async () => {
      try {
        const data = await writeJson(`/api/projects/${id}/scenes/${imageIndex}/timing`, { start });
        if (pending.current.get(imageIndex)?.token === token) pending.current.delete(imageIndex);
        accept(data);
      } catch (caught) {
        if (pending.current.get(imageIndex)?.token === token) pending.current.delete(imageIndex);
        setProject(withEdits(serverProject.current));
        throw caught;
      }
    });
    timingChain.current = work;
    return trackWrite(work);
  };

  const saveComposition = (patch) => {
    const token = ++sequence.current;
    pendingComposition.current.set(token, { patch });
    setProject(withEdits(serverProject.current));
    const work = timingChain.current.catch(() => {}).then(async () => {
      try {
        const data = await writeJson(`/api/projects/${id}/composition`, patch);
        pendingComposition.current.delete(token);
        accept(data);
      } catch (caught) {
        pendingComposition.current.delete(token);
        setProject(withEdits(serverProject.current));
        throw caught;
      }
    });
    timingChain.current = work;
    return trackWrite(work);
  };
  return { project, error, accept, saveTiming, saveComposition };
}
