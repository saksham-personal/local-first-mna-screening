import { zipSync } from 'fflate';
import type { Company, ExportKind } from './contracts';

const filenames: Record<ExportKind, string> = {
  pitchbook: 'screening-pitchbook.xlsx',
  llm: 'screening-llm.xlsx',
  full: 'screening-full.xlsx',
};

type Cell = string | number | null | undefined;
type Sheet = { name: string; headers: string[]; rows: Cell[][] };

function xmlEscape(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function columnName(index: number): string {
  let name = '';
  while (index > 0) {
    const remainder = (index - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    index = Math.floor((index - 1) / 26);
  }
  return name;
}

function cellXml(value: Cell, reference: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${reference}"><v>${value}</v></c>`;
  }
  if (value === null || value === undefined || value === '') return `<c r="${reference}"/>`;
  // inlineStr keeps user supplied strings literal, including values beginning with '='.
  return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function worksheetXml(sheet: Sheet): string {
  const rows = [sheet.headers, ...sheet.rows];
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => cellXml(value, `${columnName(columnIndex + 1)}${rowIndex + 1}`)).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>${body}</sheetData></worksheet>`;
}

function asSheet(kind: ExportKind, companies: Company[]): Sheet[] {
  if (kind === 'pitchbook') {
    const headers = ['pk', 'Company Name', 'Website', 'HQ City', 'HQ State', 'Source'];
    return [{ name: 'PitchBook', headers, rows: companies.map((company) => [
      company.pk, company.name, company.website, company.city, company.state, company.source,
    ]) }];
  }
  if (kind === 'llm') {
    const headers = ['index', 'pk', 'Company Name', 'Website', 'Source', 'Description'];
    return [{ name: 'LLM Screening', headers, rows: companies.map((company, index) => [
      index + 1, company.pk, company.name, company.website, company.source, company.description,
    ]) }];
  }

  return (['MID', 'ISCC'] as const).map((source) => {
    const selected = companies.filter((company) => company.source === source || company.source === 'both');
    const rawFor = (company: Company): Record<string, string | number> => source === 'MID'
      ? (company.rawMid ?? {}) : (company.rawIscc ?? {});
    const rawHeaders = [...new Set(selected.flatMap((company) => Object.keys(rawFor(company))))];
    const headers = ['pk', 'Source', ...rawHeaders];
    const rows = selected.map((company) => {
      const raw = rawFor(company);
      return [company.pk, company.source, ...rawHeaders.map((header) => raw[header])];
    });
    return { name: source, headers, rows };
  });
}

/** Build a standards-compliant, UTF-8 XLSX archive in memory. */
export function buildWorkbook(kind: ExportKind, companies: Company[]): Uint8Array {
  const sheets = asSheet(kind, companies);
  const sheetEntries = sheets.map((sheet, index) =>
    [`xl/worksheets/sheet${index + 1}.xml`, worksheetXml(sheet)] as const);
  const workbookSheets = sheets.map((sheet, index) =>
    `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const workbookRelationships = sheets.map((_, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const contentOverrides = sheets.map((_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${contentOverrides}</Types>`),
    '_rels/.rels': new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    'xl/workbook.xml': new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelationships}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    'xl/styles.xml': new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`),
  };
  for (const [path, xml] of sheetEntries) files[path] = new TextEncoder().encode(xml);
  return zipSync(files, { level: 6 });
}

export function downloadWorkbook(kind: ExportKind, companies: Company[]): void {
  const bytes = buildWorkbook(kind, companies);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filenames[kind];
  anchor.click();
  URL.revokeObjectURL(url);
}
