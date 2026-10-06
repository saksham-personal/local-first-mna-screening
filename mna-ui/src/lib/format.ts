/** Shared text helpers so counts and times read the same everywhere. */

export type TimeInput = Date | string | number | null | undefined;
type FormatOptions = { seconds?: boolean; locale?: string };

function toDate(value: TimeInput): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * "1 company", "2 companies", "1,200 files". Returns the count together with the
 * right word, so callers never build "1 companies" by hand.
 */
export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;
}

/** Just the right word for a count, for sentences that print the number themselves. */
export function pluralWord(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return count === 1 ? singular : pluralForm;
}

/** "1:33 AM" (or "1:33:49 AM" with seconds). Empty text for a missing or invalid time. */
export function formatTime(value: TimeInput, options: FormatOptions = {}): string {
  const date = toDate(value);
  if (!date) return "";
  return date.toLocaleTimeString(options.locale, {
    hour: "numeric",
    minute: "2-digit",
    ...(options.seconds ? { second: "2-digit" as const } : {}),
  });
}

/**
 * "Oct 6, 1:33 AM". The year appears only when it is not the current year.
 * Empty text for a missing or invalid time.
 */
export function formatDateTime(
  value: TimeInput,
  options: FormatOptions & { now?: Date } = {},
): string {
  const date = toDate(value);
  if (!date) return "";
  const currentYear = (options.now ?? new Date()).getFullYear();
  return date.toLocaleString(options.locale, {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === currentYear ? {} : { year: "numeric" as const }),
    hour: "numeric",
    minute: "2-digit",
    ...(options.seconds ? { second: "2-digit" as const } : {}),
  });
}
