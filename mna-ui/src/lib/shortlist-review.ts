export function meetsScoreRule(value: unknown, minimum: number, keepCheck: boolean, keepUnknown: boolean): boolean {
  if (typeof value === "string" && value.trim().toUpperCase() === "CHECK") return keepCheck;
  const numeric = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(numeric) && numeric >= 0 && numeric <= 10 ? numeric >= minimum : keepUnknown;
}
