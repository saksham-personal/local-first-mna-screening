import assert from "node:assert/strict";
import test from "node:test";
import {
  initializeTheme,
  parseThemePreference,
  resolveTheme,
  setThemePreference,
  themeStorageKey,
} from "../src/lib/theme-store";

test("appearance falls back to the system and explicit choices take priority", () => {
  for (const value of [null, "invalid", "", 1])
    assert.equal(parseThemePreference(value), "system");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});

test("appearance applies persisted choices, follows OS changes only in System, and survives blocked storage", () => {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const saved = new Map<string, string>([[themeStorageKey, "invalid"]]);
  let blocked = false;
  let onMedia = () => {};
  let onStorage = (_: { key: string; newValue: string | null }) => {};
  const media = {
    matches: false,
    addEventListener: (_: string, fn: () => void) => {
      onMedia = fn;
    },
  };
  const element = {
    dataset: {} as Record<string, string>,
    style: {} as Record<string, string>,
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      matchMedia: () => media,
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (blocked) throw new Error("Unavailable");
          saved.set(key, value);
        },
      },
      addEventListener: (_: string, fn: typeof onStorage) => {
        onStorage = fn;
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { documentElement: element, querySelector: () => null },
  });
  try {
    initializeTheme();
    assert.equal(element.dataset.theme, "light");
    setThemePreference("dark");
    assert.equal(element.style.colorScheme, "dark");
    assert.equal(saved.get(themeStorageKey), "dark");
    onMedia();
    assert.equal(element.dataset.theme, "dark");
    setThemePreference("system");
    assert.equal(element.dataset.theme, "light");
    media.matches = true;
    onMedia();
    assert.equal(element.dataset.theme, "dark");
    setThemePreference("light");
    onMedia();
    assert.equal(element.dataset.theme, "light");
    onStorage({ key: themeStorageKey, newValue: "dark" });
    assert.equal(element.dataset.theme, "dark");
    blocked = true;
    assert.doesNotThrow(() => setThemePreference("light"));
    assert.equal(element.dataset.theme, "light");
  } finally {
    if (priorWindow) Object.defineProperty(globalThis, "window", priorWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (priorDocument)
      Object.defineProperty(globalThis, "document", priorDocument);
    else Reflect.deleteProperty(globalThis, "document");
  }
});
