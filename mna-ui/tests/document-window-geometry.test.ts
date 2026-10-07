import assert from "node:assert/strict";
import test from "node:test";
import { clampWindowRect, defaultDocumentWindowRect, resizeWindowRect } from "../src/files/document-window-geometry";

test("default document window is right aligned and clamped to the viewport", () => {
  assert.deepEqual(defaultDocumentWindowRect({ width: 1440, height: 900 }), {
    left: 856,
    top: 24,
    width: 560,
    height: 720,
  });
  assert.deepEqual(defaultDocumentWindowRect({ width: 375, height: 640 }), {
    left: 0,
    top: 0,
    width: 375,
    height: 640,
  });
});

test("clamping keeps a window within the viewport and enforces minimum size when possible", () => {
  assert.deepEqual(clampWindowRect({ left: -25, top: 900, width: 200, height: 900 }, { width: 900, height: 700 }), {
    left: 0,
    top: 0,
    width: 360,
    height: 700,
  });
});

test("resizing applies pointer deltas, minimum dimensions, and viewport bounds", () => {
  const rect = { left: 100, top: 80, width: 560, height: 600 };
  assert.deepEqual(resizeWindowRect(rect, { x: -500, y: -300 }, { width: 1200, height: 900 }), {
    left: 100,
    top: 80,
    width: 360,
    height: 420,
  });
  assert.deepEqual(resizeWindowRect(rect, { x: 900, y: 500 }, { width: 1200, height: 900 }), {
    left: 100,
    top: 0,
    width: 1100,
    height: 900,
  });
});
