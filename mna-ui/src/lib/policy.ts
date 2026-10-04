import type { FunnelCounts } from './contracts';

export const uniqueCount = (counts: FunnelCounts): number =>
  counts.midOnly + counts.isccOnly + counts.both;

export const recommendNext = (total: number): 'PitchBook enrichment' | 'LLM screening' =>
  total < 2000 ? 'PitchBook enrichment' : 'LLM screening';

export type PlanAction = 'pitchbook' | 'rogo' | 'bing' | 'llm' | 'copilot';

const actionTerms: Array<{ action: PlanAction; pattern: RegExp }> = [
  { action: 'pitchbook', pattern: /\bpitch\s*book\b|\bpitchbook\b|\bp[.]?b[.]?\b/i },
  { action: 'rogo', pattern: /\brogo\b/i },
  { action: 'bing', pattern: /\bbing\b/i },
  { action: 'llm', pattern: /\bllm\b|\blarge language model(?:s)?\b/i },
  { action: 'copilot', pattern: /\bcopilot\b|\bm(?:icrosoft)?\s*365\b|\boffice\s*365\b/i },
];

/** Detect named research steps in the order they first appear, without repeats. */
export function planActions(text: string): PlanAction[] {
  return actionTerms
    .flatMap(({ action, pattern }) => {
      pattern.lastIndex = 0;
      const match = pattern.exec(text);
      return match ? [{ action, index: match.index }] : [];
    })
    .sort((left, right) => left.index - right.index)
    .map(({ action }) => action);
}

export const PRESERVE_KEY_PLACEHOLDERS = new Set([
  '', '-', '0', 'na', 'n/a', '#n/a', 'not available', 'notavailable',
]);

/** Primary key used to keep a selected row stable across filter changes. */
export const preserveKey = 'pk';
export const PRESERVE_KEY = preserveKey;

function usableId(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || PRESERVE_KEY_PLACEHOLDERS.has(normalized.toLowerCase())) return null;
  return normalized;
}

/** Normalize MID/ISCC identifiers, marking ECID-only records as provisional. */
export function normalizedCompanyKey(ecid: string | null | undefined, cid: string | null | undefined): string | null {
  const usableEcid = usableId(ecid);
  const usableCid = usableId(cid);
  if (usableEcid && usableCid) return `${usableEcid}-${usableCid}`;
  if (usableEcid) return `${usableEcid}-X`;
  if (usableCid) return `X-${usableCid}`;
  return null;
}
