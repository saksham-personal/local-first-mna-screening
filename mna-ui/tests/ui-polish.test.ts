import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { moveWindowRect, readWindowPosition, rememberWindowPosition, windowPositions } from "../src/files/document-window-geometry";

// Isolate the exported pure helpers from CSS and the polling component runtime.
function pureHelpers(path: string, start: string, end: string) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const isolated = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const exports: Record<string, (...args: any[]) => any> = {};
  runInNewContext(ts.transpile(isolated, { module: ts.ModuleKind.CommonJS }), { exports });
  return exports;
}
const activity = pureHelpers("../src/screening/BackgroundRuns.tsx", "const ACTIVITY_KEY", "const providerNames");
const examples = pureHelpers("../src/chat/FitExamples.tsx", "export function examplesVisible", "export function InlineFitExamples");

test("Activity restores open and closed preferences", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  assert.equal(activity.readActivityOpen(storage), false);
  activity.writeActivityOpen(true, storage);
  assert.equal(activity.readActivityOpen(storage), true);
  activity.writeActivityOpen(false, storage);
  assert.equal(activity.readActivityOpen(storage), false);
  storage.setItem("screening-activity-open-v1", "invalid");
  assert.equal(activity.readActivityOpen(storage), false);
});
test("Activity tolerates unavailable browser storage", () => {
  const storage = { getItem: () => { throw Error("disabled"); }, setItem: () => { throw Error("disabled"); } };
  assert.equal(activity.readActivityOpen(storage), false);
  assert.doesNotThrow(() => activity.writeActivityOpen(true, storage));
});
test("read-only examples hide only when both are empty", () => {
  assert.equal(examples.examplesVisible(" ", "\n", true), false);
  assert.equal(examples.examplesVisible("Good company", "", true), true);
  assert.equal(examples.examplesVisible("", "Bad company", true), true);
  assert.equal(examples.examplesVisible("", "", false), true);
});
test("drag and keyboard movement clamp every edge and handle a smaller viewport", () => {
  const rect = { left: 100, top: 80, width: 560, height: 600 }, viewport = { width: 1200, height: 900 };
  assert.deepEqual(moveWindowRect(rect, { x: -900, y: -900 }, viewport), { ...rect, left: 0, top: 0 });
  assert.deepEqual(moveWindowRect(rect, { x: 900, y: 900 }, viewport), { ...rect, left: 640, top: 300 });
  assert.deepEqual(moveWindowRect(rect, { x: 16, y: -16 }, viewport), { ...rect, left: 116, top: 64 });
  assert.deepEqual(moveWindowRect(rect, { x: 0, y: 0 }, { width: 375, height: 500 }), { left: 0, top: 0, width: 375, height: 500 });
});
test("window types remember independent positions for the tab session", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
  rememberWindowPosition("test-document", { left: 40, top: 60, width: 560, height: 600 }, storage);
  rememberWindowPosition("test-intake", { left: 80, top: 20, width: 880, height: 600 }, storage);
  windowPositions.clear();
  assert.deepEqual(readWindowPosition("test-document", storage), { left: 40, top: 60 });
  assert.deepEqual(readWindowPosition("test-intake", storage), { left: 80, top: 20 });
  storage.setItem("screening-window-invalid", '{"left":"wrong","top":null}');
  assert.equal(readWindowPosition("invalid", storage), undefined);
});
test("window position memory survives blocked session storage", () => {
  const storage = { getItem: () => { throw Error("disabled"); }, setItem: () => { throw Error("disabled"); } };
  rememberWindowPosition("test-blocked", { left: 16, top: 32, width: 400, height: 500 }, storage);
  assert.deepEqual(readWindowPosition("test-blocked", storage), { left: 16, top: 32 });
  windowPositions.clear();
  assert.equal(readWindowPosition("test-blocked", storage), undefined);
});

const css = readFileSync(new URL("../src/theme/theme.css", import.meta.url), "utf8");
const palettes = [":root", ':root[data-theme="dark"]'].map(selector => {
  const start = css.indexOf(`${selector} {`), end = css.indexOf("}", start);
  return Object.fromEntries([...css.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
});
function resolve(palette: Record<string, string>, key: string): string {
  const value = palette[key];
  assert.ok(value, `${key} exists`);
  const alias = /^var\((--[\w-]+)\)$/.exec(value);
  return alias ? resolve(palette, alias[1]) : value;
}
function luminance(hex: string) {
  assert.match(hex, /^#[a-f\d]{6}$/i);
  const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a: string, b: string) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
test("both themes define the same complete token contract", () => {
  assert.deepEqual(Object.keys(palettes[0]).sort(), Object.keys(palettes[1]).sort());
});
for (const [index, palette] of palettes.entries()) {
  test(`${index ? "dark" : "light"} palette meets WCAG text, icon, border and semantic contrast`, () => {
    const check = (text: string, surface: string, minimum: number) => {
      const ratio = contrast(resolve(palette, text), resolve(palette, surface));
      assert.ok(ratio >= minimum, `${text} / ${surface}: ${ratio.toFixed(2)} < ${minimum}`);
    };
    for (const surface of ["--canvas", "--surface", "--surface-raised", "--surface-muted", "--sidebar"]) {
      for (const text of ["--text", "--text-muted", "--text-faint"]) check(text, surface, 4.5);
      for (const border of ["--border-control", "--accent"]) check(border, surface, 3);
    }
    for (const state of ["success", "warning", "danger", "info", "violet", "source-mid", "source-iscc", "source-pb", "source-rogo", "source-bing", "accent"]) check(`--${state}`, `--${state}-soft`, 4.5);
    check("--on-accent", "--accent", 4.5);
    check("--on-accent", "--accent-hover", 4.5);
  });
}
