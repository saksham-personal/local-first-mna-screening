const INDUSTRIES = [
  "Technology, Media, & Telecommunications",
  "Consumer/Retail",
  "Diversified",
  "Financial Institutions Group",
  "Energy/Power & Renewables/Mining",
  "Healthcare",
  "Unassigned Industry",
];
const SECTORS = {
  "Technology, Media, & Telecommunications": ["Technology", "Media", "Communications"],
  "Consumer/Retail": ["Retail Industries", "Consumer", "C&R Business Services", "Business Services"],
  Diversified: ["Aerospace & Defense", "Automotive", "Basic Materials", "Capital Goods & Other", "Chemicals", "Metals", "Transportation"],
  "Financial Institutions Group": ["Insurance", "Specialty finance"],
  "Energy/Power & Renewables/Mining": ["Energy", "Mining", "Power & Renewables"],
  Healthcare: ["Biotech/Pharma", "Healthcare Services", "Life Science tools & diagnostics", "Medical Devices", "Pharmaceuticals"],
  "Unassigned Industry": ["Unassigned Industry"],
};
const REQUEST_TYPES = [
  "New Platform (Sponsor / Family Office)",
  "Add-on (Sponsor / Family Office)",
  "Acquisitive Strategic Client (non-Sponsor)",
  "General Industry Screen",
];
const SIZE_OPTIONS = ["$0 - 50MM", "$50MM - 100MM", "$100MM - 250MM", "$250MM - 500MM", "$500MM+"];
const OWNERSHIP_OPTIONS = ["Non-sponsor owned / Family or founder owned", "Sponsor owned", "VC-backed"];
const GEOGRAPHY_OPTIONS = ["US - All regions", "Canada"];

const labels = [
  { label: "Submitter name", key: "submitterName", kind: "text" },
  { label: "Due date", key: "dueDate", kind: "date" },
  { label: "Senior client exec(s)", key: "seniorClientExecs", kind: "execs" },
  { label: "Request type", key: "requestType", kind: "request" },
  { label: "Industry", key: "industry", kind: "industry" },
  { label: "Sector", key: "sector", kind: "sector" },
  { label: "Sub-sector", key: "subSector", kind: "text" },
  { label: "Investment thesis", key: "investmentThesis", kind: "text" },
  { label: "Relevant products/services", key: "productsServices", kind: "text" },
  { label: "Focus on any specific end-markets", key: "endMarkets", kind: "text" },
  { label: "General size parameters", key: "sizeParameters", kind: "size" },
  { label: "Ownership preference", key: "ownershipPreference", kind: "ownership" },
  { label: "Geography focus", key: "geographyFocus", kind: "geography" },
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalized(value) {
  return value.toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function matchOption(value, options) {
  const haystack = normalized(value);
  return options.find((option) => haystack.includes(normalized(option)));
}

function matchOptions(value, options) {
  const haystack = normalized(value);
  return options.filter((option) => haystack.includes(normalized(option)));
}

function dateValue(value) {
  const trimmed = value.trim();
  const iso = trimmed.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const match = trimmed.match(/\b(\d{1,2})\s+([a-z]{3,9})\.?[,]?\s+(\d{4})\b/i)
    ?? trimmed.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})[,]?\s+(\d{4})\b/i);
  if (!match) return "";
  const dayFirst = /^\d/.test(match[1]);
  const day = Number(dayFirst ? match[1] : match[2]);
  const monthText = (dayFirst ? match[2] : match[1]).toLocaleLowerCase();
  const month = monthNames.findIndex((name) => monthText.startsWith(name)) + 1;
  const year = match[3];
  if (!month || day < 1 || day > 31) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function customValues(value) {
  return value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

/**
 * Best-effort parser for text from a printed Intake Form. This is a pluggable
 * v1; the analyst will refine it after reviewing real intake documents.
 */
export function extractIntakeFieldsFromText(text) {
  if (typeof text !== "string" || !text.trim()) return { fields: {}, matched: [] };
  try {
    const occurrences = [];
    for (const field of labels) {
      const pattern = field.label.split(/\s+/).map(escapeRegExp).join("\\s+");
      const expression = new RegExp(`^([\\t ]*)(${pattern})[\\t ]*:?\\s*`, "gimu");
      for (const match of text.matchAll(expression)) {
        const labelStart = match.index + match[1].length;
        occurrences.push({ field, start: labelStart, valueStart: match.index + match[0].length });
      }
    }
    occurrences.sort((left, right) => left.start - right.start);
    if (!occurrences.length) return { fields: {}, matched: [] };

    const fields = {};
    const matched = [];
    for (let index = 0; index < occurrences.length; index += 1) {
      const occurrence = occurrences[index];
      const end = occurrences[index + 1]?.start ?? text.length;
      const value = text.slice(occurrence.valueStart, end).trim().replace(/^[\s:]+|[\s:]+$/g, "");
      matched.push(occurrence.field.label);
      if (!value) continue;
      const { key, kind } = occurrence.field;
      if (kind === "date") fields[key] = dateValue(value);
      else if (kind === "request") fields[key] = matchOption(value, REQUEST_TYPES) ?? "";
      else if (kind === "industry") fields[key] = matchOption(value, INDUSTRIES) ?? "";
      else if (kind === "sector") {
        const industry = fields.industry;
        fields[key] = matchOption(value, industry ? (SECTORS[industry] ?? []) : Object.values(SECTORS).flat()) ?? "";
      } else if (kind === "size") fields[key] = matchOptions(value, SIZE_OPTIONS).length ? matchOptions(value, SIZE_OPTIONS) : customValues(value);
      else if (kind === "ownership") fields[key] = matchOptions(value, OWNERSHIP_OPTIONS).length ? matchOptions(value, OWNERSHIP_OPTIONS) : customValues(value);
      else if (kind === "geography") fields[key] = matchOptions(value, GEOGRAPHY_OPTIONS).length ? matchOptions(value, GEOGRAPHY_OPTIONS) : customValues(value);
      else if (kind === "execs") {
        const sameAsSubmitter = /\bsame as submitter\b/i.test(value);
        fields[key] = sameAsSubmitter ? "" : value;
        if (sameAsSubmitter) fields.sameAsSubmitter = true;
      } else fields[key] = value;
    }
    return { fields, matched };
  } catch {
    return { fields: {}, matched: [] };
  }
}
