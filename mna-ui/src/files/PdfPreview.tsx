import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Minus,
  Plus,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
  InvalidPDFException,
  PasswordException,
  RenderingCancelledException,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { StagedFile } from "../lib/chat-contract";
import "./pdf-preview.css";

GlobalWorkerOptions.workerSrc = workerUrl;

type Props = {
  file: StagedFile;
  onClose: () => void;
  /** Caller-owned URL for an attachment that has not yet been staged. */
  url?: string;
};

type LoadedDocument = { id: string; url: string; pdf: PDFDocumentProxy };
type ZoomMode = "fit" | "custom";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_CANVAS_EDGE = 8192;

function readableBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "PDF document";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function loadErrorMessage(error: unknown): string {
  if (error instanceof PasswordException) {
    return "This PDF is password protected. Open the original file to enter its password in your PDF reader.";
  }
  if (error instanceof InvalidPDFException) {
    return "This file does not contain a readable PDF. Check the original file and try uploading it again.";
  }
  return "The PDF could not be opened. Check that the local file is still available, then try again.";
}

function clampPage(value: number, total: number): number {
  return Math.min(Math.max(Math.trunc(value), 1), total);
}

export default function PdfPreview({ file, onClose, url }: Props) {
  const sourceUrl = url ?? `/api/files/${encodeURIComponent(file.id)}`;
  const [loaded, setLoaded] = useState<LoadedDocument | null>(null);
  const [originalUrl, setOriginalUrl] = useState<{
    id: string;
    source: string;
    value: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [retry, setRetry] = useState(0);
  const [renderRetry, setRenderRetry] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageDraft, setPageDraft] = useState("1");
  const [zoomMode, setZoomMode] = useState<ZoomMode>("fit");
  const [zoom, setZoom] = useState(1);
  const [actualZoom, setActualZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => setViewportWidth(viewport.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setExpanded(false);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled),input:not(:disabled),a[href]",
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("keydown", onEscape);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [expanded]);

  useEffect(() => {
    let obsolete = false;
    let loadingTask: ReturnType<typeof getDocument> | null = null;
    let ownedOriginalUrl: string | null = null;
    const controller = new AbortController();
    renderTaskRef.current?.cancel();
    setLoaded(null);
    setOriginalUrl(null);
    setLoading(true);
    setLoadError(null);
    setPageError(null);
    setPageNumber(1);
    setPageDraft("1");
    setZoomMode("fit");
    setRotation(0);

    const open = async () => {
      try {
        const response = await fetch(sourceUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const buffer = await response.arrayBuffer();
        if (obsolete) return;
        // The staged-file endpoint uses attachment disposition. This local
        // blob URL lets "Open original" display the same bytes in a PDF reader.
        ownedOriginalUrl = URL.createObjectURL(
          new Blob([buffer], { type: "application/pdf" }),
        );
        setOriginalUrl({
          id: file.id,
          source: sourceUrl,
          value: ownedOriginalUrl,
        });
        loadingTask = getDocument({
          data: new Uint8Array(buffer),
          enableHWA: false,
          cMapUrl: "/pdf-assets/cmaps/",
          cMapPacked: true,
          standardFontDataUrl: "/pdf-assets/standard_fonts/",
          wasmUrl: "/pdf-assets/wasm/",
        });
        const pdf = await loadingTask.promise;
        if (obsolete) return;
        setLoaded({ id: file.id, url: sourceUrl, pdf });
        setLoading(false);
      } catch (error) {
        if (obsolete || controller.signal.aborted) return;
        setLoadError(loadErrorMessage(error));
        setLoading(false);
      }
    };
    void open();

    return () => {
      obsolete = true;
      controller.abort();
      renderTaskRef.current?.cancel();
      // The loading task owns its document transport and dedicated worker.
      if (loadingTask) void loadingTask.destroy().catch(() => undefined);
      if (ownedOriginalUrl) URL.revokeObjectURL(ownedOriginalUrl);
    };
  }, [file.id, sourceUrl, retry]);

  useEffect(() => {
    const pdf =
      loaded?.id === file.id && loaded.url === sourceUrl ? loaded.pdf : null;
    const host = canvasHostRef.current;
    if (!pdf || !host || !viewportWidth) return;
    let obsolete = false;
    let task: RenderTask | null = null;
    let page: PDFPageProxy | null = null;
    host.replaceChildren();
    setRendering(true);
    setPageError(null);

    const draw = async () => {
      try {
        page = await pdf.getPage(pageNumber);
        if (obsolete) return;
        const pageRotation = (page.rotate + rotation) % 360;
        const natural = page.getViewport({ scale: 1, rotation: pageRotation });
        const scale =
          zoomMode === "fit"
            ? Math.min(
                MAX_ZOOM,
                Math.max(0.1, (viewportWidth - 48) / natural.width),
              )
            : zoom;
        const viewport = page.getViewport({ scale, rotation: pageRotation });
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", {
          alpha: false,
          willReadFrequently: true,
        });
        if (!context) throw new Error("Canvas is unavailable");
        const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
        const allocationScale = Math.min(
          pixelRatio,
          Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height)),
          MAX_CANVAS_EDGE / viewport.width,
          MAX_CANVAS_EDGE / viewport.height,
        );
        const outputScale = Math.max(0.01, allocationScale);
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        canvas.setAttribute("role", "img");
        canvas.setAttribute(
          "aria-label",
          `Page ${pageNumber} of ${pdf.numPages} from ${file.name}`,
        );
        if (obsolete) return;
        host.replaceChildren(canvas);
        setActualZoom(scale);
        task = page.render({
          canvas,
          canvasContext: context,
          viewport,
          transform:
            outputScale === 1
              ? undefined
              : [outputScale, 0, 0, outputScale, 0, 0],
        });
        renderTaskRef.current = task;
        await task.promise;
        if (!obsolete) setRendering(false);
      } catch (error) {
        if (obsolete || error instanceof RenderingCancelledException) return;
        host.replaceChildren();
        setRendering(false);
        setPageError(
          "This page could not be displayed. Try it again or open the original PDF.",
        );
      } finally {
        page?.cleanup();
        if (renderTaskRef.current === task) renderTaskRef.current = null;
      }
    };
    void draw();
    return () => {
      obsolete = true;
      task?.cancel();
    };
  }, [
    loaded,
    file.id,
    file.name,
    sourceUrl,
    pageNumber,
    zoomMode,
    zoom,
    rotation,
    viewportWidth,
    renderRetry,
  ]);

  const total =
    loaded?.id === file.id && loaded.url === sourceUrl
      ? loaded.pdf.numPages
      : 0;
  const openHref =
    originalUrl?.id === file.id && originalUrl.source === sourceUrl
      ? originalUrl.value
      : sourceUrl;
  const controlsDisabled = !total || loading || Boolean(loadError);

  const goToPage = (value: number) => {
    if (!total || !Number.isFinite(value)) return;
    const next = clampPage(value, total);
    setPageNumber(next);
    setPageDraft(String(next));
  };

  const commitPage = (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const value = Number(pageDraft);
    if (Number.isInteger(value)) goToPage(value);
    else setPageDraft(String(pageNumber));
  };

  const changeZoom = (direction: -1 | 1) => {
    const current = zoomMode === "fit" ? actualZoom : zoom;
    const next = Math.min(
      MAX_ZOOM,
      Math.max(MIN_ZOOM, Math.round((current + direction * 0.25) * 4) / 4),
    );
    setZoom(next);
    setZoomMode("custom");
  };

  return (
    <section
      ref={panelRef}
      className={`pdf-preview${expanded ? " pdf-preview--expanded" : ""}`}
      role={expanded ? "dialog" : "region"}
      aria-modal={expanded ? true : undefined}
      aria-label={`PDF preview: ${file.name}`}
    >
      <header className="pdf-preview__header">
        <div className="pdf-preview__identity">
          <span className="pdf-preview__file-icon" aria-hidden="true">
            <FileText size={19} strokeWidth={1.8} />
          </span>
          <div className="pdf-preview__filename-block">
            <h2 title={file.name}>{file.name}</h2>
            <span>{readableBytes(file.bytes)} · PDF</span>
          </div>
        </div>
        <div className="pdf-preview__header-actions">
          <a
            className="pdf-preview__icon-button"
            href={openHref}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open original PDF"
            title="Open original PDF"
          >
            <ExternalLink size={17} />
          </a>
          <a
            className="pdf-preview__icon-button"
            href={sourceUrl}
            download={file.name}
            aria-label="Download PDF"
            title="Download PDF"
          >
            <Download size={17} />
          </a>
          <button
            type="button"
            className="pdf-preview__icon-button"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? "Restore PDF panel" : "Expand PDF panel"}
            title={expanded ? "Restore panel" : "Expand panel"}
          >
            {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
          </button>
          <button
            type="button"
            className="pdf-preview__icon-button pdf-preview__close"
            onClick={onClose}
            aria-label="Close PDF preview"
            title="Close preview"
          >
            <X size={18} />
          </button>
        </div>
      </header>

      <div className="pdf-preview__toolbar" aria-label="PDF controls">
        <div className="pdf-preview__tool-group pdf-preview__pages">
          <button
            type="button"
            className="pdf-preview__icon-button"
            disabled={controlsDisabled || pageNumber <= 1}
            onClick={() => goToPage(pageNumber - 1)}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronLeft size={18} />
          </button>
          <form onSubmit={commitPage} className="pdf-preview__page-form">
            <label htmlFor="pdf-preview-page">Page</label>
            <input
              id="pdf-preview-page"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pageDraft}
              disabled={controlsDisabled}
              onChange={(event) => setPageDraft(event.target.value)}
              onBlur={() => commitPage()}
              aria-label="Page number"
            />
            <span>of {total || "—"}</span>
          </form>
          <button
            type="button"
            className="pdf-preview__icon-button"
            disabled={controlsDisabled || pageNumber >= total}
            onClick={() => goToPage(pageNumber + 1)}
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight size={18} />
          </button>
        </div>
        <div className="pdf-preview__tool-group pdf-preview__zoom">
          <button
            type="button"
            className="pdf-preview__icon-button"
            disabled={
              controlsDisabled ||
              (zoomMode === "custom" ? zoom : actualZoom) <= MIN_ZOOM
            }
            onClick={() => changeZoom(-1)}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus size={17} />
          </button>
          <span className="pdf-preview__zoom-value" aria-live="polite">
            {Math.round((zoomMode === "fit" ? actualZoom : zoom) * 100)}%
          </span>
          <button
            type="button"
            className="pdf-preview__icon-button"
            disabled={
              controlsDisabled ||
              (zoomMode === "custom" ? zoom : actualZoom) >= MAX_ZOOM
            }
            onClick={() => changeZoom(1)}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            className={`pdf-preview__text-button${zoomMode === "fit" ? " is-active" : ""}`}
            disabled={controlsDisabled}
            onClick={() => setZoomMode("fit")}
            aria-pressed={zoomMode === "fit"}
          >
            Fit width
          </button>
        </div>
        <div className="pdf-preview__tool-group pdf-preview__rotate">
          <button
            type="button"
            className="pdf-preview__icon-button"
            disabled={controlsDisabled}
            onClick={() => setRotation((value) => (value + 90) % 360)}
            aria-label="Rotate page clockwise"
            title="Rotate page clockwise"
          >
            <RotateCw size={17} />
          </button>
        </div>
      </div>

      <div ref={viewportRef} className="pdf-preview__viewport">
        {loading && (
          <div className="pdf-preview__status" role="status">
            <LoaderCircle className="pdf-preview__spinner" size={25} />
            <strong>Opening PDF…</strong>
            <span>Preparing the document preview.</span>
          </div>
        )}
        {loadError && (
          <div
            className="pdf-preview__status pdf-preview__status--error"
            role="alert"
          >
            <FileText size={28} />
            <strong>Preview unavailable</strong>
            <p>{loadError}</p>
            <button
              type="button"
              className="pdf-preview__retry"
              onClick={() => setRetry((value) => value + 1)}
            >
              <RefreshCw size={15} /> Try again
            </button>
          </div>
        )}
        {!loading && !loadError && (
          <>
            {rendering && (
              <div className="pdf-preview__rendering" role="status">
                <LoaderCircle className="pdf-preview__spinner" size={16} />{" "}
                Rendering page…
              </div>
            )}
            {pageError && (
              <div
                className="pdf-preview__status pdf-preview__status--error"
                role="alert"
              >
                <strong>Page unavailable</strong>
                <p>{pageError}</p>
                <button
                  type="button"
                  className="pdf-preview__retry"
                  onClick={() => setRenderRetry((value) => value + 1)}
                >
                  <RefreshCw size={15} /> Try again
                </button>
              </div>
            )}
            <div
              ref={canvasHostRef}
              className="pdf-preview__canvas-host"
              aria-hidden={Boolean(pageError)}
            />
          </>
        )}
      </div>
    </section>
  );
}
