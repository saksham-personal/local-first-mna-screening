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
import {
  defaultScreeningConfig,
  recommendedPrompt,
  suggestOutputColumns,
} from "../lib/screening-data";
import Tooltip from "../Tooltip";
import "./screening-setup.css";

type Props = {
  provider: ScreeningProvider;
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
  onClose: () => void;
};

const SOURCES: DataSource[] = ["MID", "ISCC", "PB", "ROGO"];
const IDENTITY_SOURCES: DataSource[] = ["PB", "MID", "ISCC"];
const IDENTITY_LABELS: { key: keyof IdentitySources; label: string }[] = [
  { key: "name", label: "Company name" },
  { key: "website", label: "Website" },
  { key: "description", label: "Description" },
];

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
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
    batchSize: Math.max(
      1,
      Math.min(200, Math.round(Number(config.batchSize) || 1)),
    ),
    inputColumns: [
      "index",
      ...unique(config.inputColumns).filter((column) => column !== "index"),
    ],
    outputColumns: [
      "index",
      ...unique(config.outputColumns).filter((column) => column !== "index"),
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

function requestFromPrompt(prompt?: string) {
  return (
    prompt
      ?.match(
        /(?:^|\n)Analyst request:\s*\n([\s\S]*?)\n\n(?:For company rows:\s*)?Return one Markdown table/i,
      )?.[1]
      ?.trim() ?? ""
  );
}

export default function ScreeningSetup({
  provider,
  initialMode = "screening",
  initialPrompt,
  initialConfig,
  catalog,
  criteriaText,
  onPreview,
  onApprove,
  onHydrate,
  onClose,
}: Props) {
  const headingId = useId();
  const [request, setRequest] = useState(
    initialPrompt ?? requestFromPrompt(initialConfig?.prompt),
  );
  const [config, setConfig] = useState<ScreeningConfig>(() =>
    normalized(
      initialConfig ??
        defaultScreeningConfig(
          provider,
          initialMode,
          criteriaText,
          initialPrompt,
        ),
    ),
  );
  const [outputText, setOutputText] = useState(() =>
    (
      initialConfig ??
      defaultScreeningConfig(provider, initialMode, criteriaText, initialPrompt)
    ).outputColumns
      .filter((column) => column !== "index")
      .join(", "),
  );
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
  const version = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = previewing || approving;
  const selectedSource = catalog.sources.find(
    (source) => source.source === pickerSource,
  );
  const catalogSignature = JSON.stringify(catalog);

  const edit = (next: ScreeningConfig) => {
    version.current += 1;
    setConfig(normalized(next));
    setPreview(null);
    setError("");
  };

  useEffect(() => {
    version.current += 1;
    setPreview(null);
  }, [catalogSignature]);

  const changeMode = (mode: ScreeningMode) => {
    if (mode === config.mode) return;
    const outputColumns = suggestOutputColumns(request, mode);
    setOutputText(
      outputColumns.filter((column) => column !== "index").join(", "),
    );
    edit({
      ...config,
      mode,
      outputColumns,
      prompt: recommendedPrompt(mode, criteriaText, request, outputColumns),
    });
  };

  const changeRequest = (value: string) => {
    setRequest(value);
    edit({
      ...config,
      prompt: recommendedPrompt(
        config.mode,
        criteriaText,
        value,
        config.outputColumns,
      ),
    });
  };

  const changeOutput = (value: string) => {
    setOutputText(value);
    const outputColumns = [
      "index",
      ...unique(value.split(",")).filter((column) => column !== "index"),
    ];
    edit({
      ...config,
      outputColumns,
      prompt: recommendedPrompt(
        config.mode,
        criteriaText,
        request,
        outputColumns,
      ),
    });
  };

  const toggleInput = (fieldId: string) => {
    if (fieldId === "index") return;
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
    if (!preview || preview.version !== version.current || !config.model.trim())
      return;
    setApproving(true);
    setError("");
    try {
      await onApprove(normalized(config), preview.value);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
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

  const providerLabel = provider === "llm_suite" ? "LLMSuite" : "Copilot";
  const validPreview =
    preview?.version === version.current ? preview.value : null;
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
                Choose the columns and instructions, then review a real data
                preview before saving.
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
            <section className="ss-section" aria-label="Task type">
              <div className="ss-section-top">
                <div>
                  <span className="ss-step">01</span>
                  <h3>What should the model do?</h3>
                </div>
              </div>
              <div
                className="ss-mode-group"
                role="group"
                aria-label="Screening mode"
              >
                <button
                  type="button"
                  className={config.mode === "screening" ? "is-selected" : ""}
                  aria-pressed={config.mode === "screening"}
                  onClick={() => changeMode("screening")}
                >
                  Screen companies<small>Fit score and rationale</small>
                </button>
                <button
                  type="button"
                  className={config.mode === "question" ? "is-selected" : ""}
                  aria-pressed={config.mode === "question"}
                  onClick={() => changeMode("question")}
                >
                  Ask a question<small>Answer per company</small>
                </button>
              </div>
              {config.mode === "question" && (
                <label className="ss-field ss-question">
                  <span>
                    {catalog.total
                      ? "Question for each company"
                      : "Your question"}
                  </span>
                  <textarea
                    value={request}
                    onChange={(event) => changeRequest(event.target.value)}
                    rows={2}
                    placeholder="What do you want to know?"
                  />
                </label>
              )}
            </section>

            <section className="ss-section" aria-label="Inputs and output">
              <div className="ss-section-top">
                <div>
                  <span className="ss-step">02</span>
                  <h3>Data in, results out</h3>
                </div>
                <span className="ss-muted">
                  {catalog.total.toLocaleString()} companies
                </span>
              </div>
              <div className="ss-field">
                <span>Input columns</span>
                <div className="ss-chips">
                  {config.inputColumns.map((column) => (
                    <span className="ss-chip" key={column}>
                      {column}
                      {column !== "index" && (
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
                <small>
                  index stays pinned. Missing source values remain blank for a
                  company.
                </small>
              </div>
              <div className="ss-field">
                <label htmlFor="ss-output">Output columns</label>
                <div className="ss-output-row">
                  <span className="ss-chip ss-pinned">index</span>
                  <input
                    id="ss-output"
                    value={outputText}
                    onChange={(event) => changeOutput(event.target.value)}
                    placeholder={
                      config.mode === "screening"
                        ? "Fit Score, Rationale"
                        : "Answer"
                    }
                  />
                </div>
                <small>
                  Separate output column names with commas. index stays pinned.{" "}
                  <button
                    type="button"
                    className="ss-link"
                    onClick={() =>
                      changeOutput(
                        suggestOutputColumns(request, config.mode)
                          .slice(1)
                          .join(", "),
                      )
                    }
                  >
                    Suggest from request
                  </button>
                </small>
              </div>
            </section>

            <section className="ss-section" aria-label="Model and prompt">
              <div className="ss-section-top">
                <div>
                  <span className="ss-step">03</span>
                  <h3>Instructions and capacity</h3>
                </div>
              </div>
              <div className="ss-two-fields">
                <label className="ss-field">
                  <span>
                    Model or deployment <em>required to approve</em>
                  </span>
                  <input
                    value={config.model}
                    onChange={(event) =>
                      edit({ ...config, model: event.target.value })
                    }
                    placeholder="Enter your model or deployment"
                    autoComplete="off"
                  />
                </label>
                <label className="ss-field">
                  <span>Companies per batch</span>
                  <input
                    type="number"
                    min={1}
                    max={200}
                    step={1}
                    value={config.batchSize}
                    onChange={(event) =>
                      edit({ ...config, batchSize: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
              <label className="ss-field">
                <span>
                  Prompt · local template suggestion{" "}
                  <Tooltip label="About the prompt">
                    This is a local template suggestion, not a live model
                    response. Changes to the question or output columns refresh
                    it; you can edit the prompt directly.
                  </Tooltip>
                </span>
                <textarea
                  className="ss-prompt"
                  value={config.prompt}
                  onChange={(event) =>
                    edit({ ...config, prompt: event.target.value })
                  }
                  rows={7}
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                className="ss-link"
                onClick={() =>
                  edit({
                    ...config,
                    prompt: recommendedPrompt(
                      config.mode,
                      criteriaText,
                      request,
                      config.outputColumns,
                    ),
                  })
                }
              >
                Restore recommended prompt
              </button>
              {provider === "llm_suite" && (
                <p className="ss-timing">
                  {catalog.total.toLocaleString()} companies ·{" "}
                  {batches.toLocaleString()}{" "}
                  {batches === 1 ? "batch" : "batches"}, up to{" "}
                  {config.batchSize} each.
                  {minimumMinutes > 0
                    ? ` The rate limit alone adds at least ${minimumMinutes.toLocaleString()} min.`
                    : " This fits within one rate window if capacity is free."}{" "}
                  All LLMSuite work shares seven requests per minute. Other work
                  and response time can add delays.
                </p>
              )}
            </section>

            <section
              className="ss-section ss-preview-section"
              aria-label="Preview"
            >
              <div className="ss-section-top">
                <div>
                  <span className="ss-step">04</span>
                  <h3>Review sample</h3>
                </div>
                <button
                  type="button"
                  className="ss-secondary"
                  onClick={runPreview}
                  disabled={busy || uploading}
                >
                  {previewing ? (
                    <>
                      <LoaderCircle className="ss-spin" size={15} /> Preparing…
                    </>
                  ) : (
                    "Generate preview"
                  )}
                </button>
              </div>
              {validPreview ? (
                <>
                  <div className="ss-preview-meta">
                    <span>
                      <Check size={14} /> Current preview
                    </span>
                    <span>
                      {validPreview.companyCount
                        ? `${validPreview.companyCount.toLocaleString()} companies`
                        : "General question"}{" "}
                      · {validPreview.batches.toLocaleString()}{" "}
                      {validPreview.batches === 1 ? "batch" : "batches"}
                      {provider === "llm_suite" &&
                        validPreview.estimatedMinimumMinutes > 0 &&
                        ` · request time at least ${validPreview.estimatedMinimumMinutes.toLocaleString()} min`}
                    </span>
                  </div>
                  {validPreview.warnings.map((warning, index) => (
                    <p className="ss-warning" key={`${index}-${warning}`}>
                      {warning}
                    </p>
                  ))}
                  <div className="ss-table-wrap">
                    <table>
                      <thead>
                        <tr>
                          {validPreview.columns.map((column) => (
                            <th key={column} scope="col">
                              {column}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {validPreview.rows.map((row, index) => (
                          <tr key={index}>
                            {validPreview.columns.map((column) => (
                              <td key={column}>{row[column] ?? ""}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {validPreview.rows.length === 0 && (
                    <p className="ss-empty">
                      No sample rows are available for the selected inputs.
                    </p>
                  )}
                </>
              ) : (
                <div className="ss-empty">
                  Generate a preview to inspect actual source values and unlock
                  approval.
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
              Approval saves this snapshot. Provider status and progress appear in Background screening.
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
                  !validPreview || !config.model.trim() || busy || uploading
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
                      Choose extra columns and sources for company details.
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
                        {source}
                        <small>
                          {item?.hydrated
                            ? `${item.companyCount.toLocaleString()} ${item.companyCount === 1 ? "company" : "companies"}`
                            : "Not populated"}
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
                        ? `${selectedSource.companyCount.toLocaleString()} ${selectedSource.companyCount === 1 ? "company" : "companies"} available`
                        : "Source data has not been populated"}
                    </span>
                  </div>
                  {(selectedSource?.fields.length ?? 0) > 0 ? (
                    <fieldset className="ss-fieldset">
                      <legend>Raw fields</legend>
                      <div className="ss-field-list">
                        {selectedSource?.fields.map((field) => (
                          <label key={field.id} className="ss-field-option">
                            <input
                              type="checkbox"
                              checked={config.inputColumns.includes(field.id)}
                              onChange={() => toggleInput(field.id)}
                            />
                            <span className="ss-option-copy">
                              <strong>{field.label}</strong>
                              <small>
                                {field.id} · {field.count.toLocaleString()}{" "}
                                populated
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
                    <legend>Company detail sources</legend>
                    <p>
                      Name and website use the first available value from PB →
                      MID → ISCC. Description combines the selected sources in
                      that order, with a label for each. Missing values stay
                      blank.
                    </p>
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
                        <FileSpreadsheet size={17} /> Populate {pickerSource}
                      </h3>
                      <p>
                        Choose local CSV or XLSX files. They are uploaded only
                        after you select “Upload and populate.”
                      </p>
                      <div
                        className="ss-drop"
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
                              {pendingFiles.length} file
                              {pendingFiles.length === 1 ? "" : "s"} pending
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
                              "Upload and populate"
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
                  <span>{config.inputColumns.length} inputs selected</span>
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
