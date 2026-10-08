import { useCallback, useEffect, useRef, useState } from "react";
import { latestProject, readJson, trackWrite, withTimings, writeJson } from "./project-sync.js";

export function useProject(id) {
  const [project, setProject] = useState(null);
  const [error, setError] = useState("");
  const serverProject = useRef(null);
  const pending = useRef(new Map());
  const sequence = useRef(0);
  const timingChain = useRef(Promise.resolve());

  const accept = useCallback((data) => {
    serverProject.current = latestProject(serverProject.current, data);
    setProject(withTimings(serverProject.current, pending.current));
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
    setProject(withTimings(serverProject.current, pending.current));
    const work = timingChain.current.catch(() => {}).then(async () => {
      try {
        const data = await writeJson(`/api/projects/${id}/scenes/${imageIndex}/timing`, { start });
        if (pending.current.get(imageIndex)?.token === token) pending.current.delete(imageIndex);
        accept(data);
      } catch (caught) {
        if (pending.current.get(imageIndex)?.token === token) pending.current.delete(imageIndex);
        setProject(withTimings(serverProject.current, pending.current));
        throw caught;
      }
    });
    timingChain.current = work;
    return trackWrite(work);
  };

  return { project, error, accept, saveTiming };
}
