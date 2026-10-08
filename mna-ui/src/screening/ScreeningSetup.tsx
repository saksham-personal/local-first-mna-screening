import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from "react";
import { Dialog } from "radix-ui";
import {
  Check,
  ChevronRight,
  FileSpreadsheet,
  LoaderCircle,
  Sparkles,
  Plus,
  UploadCloud,
  X,
} from "lucide-react";
import type {
  DataSource,
  IdentitySources,
  PreparedScreening,
  ScreeningCatalog,
  ScreeningConfig,
  ScreeningMode,
  ScreeningPreview,
  ScreeningProvider,
} from "../lib/screening-contract";
import { defaultScreeningConfig } from "../lib/screening-data";
import { batchLimit, batchWarning, defaultBatchSize, selectedModel, syncBatchSize, type ScreeningModel } from "../lib/screening-contract";
import SelectField from "../ui/SelectField";
import { hasPitchBookData, type SetupBuild } from "../lib/screening-client";
import HelpTip from "../ui/HelpTip";
import { plural } from "../lib/format";
import ColumnChips from "./ColumnChips";
import "./screening-setup.css";

type Props = {
  provider: ScreeningProvider;
  models: ScreeningModel[];
  initialMode?: ScreeningMode;
  initialPrompt?: string;
  initialConfig?: ScreeningConfig;
  catalog: ScreeningCatalog;
  criteriaText: string;
  onPreview: (config: ScreeningConfig) => Promise<ScreeningPreview>;
  onApprove: (
    config: ScreeningConfig,
    preview: ScreeningPreview,
  ) => Promise<PreparedScreening>;
  onHydrate: (files: File[], source: DataSource) => Promise<void>;
  /** Builds the prompt text from the criteria, examples, columns and request (bridge prompt files). */
  onBuildPrompt?: (config: ScreeningConfig) => Promise<string>;
  onGeneratePrompt?: (config: ScreeningConfig) => Promise<{ executed: boolean; text?: string; message?: string }>;
  onClose: () => void;
  build?: SetupBuild;
  onInvalidateBuild?: () => void;
};

const SOURCES: DataSource[] = ["MID", "ISCC", "PB", "ROGO", "RESULTS", "BING"];
const IDENTITY_SOURCES: DataSource[] = ["PB", "MID", "ISCC"];
const IDENTITY_LABELS: { key: keyof IdentitySources; label: string }[] = [
  { key: "name", label: "Company name" },
  { key: "website", label: "Website" },
  { key: "description", label: "Description" },
];

