import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export const themeStorageKey = "screening-appearance-v1";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

const listeners = new Set<() => void>();
let snapshot: { preference: ThemePreference; resolved: ResolvedTheme } = {
  preference: "system",
  resolved: "light",
};
let media: MediaQueryList | undefined;
let initialized = false;

function apply(preference: ThemePreference) {
  const resolved = resolveTheme(preference, media?.matches ?? false);
  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.style.colorScheme = resolved;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolved === "dark" ? "#191b1e" : "#f7f7f5");
  }
  if (snapshot.preference === preference && snapshot.resolved === resolved)
    return;
  snapshot = { preference, resolved };
  for (const listener of listeners) listener();
}

export function initializeTheme() {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  media = window.matchMedia("(prefers-color-scheme: dark)");
  let preference: ThemePreference = "system";
  try {
    preference = parseThemePreference(
      window.localStorage.getItem(themeStorageKey),
    );
  } catch {
    /* In-memory preference still works. */
  }
  apply(preference);
  media.addEventListener("change", () => apply(snapshot.preference));
  window.addEventListener("storage", (event) => {
    if (event.key === themeStorageKey || event.key === null)
      apply(parseThemePreference(event.newValue));
  });
}

export function setThemePreference(preference: ThemePreference) {
  initializeTheme();
  try {
    window.localStorage.setItem(themeStorageKey, preference);
  } catch {
    /* Theme remains usable if storage is blocked. */
  }
  apply(preference);
}

export function useTheme() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => snapshot,
    () => snapshot,
  );
}
