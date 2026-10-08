export const companyPageSizes = [100, 250, 500];
export function pageRows<Row>(rows: Row[], page: number, size: number): Row[] {
  return rows.slice(page * size, (page + 1) * size);
}
export function loadingProgress(loaded: number, total: number, pending: boolean): string | undefined {
  return pending ? `Loading all rows ? ${loaded.toLocaleString()} of ${total.toLocaleString()}` : undefined;
}
