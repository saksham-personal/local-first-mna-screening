import { useRef, useState, type KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";

type Props = {
  values: string[];
  onChange: (values: string[]) => void;
  label: string;
  placeholder: string;
  pinned?: string;
  disabled?: boolean;
};

function merge(values: string[], additions: string[]) {
  const result = [...values];
  const seen = new Set(values.map((value) => value.trim().toLocaleLowerCase()));
  for (const raw of additions) {
    const value = raw.trim();
    const key = value.toLocaleLowerCase();
    if (value && !seen.has(key)) {
      result.push(value);
      seen.add(key);
    }
  }
  return result;
}

export default function ColumnChips({ values, onChange, label, placeholder, pinned, disabled = false }: Props) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const commit = (value: string) => {
    const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length) onChange(merge(values, parts));
    setDraft("");
  };
  const updateDraft = (value: string) => {
    const parts = value.split(",");
    if (parts.length > 1) {
      onChange(merge(values, parts.slice(0, -1)));
      setDraft(parts.at(-1) ?? "");
    } else setDraft(value);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && !draft && values.length) {
      onChange(values.slice(0, -1));
    }
  };
  return <div className="ss-chip-editor" role="group" aria-label={label} onClick={() => inputRef.current?.focus()}>
    {pinned && <span className="ss-chip ss-pinned">{pinned}</span>}
    {values.map((value) => <span className="ss-chip" key={value}>{value}<button type="button" disabled={disabled} aria-label={`Remove ${value}`} onClick={(event) => { event.stopPropagation(); onChange(values.filter((item) => item !== value)); }}><X size={12} /></button></span>)}
    <input ref={inputRef} aria-label={label} value={draft} disabled={disabled} placeholder={placeholder} onChange={(event) => updateDraft(event.target.value)} onKeyDown={onKeyDown} onBlur={() => commit(draft)} />
    <button type="button" className="ss-chip-add" disabled={disabled || !draft.trim()} aria-label={`Add ${label.toLocaleLowerCase()}`} onMouseDown={(event) => event.preventDefault()} onClick={() => commit(draft)}><Plus size={14} /></button>
  </div>;
}
