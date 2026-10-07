import { useEffect } from "react";
import { getIndexBuild, getMidIndexStatus, type IndexBuild } from "./index-build-client";
import { isActiveBuild } from "./index-build-state";

/** Activity polling stays mounted even when the build window is closed. */
export function useIndexBuildActivity(buildId: string | undefined, onBuild: (build: IndexBuild) => void) {
  useEffect(() => {
    let live = true;
    void getMidIndexStatus().then(status => { if (live && status.running_build) onBuild(status.running_build); }).catch(() => {});
    return () => { live = false; };
  }, [onBuild]);
  useEffect(() => {
    if (!buildId) return;
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, busy = false;
    const poll = async () => {
      clearTimeout(timer);
      if (!live || busy || document.hidden) return;
      busy = true;
      let active = true;
      try {
        const build = await getIndexBuild(buildId);
        active = isActiveBuild(build);
        if (live) onBuild(build);
      } catch { /* A transient connection error must not erase the running item. */ }
      finally { busy = false; if (live && active && !document.hidden) timer = setTimeout(poll, 1500); }
    };
    const visible = () => { if (document.hidden) clearTimeout(timer); else void poll(); };
    void poll();
    document.addEventListener("visibilitychange", visible);
    return () => { live = false; clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [buildId, onBuild]);
}
