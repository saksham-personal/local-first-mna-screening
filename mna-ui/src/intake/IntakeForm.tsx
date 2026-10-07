import { useId, useMemo, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { Dialog } from "radix-ui";
import { Plus, X } from "lucide-react";
import { GEOGRAPHY_OPTIONS, INDUSTRY_SECTORS, OWNERSHIP_OPTIONS, REQUEST_TYPES, SIZE_OPTIONS } from "./intake-options";
import { characterCount, normalizeIntake, sectorsFor, type IntakeForm as IntakeFormData } from "./intake-model";
import SelectField from "../ui/SelectField";
import HelpTip from "../ui/HelpTip";
import "./intake.css";

type Props = {
  open: boolean;
  initial?: Partial<IntakeFormData>;
  sourceFileName?: string;
  onViewDocument?: () => void;
  onCancel: () => void;
  onSubmit: (form: IntakeFormData) => void;
  busy?: boolean;
};

const EMPTY_OPTION = "__intake_empty__";
const selectValue = (value: string) => value || EMPTY_OPTION;
const selectOptions = (placeholder: string, values: readonly string[]) => [
  { value: EMPTY_OPTION, label: placeholder, disabled: true },
  ...values.map((value) => ({ value, label: value })),
];
const countLabel = (value: string) => `${new Intl.NumberFormat().format(characterCount(value))} ${characterCount(value) === 1 ? "character" : "characters"}`;

function CharacterTextarea({
  id,
  label,
  value,
  onChange,
  rows,
  optional = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  optional?: boolean;
}) {
  return <div className="if-field if-field--wide">
    <label htmlFor={id}>{label}{optional && <span className="if-optional">Optional</span>}</label>
    <textarea id={id} rows={rows} value={value} onChange={(event) => onChange(event.target.value)} />
    <span className="if-count" aria-live="polite">{countLabel(value)}</span>
  </div>;
}

function ChipMultiSelect({
  label,
  values,
  selected,
  onChange,
}: {
  label: string;
  values: readonly string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [custom, setCustom] = useState("");
  const options = useMemo(() => [...new Set([...values, ...selected])], [values, selected]);
  const toggle = (value: string) => onChange(selected.includes(value)
    ? selected.filter((item) => item !== value)
    : [...selected, value]);
  const addCustom = () => {
    const value = custom.trim();
    if (value && !selected.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) onChange([...selected, value]);
    setCustom("");
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addCustom();
    }
  };
  return <fieldset className="if-chip-field">
    <legend>{label}</legend>
    <div className="if-chip-options">
      {options.map((option) => <button
        key={option}
        className={`if-chip${selected.includes(option) ? " is-selected" : ""}`}
        type="button"
        aria-pressed={selected.includes(option)}
        onClick={() => toggle(option)}
      >{option}{selected.includes(option) && <X size={13} aria-hidden="true" />}</button>)}
      {!options.length && <span className="if-empty-choice">No options selected.</span>}
    </div>
    <div className="if-add-custom">
      <input aria-label={`Custom ${label.toLocaleLowerCase()} value`} value={custom} onChange={(event) => setCustom(event.target.value)} onKeyDown={handleKeyDown} placeholder="Add custom" />
      <button type="button" onClick={addCustom} disabled={!custom.trim()} aria-label={`Add custom ${label.toLocaleLowerCase()}`}><Plus size={15} /> Add</button>
    </div>
  </fieldset>;
}

export default function IntakeForm({ open, initial, sourceFileName, onViewDocument, onCancel, onSubmit, busy = false }: Props) {
  const headingId = useId();
  const descriptionId = useId();
  const [form, setForm] = useState<IntakeFormData>(() => normalizeIntake(initial));
  const wasOpen = useRef(open);
  const sectors = sectorsFor(form.industry);
  const hasSearchDefinition = Boolean(form.investmentThesis.trim() || form.productsServices.trim());

  if (open !== wasOpen.current) {
    wasOpen.current = open;
    if (open) setForm(normalizeIntake(initial));
  }

  const update = <K extends keyof IntakeFormData>(key: K, value: IntakeFormData[K]) => {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "submitterName" && current.sameAsSubmitter) next.seniorClientExecs = value as string;
      if (key === "industry") next.sector = "";
      return next;
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!busy && hasSearchDefinition) onSubmit(normalizeIntake(form));
  };

  return <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onCancel(); }}>
    {open && <Dialog.Portal>
      <Dialog.Overlay className="if-overlay" />
      <Dialog.Content className="if-dialog" aria-labelledby={headingId} aria-describedby={descriptionId} onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }}>
        <header className="if-header">
          <div>
            <span className="if-eyebrow">Screening request</span>
            <Dialog.Title id={headingId}>Intake Form</Dialog.Title>
            <Dialog.Description id={descriptionId}>Capture the core business idea and the conditions the analyst wants to review.</Dialog.Description>
          </div>
          <button className="if-icon-button" type="button" aria-label="Close Intake Form" onClick={onCancel} disabled={busy}><X size={18} /></button>
        </header>
        {sourceFileName && <div className="if-source-banner">
          <span>Pre-filled from <strong>{sourceFileName}</strong> — check each field</span>
          <button type="button" onClick={onViewDocument} disabled={!onViewDocument}>
            View document
          </button>
        </div>}
        <form className="if-form" onSubmit={submit}>
          <div className="if-scroll">
            <section className="if-section" aria-labelledby="if-submitter-title">
              <h2 id="if-submitter-title">Submitter</h2>
              <div className="if-grid">
                <div className="if-field">
                  <label htmlFor="if-submitter">Submitter name</label>
                  <input id="if-submitter" value={form.submitterName} onChange={(event) => update("submitterName", event.target.value)} autoComplete="name" />
                </div>
                <div className="if-field">
                  <label htmlFor="if-due-date">Due date</label>
                  <input id="if-due-date" type="date" value={form.dueDate} onChange={(event) => update("dueDate", event.target.value)} />
                </div>
                <div className="if-field if-field--wide">
                  <label htmlFor="if-execs">Senior client exec(s)</label>
                  <input id="if-execs" value={form.seniorClientExecs} disabled={form.sameAsSubmitter} onChange={(event) => update("seniorClientExecs", event.target.value)} />
                  <label className="if-checkbox"><input type="checkbox" checked={form.sameAsSubmitter} onChange={(event) => {
                    const checked = event.target.checked;
                    setForm((current) => ({ ...current, sameAsSubmitter: checked, seniorClientExecs: checked ? current.submitterName : current.seniorClientExecs }));
                  }} /><span>Same as submitter</span></label>
                </div>
                <label className="if-field">
                  <span>Request type</span>
                  <SelectField label="Request type" value={selectValue(form.requestType)} onChange={(value) => update("requestType", value === EMPTY_OPTION ? "" : value)} options={selectOptions("Select request type", REQUEST_TYPES)} />
                </label>
              </div>
            </section>

            <section className="if-section" aria-labelledby="if-asset-title">
              <h2 id="if-asset-title">Asset parameters</h2>
              <div className="if-grid">
                <label className="if-field">
                  <span>Industry</span>
                  <SelectField label="Industry" value={selectValue(form.industry)} onChange={(value) => update("industry", value === EMPTY_OPTION ? "" : value)} options={selectOptions("Select industry", Object.keys(INDUSTRY_SECTORS))} />
                </label>
                <label className="if-field">
                  <span>Sector</span>
                  <SelectField label="Sector" value={selectValue(form.sector)} onChange={(value) => update("sector", value === EMPTY_OPTION ? "" : value)} options={selectOptions("Select sector", sectors)} disabled={!form.industry} />
                </label>
                <div className="if-field if-field--wide">
                  <label htmlFor="if-sub-sector">Sub-sector</label>
                  <input id="if-sub-sector" value={form.subSector} onChange={(event) => update("subSector", event.target.value)} />
                </div>
              </div>
            </section>

            <section className="if-section" aria-labelledby="if-idea-title">
              <h2 id="if-idea-title">Idea screening</h2>
              <div className="if-grid">
                <CharacterTextarea id="if-thesis" label="Investment thesis" value={form.investmentThesis} onChange={(value) => update("investmentThesis", value)} rows={8} />
                <CharacterTextarea id="if-products" label="Relevant products/services" value={form.productsServices} onChange={(value) => update("productsServices", value)} rows={5} />
                <CharacterTextarea id="if-markets" label="Focus on any specific end-markets" value={form.endMarkets} onChange={(value) => update("endMarkets", value)} rows={5} optional />
              </div>
            </section>

            <section className="if-section" aria-labelledby="if-conditions-title">
              <div className="if-section-heading">
                <h2 id="if-conditions-title">Other conditions</h2>
                <HelpTip label="How other conditions are used" size="sm">Recorded with the criteria. Not used to search for companies.</HelpTip>
              </div>
              <div className="if-conditions-grid">
                <ChipMultiSelect label="General size parameters" values={SIZE_OPTIONS} selected={form.sizeParameters} onChange={(value) => update("sizeParameters", value)} />
                <ChipMultiSelect label="Ownership preference" values={OWNERSHIP_OPTIONS} selected={form.ownershipPreference} onChange={(value) => update("ownershipPreference", value)} />
                <ChipMultiSelect label="Geography focus" values={GEOGRAPHY_OPTIONS} selected={form.geographyFocus} onChange={(value) => update("geographyFocus", value)} />
              </div>
            </section>
          </div>
          <footer className="if-footer">
            <p>Size, ownership, and geography are recorded for review.</p>
            <div>
              <button className="if-secondary" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
              <button className="if-primary" type="submit" disabled={busy || !hasSearchDefinition}>{busy ? "Preparing…" : "Use as criteria"}</button>
            </div>
          </footer>
        </form>
      </Dialog.Content>
    </Dialog.Portal>}
  </Dialog.Root>;
}