function unique(values: string[]) {
  const seen = new Set<string>();
  return values.map((value) => value.trim()).filter((value) => {
    const key = value.toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalized(config: ScreeningConfig): ScreeningConfig {
  const sources = {} as IdentitySources;
  for (const { key } of IDENTITY_LABELS) {
    sources[key] = IDENTITY_SOURCES.filter((source) =>
      config.identitySources[key].includes(source),
    );
  }
  return {
    ...config,
    model: config.model,
    batchSize: syncBatchSize(config.provider, config.batchSize),
    inputColumns: [
      "index",
      ...unique(config.inputColumns).filter((column) => column.toLocaleLowerCase() !== "index"),
    ],
    outputColumns: [
      "index",
      ...unique(config.outputColumns).filter((column) => column.toLocaleLowerCase() !== "index"),
    ],
    identitySources: sources,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Something went wrong. Please try again.";
}

function isSpreadsheet(file: File) {
  return /\.(csv|xlsx)$/i.test(file.name);
}

export default function ScreeningSetup({
  provider,
  models,
  initialMode = "screening",
  initialPrompt,
  initialConfig,
  catalog,
  criteriaText,
  onPreview,
  onApprove,
  onHydrate,
  onBuildPrompt,
  onGeneratePrompt,
  onClose,
  build,
  onInvalidateBuild,
}: Props) {
  const headingId = useId();
  const offerLinkedIn = hasPitchBookData(catalog);
  const keepLinkedIn = provider === "copilot" && catalog.sources.some(source => source.source === "PB" && source.fields.some(field => /linkedin/i.test(field.id) && field.count > 0));
  const [config, setConfig] = useState<ScreeningConfig>(() => {
    const config = normalized(
      (initialConfig && { ...initialConfig, request: initialConfig.request ?? initialPrompt ?? "" }) ||
        defaultScreeningConfig(
          provider,
          initialMode,
          criteriaText,
          initialPrompt,
        ),
    );
    config.model = selectedModel(models, config.model);
    if (!initialConfig) config.batchSize = defaultBatchSize(provider);
    if (!initialConfig) config.inputColumns = [...config.inputColumns, ...catalog.sources.filter(source => source.source === "BING" || source.source === "RESULTS").flatMap(source => source.fields.map(field => field.id))];
    if (keepLinkedIn && !config.inputColumns.includes("LinkedIn URL")) config.inputColumns.push("LinkedIn URL");
    if (!offerLinkedIn) config.inputColumns = config.inputColumns.filter(column => column !== "LinkedIn URL");
    return config;
  });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerSource, setPickerSource] = useState<DataSource>("MID");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [uploadSuccess, setUploadSuccess] = useState("");
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{
    value: ScreeningPreview;
    version: number;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState("");
  const [promptNotice, setPromptNotice] = useState("");
  const [generatingPrompt, setGeneratingPrompt] = useState(false);
  const version = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = previewing || approving;
  const selectedSource = catalog.sources.find(
    (source) => source.source === pickerSource,
  );
  const catalogSignature = JSON.stringify(catalog);

  const edit = (next: ScreeningConfig) => {
    onInvalidateBuild?.();
    if (keepLinkedIn && !next.inputColumns.includes("LinkedIn URL")) next = { ...next, inputColumns: [...next.inputColumns, "LinkedIn URL"] };
    version.current += 1;
    setConfig(normalized(next));
    setPreview(null);
    setError("");
  };

  useEffect(() => {
    version.current += 1;
    setPreview(null);
    if (keepLinkedIn) setConfig(current => current.inputColumns.includes("LinkedIn URL") ? current : { ...current, inputColumns: [...current.inputColumns, "LinkedIn URL"] });
  }, [catalogSignature]);

  useEffect(() => {
    if (build && (build.config.model !== config.model || build.config.batchSize !== config.batchSize)) {
      onInvalidateBuild?.();
      setPreview(null);
      return;
    }
    if (build?.status === "ready") setPreview({ value: build.preview, version: version.current });
    if (build?.status === "error") setError(build.error ?? "Input table preparation failed. Rebuild input table.");
  }, [build]);

  // The prompt text is generated from the criteria, examples, columns and request. A manual edit is
  // never replaced automatically: only the analyst's "Rebuild from criteria" (or the AI button) does that.
  const promptEdited = useRef(Boolean(initialConfig));
  const buildToken = useRef(0);
  const firstBuild = useRef(true);
  const configRef = useRef(config);
  configRef.current = config;
  const [buildingPrompt, setBuildingPrompt] = useState(false);

  const rebuildPrompt = async (manual: boolean) => {
    if (!onBuildPrompt) return;
    const token = ++buildToken.current;
    setBuildingPrompt(true);
    if (manual) setPromptNotice("");
    try {
      const prompt = await onBuildPrompt(normalized(configRef.current));
      if (token !== buildToken.current) return;
      promptEdited.current = false;
      onInvalidateBuild?.();
      version.current += 1;
      setPreview(null);
      setConfig((current) => normalized({ ...current, prompt }));
      if (manual) setPromptNotice("Prompt rebuilt from the criteria.");
    } catch (caught) {
      if (token === buildToken.current) setPromptNotice(`Using the built-in template. ${errorMessage(caught)}`);
    } finally {
      if (token === buildToken.current) setBuildingPrompt(false);
    }
  };

  const buildKey = JSON.stringify([config.mode, config.inputColumns, config.outputColumns, config.request ?? ""]);
  useEffect(() => {
    const first = firstBuild.current;
    firstBuild.current = false;
    if (!onBuildPrompt) return;
    if (promptEdited.current) {
      if (!first) setPromptNotice("Columns changed. Your prompt edits were kept; use Rebuild from criteria to refresh it.");
      return;
    }
    const handle = window.setTimeout(() => void rebuildPrompt(false), first ? 0 : 300);
    return () => window.clearTimeout(handle);
  }, [buildKey]);

  const changeOutput = (columns: string[]) => {
    const outputColumns = [
      "index",
      ...unique(columns).filter((column) => column.toLocaleLowerCase() !== "index"),
    ];
    edit({ ...config, outputColumns });
  };

  const generatePrompt = async () => {
    if (!onGeneratePrompt || generatingPrompt) return;
    const currentVersion = version.current;
    setGeneratingPrompt(true);
    setPromptNotice("");
    try {
      const result = await onGeneratePrompt(normalized(config));
      if (currentVersion !== version.current) return;
      if (!result.executed || !result.text?.trim()) {
        setPromptNotice(result.message || "Prompt generation is unavailable right now.");
        return;
      }
      promptEdited.current = true;
      buildToken.current += 1;
      setBuildingPrompt(false);
      edit({ ...config, prompt: result.text.trim() });
      setPromptNotice("Prompt generated.");
    } catch (caught) {
      if (currentVersion === version.current) setPromptNotice(errorMessage(caught));
    } finally {
      setGeneratingPrompt(false);
    }
  };

  const toggleInput = (fieldId: string) => {
    if (fieldId === "index" || (fieldId === "LinkedIn URL" && keepLinkedIn)) return;
    const selected = config.inputColumns.includes(fieldId);
    edit({
      ...config,
      inputColumns: selected
        ? config.inputColumns.filter((column) => column !== fieldId)
        : [...config.inputColumns, fieldId],
    });
  };

  const toggleIdentity = (key: keyof IdentitySources, source: DataSource) => {
    const current = config.identitySources[key];
    const updated = current.includes(source)
      ? current.filter((item) => item !== source)
      : [...current, source];
    edit({
      ...config,
      identitySources: { ...config.identitySources, [key]: updated },
    });
  };

  const runPreview = async () => {
    const currentVersion = version.current;
    const draft = normalized(config);
    setPreviewing(true);
    setError("");
    try {
      const value = await onPreview(draft);
      if (currentVersion === version.current)
        setPreview({ value, version: currentVersion });
    } catch (caught) {
      if (currentVersion === version.current) setError(errorMessage(caught));
    } finally {
      setPreviewing(false);
    }
  };

  const approve = async () => {
    if (!preview || preview.version !== version.current)
      return;
    setApproving(true);
    setError("");
    try {
      await onApprove(normalized(config), preview.value);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
      setPreview(null);
      onInvalidateBuild?.();
      setApproving(false);
    }
  };

  const addFiles = (files: File[]) => {
    const accepted = files.filter(isSpreadsheet);
    if (accepted.length !== files.length)
      setUploadError("Choose CSV or XLSX files only.");
    else setUploadError("");
    setUploadSuccess("");
    setPendingFiles((current) => [...current, ...accepted]);
    if (accepted.length && accepted.length === files.length) void upload(accepted);
  };

  const fileDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    addFiles(Array.from(event.dataTransfer.files));
  };

  const upload = async (files = pendingFiles) => {
    if (!files.length) return;
    setUploading(true);
    setUploadError("");
    try {
      await onHydrate(files, pickerSource);
      setPendingFiles([]);
      setUploadSuccess(
        "Data added. Source coverage is updated; use /data in chat to view the table.",
      );
    } catch (caught) {
      setUploadError(errorMessage(caught));
    } finally {
      setUploading(false);
    }
  };

  const providerLabel = provider === "llm_suite" ? "LLM Suite" : "M365 Copilot";
  const validPreview =
    preview?.version === version.current && preview.value.fingerprint ? preview.value : null;
  const samplePreview = validPreview ?? (build?.status === "building" ? build.preview : null);
  const batches = Math.max(
    config.mode === "question" ? 1 : 0,
    Math.ceil(catalog.total / config.batchSize),
  );
  const minimumMinutes = Math.max(0, Math.floor((batches - 1) / 7));

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy && !uploading) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ss-overlay" />
        <Dialog.Content
          className="ss-dialog"
          aria-labelledby={headingId}
          onEscapeKeyDown={(event) => {
            if (pickerOpen) event.preventDefault();
          }}
        >
          <header className="ss-header">
            <div>
              <span className="ss-eyebrow">Prepare {providerLabel}</span>
              <Dialog.Title id={headingId}>Screening setup</Dialog.Title>
              <Dialog.Description>
                Choose columns, edit the prompt, and review real rows.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="ss-icon-button"
                aria-label="Close setup"
                disabled={busy || uploading}
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>

          <div className="ss-scroll" inert={approving}>
            <section className="ss-section" aria-label="Inputs and output">
              <div className="ss-section-top">
                <div>
                  <span className="ss-step">01</span>
                  <h3>Inputs and outputs</h3>
                </div>
                <span className="ss-muted">
                  {plural(catalog.total, "company", "companies")}
                </span>
              </div>
              <div className="ss-field">
                <span>Input columns <HelpTip label="About input columns">The index is always included; missing source values stay blank.</HelpTip></span>
                <div className="ss-chips">
                  {config.inputColumns.map((column) => (
                    <span className="ss-chip" key={column}>
                      {column}
                      {column === "LinkedIn URL" && keepLinkedIn && <HelpTip label="LinkedIn input" size="sm">M365 screening uses the company's PitchBook LinkedIn URL when available.</HelpTip>}
                      {column !== "index" && !(column === "LinkedIn URL" && keepLinkedIn) && (
                        <button
                          type="button"
                          aria-label={`Remove ${column}`}
                          onClick={() => toggleInput(column)}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </span>
                  ))}
                  <button
                    className="ss-add"
                    type="button"
                    onClick={() => setPickerOpen(true)}
                  >
                    <Plus size={14} /> Add sources
                  </button>
                </div>
              </div>
              <div className="ss-field">
                <span>Output columns</span>
                <ColumnChips label="Output columns" values={config.outputColumns.filter((column) => column !== "index")} pinned="index" placeholder="Add a column…" onChange={changeOutput} />
                <small>Press Enter or comma to add a column. The index is always included.</small>
              </div>
            </section>

            <section className="ss-section" aria-label="Model and prompt">
              <div className="ss-section-top">
                <div>
                  <span className="ss-step">02</span>
                  <h3>Prompt and batch size</h3>
                </div>
              </div>
              <div className="ss-two-fields">
                <div className="ss-field">
                  <span>Model</span>
                  <SelectField
                    label="Model"
                    value={config.model}
                    onChange={(model) => edit({ ...config, model })}
                    options={models.map(model => ({ value: model.id, label: model.label }))}
                  />
                </div>
                <div className="ss-field">
                  <span><label htmlFor="ss-batch-size">Companies per batch</label> <HelpTip label="About batch timing">LLM Suite allows up to seven sends per minute. Provider response times can add delays.</HelpTip></span>
                  <div className="ss-batch-controls"><input
                    type="range"
                    aria-label="Companies per batch slider"
                    min={1}
                    max={batchLimit(provider)}
                    step={1}
                    value={config.batchSize}
                    onChange={(event) => edit({ ...config, batchSize: syncBatchSize(provider, event.target.value) })}
                  /><input
                    id="ss-batch-size"
                    type="number"
                    min={1}
                    max={batchLimit(provider)}
                    step={1}
                    value={config.batchSize}
                    onChange={(event) =>
                      edit({ ...config, batchSize: syncBatchSize(provider, event.target.value) })
                    }
                  /></div>
                  {batchWarning(provider, config.batchSize) && <small className="ss-batch-warning" role="status">{batchWarning(provider, config.batchSize)}</small>}
                </div>
              </div>
              <label className="ss-field">
                <span>
                  Prompt{" "}
                  <HelpTip label="About the prompt">
                    This instruction guides screening. Local suggestions are templates, not AI-generated text.
                  </HelpTip>
                </span>
                <div className="ss-prompt-wrap">
                  <textarea
                    className="ss-prompt"
                    value={config.prompt}
                    onChange={(event) => {
                      setPromptNotice("");
                      promptEdited.current = true;
                      buildToken.current += 1;
                      setBuildingPrompt(false);
                      edit({ ...config, prompt: event.target.value });
                    }}
                    readOnly={buildingPrompt}
                    aria-busy={buildingPrompt}
                    rows={7}
                    spellCheck={false}
                  />
                  {onGeneratePrompt && <button type="button" className="ss-generate" aria-label="Generate prompt with AI" title="Generate prompt with AI" onClick={() => void generatePrompt()} disabled={generatingPrompt || busy || buildingPrompt}><Sparkles size={16} />{generatingPrompt ? <LoaderCircle className="ss-spin" size={14} /> : null}</button>}
                </div>
              </label>
              {(buildingPrompt || promptNotice || onBuildPrompt) && (
                <small className="ss-prompt-notice" role="status">
                  {buildingPrompt ? (
                    <>
                      <LoaderCircle className="ss-spin" size={12} /> Building the prompt from your criteria…
                    </>
                  ) : (
                    promptNotice
                  )}{" "}
                  {onBuildPrompt && (
                    <button type="button" className="ss-link" onClick={() => void rebuildPrompt(true)} disabled={buildingPrompt || generatingPrompt || busy}>
                      Rebuild from criteria
                    </button>
                  )}
                </small>
              )}
              {(
                <p className="ss-timing">
                  {plural(catalog.total, "company", "companies")} ·{" "}
                  {plural(batches, "batch", "batches")}, up to{" "}
                  {plural(config.batchSize, "company", "companies")} each.
                  {provider === "llm_suite" && (minimumMinutes > 0
                    ? ` The rate limit adds at least ${plural(minimumMinutes, "minute", "minutes")}.`
                    : " This fits one rate window if capacity is free.")}
                </p>
              )}
            </section>

            <section
              className="ss-section ss-preview-section"
              aria-label="Preview"
            >
              <div className="ss-section-top">
                <div>
                  <span className="ss-step">03</span>
                  <h3>Review sample</h3>
                </div>
                <button
                  type="button"
                  className="ss-secondary"
                  onClick={runPreview}
                  disabled={busy || uploading || buildingPrompt || build?.status === "building"}
                >
                  {previewing ? (
                    <>
                      <LoaderCircle className="ss-spin" size={15} /> Preparing…
                    </>
                  ) : (
                    build?.status === "building" ? "Building input table…" : preview || error ? "Rebuild input table" : "Prepare"
                  )}
                </button>
              </div>
              {samplePreview ? (
                <>
                  <div className="ss-preview-meta">
                    <span>
                      <Check size={14} /> {validPreview ? `Frozen input table · ${validPreview.fingerprint.slice(0, 12)}` : "Building input table… You can close setup and review it from Activity."}
                    </span>
                    <span>
                      {samplePreview.companyCount
                        ? plural(samplePreview.companyCount, "company", "companies")
                        : "General question"}{" "}
                      · {plural(samplePreview.batches, "batch", "batches")}
                      {provider === "llm_suite" &&
                        samplePreview.estimatedMinimumMinutes > 0 &&
                        ` · request time at least ${plural(samplePreview.estimatedMinimumMinutes, "minute", "minutes")}`}
                    </span>
                  </div>
                  {samplePreview.warnings.filter((warning) => !(/\b(?:PBId|LinkedIn)\b.*\b(?:blank|missing|empty|unavailable)\b|\b(?:blank|missing|empty|unavailable)\b.*\b(?:PBId|LinkedIn)\b/i.test(warning))).map((warning, index) => (
                    <p className="ss-warning" key={`${index}-${warning}`}>
                      {warning}
                    </p>
                  ))}
                  <details><summary>Prompt preview</summary><textarea className="ss-prompt" readOnly rows={5} value={samplePreview.prompt} aria-label="Prepared prompt preview" /></details>
                  <div className="ss-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          {samplePreview.columns.map((column) => (
                            <th key={column} scope="col">
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {samplePreview.rows.map((row, index) => (
                          <tr key={index}>
                            {samplePreview.columns.map((column) => (
                              <td key={column}>{row[column] ?? ""}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {samplePreview.rows.length === 0 && (
                    <p className="ss-empty">
                      No sample rows are available for the selected inputs.
                    </p>
                  )}
                </>
              ) : (
                <div className="ss-empty">
                  Prepare to count companies and build the input table in Activity. Review the frozen table before approval.
                </div>
              )}
              {error && (
                <p className="ss-error" role="alert">
                  {error}
                </p>
              )}
            </section>
          </div>

          <footer className="ss-footer">
            <p>
              Approval saves this setup; provider status appears in Background screening.
            </p>
            <div>
              <button
                type="button"
                className="ss-secondary"
                onClick={onClose}
                disabled={busy || uploading}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ss-primary"
                onClick={approve}
                disabled={
                  !validPreview || busy || uploading
                }
              >
                {approving ? (
                  <>
                    <LoaderCircle className="ss-spin" size={15} /> Saving…
                  </>
                ) : (
                  "Approve and save setup"
                )}
              </button>
            </div>
          </footer>

          <Dialog.Root
            open={pickerOpen}
            onOpenChange={(open) => {
              if (!uploading) setPickerOpen(open);
            }}
          >
            <Dialog.Portal>
              <Dialog.Overlay className="ss-picker-overlay" />
              <Dialog.Content
                className="ss-picker"
                aria-describedby="ss-picker-description"
              >
                <header className="ss-picker-head">
                  <div>
                    <Dialog.Title>Add source fields</Dialog.Title>
                    <Dialog.Description id="ss-picker-description">
                      Select extra fields for screening.
                    </Dialog.Description>
                  </div>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="ss-icon-button"
                      aria-label="Close source picker"
                      disabled={uploading}
                    >
                      <X size={18} />
                    </button>
                  </Dialog.Close>
                </header>
                <div
                  className="ss-source-tabs"
                  role="group"
                  aria-label="Data source"
                >
                  {SOURCES.map((source) => {
                    const item = catalog.sources.find(
                      (entry) => entry.source === source,
                    );
                    return (
                      <button
                        type="button"
                        aria-pressed={pickerSource === source}
                        className={pickerSource === source ? "is-selected" : ""}
                        key={source}
                        onClick={() => {
                          setPickerSource(source);
                          setPendingFiles([]);
                          setUploadError("");
                          setUploadSuccess("");
                        }}
                      >
                        {source === "RESULTS" ? "Saved results" : source === "BING" ? "Bing research" : source}
                        <small>
                          {item?.hydrated
                            ? plural(item.companyCount, "company", "companies")
                            : "No data"}
                        </small>
                      </button>
                    );
                  })}
                </div>
                <div className="ss-picker-scroll">
                  <div className="ss-source-summary">
                    <strong>{selectedSource?.label ?? pickerSource}</strong>
                    <span>
                      {selectedSource?.hydrated
                        ? `${plural(selectedSource.companyCount, "company", "companies")} available`
                        : "No saved data for this source"}
                    </span>
                  </div>
                  {(selectedSource?.fields.length ?? 0) > 0 ? (
                    <fieldset className="ss-fieldset">
                      <legend>Raw fields</legend>
                      <div className="ss-field-list">
                        {selectedSource?.fields.filter(field => offerLinkedIn || !/linkedin/i.test(field.id)).map((field) => (
                          <label key={field.id} className="ss-field-option">
                            <input
                              type="checkbox"
                              checked={config.inputColumns.includes(field.id)}
                              onChange={() => toggleInput(field.id)}
                            />
                            <span className="ss-option-copy">
                              <strong>{field.label}</strong>
                              <small>
                                {field.id} · {plural(field.count, "value", "values")}
                                {field.example
                                  ? ` · e.g. ${field.example}`
                                  : ""}
                              </small>
                            </span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : (
                    <p className="ss-empty">
                      No raw fields are available from this source yet.
                    </p>
                  )}
                  <fieldset className="ss-fieldset">
                    <legend>Company details <HelpTip label="How company details are built">Name and website use the first available PB, MID, then ISCC value. Descriptions combine selected sources in that order and label each source.</HelpTip></legend>
                    {offerLinkedIn && <label className="ss-field-option"><input type="checkbox" checked={config.inputColumns.includes("LinkedIn URL")} disabled={keepLinkedIn} onChange={() => toggleInput("LinkedIn URL")} /><span>LinkedIn URL · PitchBook</span></label>}
                    <div className="ss-identity-grid">
                      {IDENTITY_LABELS.map(({ key, label }) => (
                        <div key={key}>
                          <strong>{label}</strong>
                          <div>
                            {IDENTITY_SOURCES.map((source) => (
                              <label key={source}>
                                <input
                                  type="checkbox"
                                  checked={config.identitySources[key].includes(
                                    source,
                                  )}
                                  onChange={() => toggleIdentity(key, source)}
                                />
                                {source}
                              </label>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </fieldset>
                  {(pickerSource === "PB" || pickerSource === "ROGO") && (
                    <section
                      className="ss-upload"
                      aria-label={`${pickerSource} upload`}
                    >
                      <h3>
                        <FileSpreadsheet size={17} /> Add {pickerSource === "PB" ? "PitchBook data" : "ROGO data"}
                      </h3>
                      <p>Select CSV or XLSX files, then upload them to add data.</p>
                      <div
                        className="ss-drop"
                        data-file-drop-zone="true"
                        onDragOver={(event) => {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "copy";
                        }}
                        onDrop={fileDrop}
                      >
                        <UploadCloud size={21} />
                        <span>Drop CSV or XLSX files here</span>
                        <button
                          type="button"
                          className="ss-secondary"
                          onClick={() => fileInput.current?.click()}
                        >
                          Choose files
                        </button>
                        <input
                          ref={fileInput}
                          type="file"
                          accept=".csv,.xlsx"
                          multiple
                          hidden
                          onChange={(event: ChangeEvent<HTMLInputElement>) => {
                            addFiles(Array.from(event.target.files ?? []));
                            event.target.value = "";
                          }}
                        />
                      </div>
                      {pendingFiles.length > 0 && (
                        <div className="ss-pending">
                          <div>
                            <strong>
                              {plural(pendingFiles.length, "file", "files")} pending
                            </strong>
                            <button
                              type="button"
                              className="ss-link"
                              onClick={() => setPendingFiles([])}
                            >
                              Clear
                            </button>
                          </div>
                          <ul>
                            {pendingFiles.map((file, index) => (
                              <li key={`${file.name}-${index}`}>{file.name}</li>
                            ))}
                          </ul>
                          <button
                            type="button"
                            className="ss-primary"
                            onClick={() => void upload()}
                            disabled={uploading}
                          >
                            {uploading ? (
                              <>
                                <LoaderCircle className="ss-spin" size={15} />{" "}
                                Uploading…
                              </>
                            ) : (
                              "Upload and add data"
                            )}
                          </button>
                        </div>
                      )}
                      {uploadError && (
                        <p className="ss-error" role="alert">
                          {uploadError}
                        </p>
                      )}
                      {uploadSuccess && (
                        <p className="ss-success" role="status">
                          {uploadSuccess}
                        </p>
                      )}
                    </section>
                  )}
                </div>
                <footer className="ss-picker-footer">
                  <span>{plural(config.inputColumns.length, "input", "inputs")} selected</span>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="ss-primary"
                      disabled={uploading}
                    >
                      Done <ChevronRight size={15} />
                    </button>
                  </Dialog.Close>
                </footer>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
