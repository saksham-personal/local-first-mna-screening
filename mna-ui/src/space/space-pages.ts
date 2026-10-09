import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSpace } from "./space-client";
import { canLoadMore, firstLoad, mergePage, nextPage, spaceMaxPageSize, spacePageSize, type SpaceLoad, type SpaceSearch } from "./space-model";

// One session per search. Aborting it cancels its requests, so a page for an older search cannot land.
type Session = { search: SpaceSearch; controller: AbortController; pending: Set<number>; inFlight?: Promise<boolean> };

const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useSpacePages({ source, search, bundleId, onFirstPage }: {
  source: "MID" | "ISCC";
  search: SpaceSearch;
  bundleId?: string;
  onFirstPage?: () => void;
}) {
  const [load, setLoad] = useState<SpaceLoad>();
  const [elapsed, setElapsed] = useState<number>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [moreBusy, setMoreBusy] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [moreError, setMoreError] = useState("");
  const session = useRef<Session | undefined>(undefined);
  const latest = useRef<SpaceLoad | undefined>(undefined);
  const failure = useRef("");
  const firstPage = useRef(onFirstPage);
  firstPage.current = onFirstPage;
  // ISCC is one call that does not depend on the MID bundle, so a bundle change must not rerun it.
  const scope = source === "MID" ? bundleId : undefined;

  const commit = useCallback((next: SpaceLoad | undefined) => {
    latest.current = next;
    setLoad(next);
  }, []);

  // A new search, source or bundle replaces the rows and cancels whatever was still loading.
  useEffect(() => {
    const controller = new AbortController();
    session.current = { search, controller, pending: new Set() };
    failure.current = "";
    setMoreError("");
    setMoreBusy(false);
    setLoadingAll(false);
    commit(undefined);
    setError("");
    setElapsed(undefined);
    if (source === "ISCC" && search.kind !== "iscc") {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    const started = performance.now();
    const first = async () => {
      try {
        const page = await fetchSpace(search, 0, spacePageSize, controller.signal);
        if (controller.signal.aborted) return;
        commit(firstLoad(page));
        setElapsed(performance.now() - started);
        firstPage.current?.();
      } catch (e) {
        if (!controller.signal.aborted) setError(messageOf(e));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void first();
    return () => controller.abort();
  }, [source, search, scope, commit]);

  // One request at a time per search. A caller that arrives while a page is in flight waits for it.
  const fetchNext = useCallback((pageSize: number): Promise<boolean> => {
    const active = session.current;
    const state = latest.current;
    if (!active || !state) return Promise.resolve(false);
    if (active.inFlight) return active.inFlight;
    const request = nextPage(active.search, state, active.pending, pageSize);
    if (!request) return Promise.resolve(false);
    active.pending.add(request.offset);
    setMoreBusy(true);
    const run = (async () => {
      try {
        const page = await fetchSpace(active.search, request.offset, request.limit, active.controller.signal);
        const base = latest.current;
        if (active.controller.signal.aborted || !base) return false;
        const merged = mergePage(base, page, request.offset);
        commit(merged);
        return merged !== base;
      } catch (e) {
        if (!active.controller.signal.aborted) {
          failure.current = messageOf(e);
          setMoreError(failure.current);
        }
        return false;
      } finally {
        active.pending.delete(request.offset);
        active.inFlight = undefined;
        if (!active.controller.signal.aborted) setMoreBusy(false);
      }
    })();
    active.inFlight = run;
    return run;
  }, [commit]);

  // Scrolling near the end appends the next page. After a failure, scrolling waits for Retry.
  const loadMore = useCallback(() => {
    if (!failure.current) void fetchNext(spacePageSize);
  }, [fetchNext]);

  const retry = useCallback(() => {
    failure.current = "";
    setMoreError("");
    void fetchNext(spacePageSize);
  }, [fetchNext]);

  // Loads the remaining pages, up to the accessible total, with the largest page the backend accepts.
  const loadAll = useCallback(async () => {
    const active = session.current;
    if (!active) return;
    failure.current = "";
    setMoreError("");
    setLoadingAll(true);
    try {
      let more = true;
      while (more && !active.controller.signal.aborted) more = await fetchNext(spaceMaxPageSize);
    } finally {
      if (!active.controller.signal.aborted) setLoadingAll(false);
    }
  }, [fetchNext]);

  return {
    load,
    hasMore: load ? canLoadMore(search, load) : false,
    elapsed,
    loading,
    error,
    loadingMore: moreBusy || loadingAll,
    moreError,
    loadMore,
    loadAll,
    retry,
  };
}
