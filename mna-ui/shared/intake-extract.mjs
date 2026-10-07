export const INDUSTRY_SECTORS = {
  "Technology, Media, & Telecommunications": ["Technology", "Media", "Communications"],
  "Consumer/Retail": ["Retail Industries", "Consumer", "C&R Business Services", "Business Services"],
  Diversified: ["Aerospace & Defense", "Automotive", "Basic Materials", "Capital Goods & Other", "Chemicals", "Metals", "Transportation"],
  "Financial Institutions Group": ["Insurance", "Specialty finance"],
  "Energy/Power & Renewables/Mining": ["Energy", "Mining", "Power & Renewables"],
  Healthcare: ["Biotech/Pharma", "Healthcare Services", "Life Science tools & diagnostics", "Medical Devices", "Pharmaceuticals"],
  "Unassigned Industry": ["Unassigned Industry"],
};

const INDUSTRIES = Object.keys(INDUSTRY_SECTORS);
export const REQUEST_TYPES = [
  "New Platform (Sponsor / Family Office)",
  "Add-on (Sponsor / Family Office)",
  "Acquisitive Strategic Client (non-Sponsor)",
  "General Industry Screen",
];
export const SIZE_OPTIONS = ["$0 - 50MM", "$50MM - 100MM", "$100MM - 250MM", "$250MM - 500MM", "$500MM+"];
export const OWNERSHIP_OPTIONS = ["Non-sponsor owned / Family or founder owned", "Sponsor owned", "VC-backed"];
export const GEOGRAPHY_OPTIONS = ["US - All regions", "Canada"];

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
  // Longest options first; a matched option is blanked out so a shorter option
  // inside it (e.g. "Sponsor owned" in "Non-sponsor owned") does not also match.
  let haystack = normalized(value);
  const found = new Set();
  for (const option of [...options].sort((a, b) => normalized(b).length - normalized(a).length)) {
    const needle = normalized(option);
    if (needle && haystack.includes(needle)) {
      found.add(option);
      haystack = haystack.split(needle).join(" ");
    }
  }
  return options.filter((option) => found.has(option));
}

function hasValue(value) {
  return Array.isArray(value) ? value.length > 0 : typeof value === "string" ? value.length > 0 : value !== undefined;
}

function validDate(yearValue, month, day) {
  const year = Number(yearValue);
  if (!Number.isInteger(year) || year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return "";
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (day > daysInMonth) return "";
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateValue(value) {
  const trimmed = value.trim();
  const iso = trimmed.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) return validDate(iso[1], Number(iso[2]), Number(iso[3]));
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const match = trimmed.match(/\b(\d{1,2})\s+([a-z]{3,9})\.?[,]?\s+(\d{4})\b/i)
    ?? trimmed.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})[,]?\s+(\d{4})\b/i);
  if (!match) return "";
  const dayFirst = /^\d/.test(match[1]);
  const day = Number(dayFirst ? match[1] : match[2]);
  const monthText = (dayFirst ? match[2] : match[1]).toLocaleLowerCase();
  const month = monthNames.findIndex((name) => monthText.startsWith(name)) + 1;
  return validDate(match[3], month, day);
}

function customValues(value) {
  return value.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);
}

function labelExpression(field) {
  const pattern = field.label.split(/\s+/).map(escapeRegExp).join("[\\t \\r\\n]+");
  return new RegExp(`(?<![A-Za-z0-9_])(${pattern})(?![A-Za-z0-9_])`, "gi");
}

function hasShortLabelBoundary(text, start, end) {
  const followingSpaces = text.slice(end).match(/^[\t ]*/)?.[0].length ?? 0;
  const after = text.slice(end + followingSpaces);
  const followedByColonOrLineBreak = after.startsWith(":") || /^(?:\r?\n)/.test(after);
  const precededByLineBreak = /(?:\r?\n)[\t ]*$/.test(text.slice(0, start));
  return followedByColonOrLineBreak || precededByLineBreak;
}

function labelOccurrences(text) {
  const candidates = [];
  const orderedLabels = [...labels].sort((left, right) => right.label.length - left.label.length);
  for (const field of orderedLabels) {
    const expression = labelExpression(field);
    for (const match of text.matchAll(expression)) {
      const start = match.index;
      const end = start + match[0].length;
      if ((field.key === "industry" || field.key === "sector") && !hasShortLabelBoundary(text, start, end)) continue;

      let valueStart = end;
      while (/[\t ]/.test(text[valueStart] ?? "")) valueStart += 1;
      if (text[valueStart] === ":") valueStart += 1;
      while (/\s/.test(text[valueStart] ?? "")) valueStart += 1;
      candidates.push({ field, start, end, valueStart });
    }
  }
  candidates.sort((left, right) => left.start - right.start || right.end - left.end);
  const occurrences = [];
  let consumedUntil = -1;
  for (const candidate of candidates) {
    // Longest labels win when one label overlaps another (notably Sub-sector/Sector).
    if (candidate.start < consumedUntil) continue;
    occurrences.push(candidate);
    consumedUntil = candidate.end;
  }
  return occurrences;
}

/**
 * Best-effort parser for text from a printed Intake Form. This is a pluggable
 * v1; the analyst will refine it after reviewing real intake documents.
 */
export function extractIntakeFieldsFromText(text) {
  if (typeof text !== "string" || !text.trim()) return { fields: {}, matched: [] };
  try {
    const occurrences = labelOccurrences(text);
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
      // A later occurrence of a label (often prose) never overwrites a value already found.
      if (hasValue(fields[key])) continue;
      if (kind === "date") fields[key] = dateValue(value);
      else if (kind === "request") fields[key] = matchOption(value, REQUEST_TYPES) ?? "";
      else if (kind === "industry") fields[key] = matchOption(value, INDUSTRIES) ?? "";
      else if (kind === "sector") {
        const industry = fields.industry;
        const sectorOptions = industry ? INDUSTRY_SECTORS[industry] ?? [] : Object.values(INDUSTRY_SECTORS).flat();
        fields[key] = matchOption(value, sectorOptions) ?? "";
      } else if (kind === "size") {
        const matchedOptions = matchOptions(value, SIZE_OPTIONS);
        fields[key] = matchedOptions.length ? matchedOptions : customValues(value);
      } else if (kind === "ownership") {
        const matchedOptions = matchOptions(value, OWNERSHIP_OPTIONS);
        fields[key] = matchedOptions.length ? matchedOptions : customValues(value);
      } else if (kind === "geography") {
        const matchedOptions = matchOptions(value, GEOGRAPHY_OPTIONS);
        fields[key] = matchedOptions.length ? matchedOptions : customValues(value);
      } else if (kind === "execs") {
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
