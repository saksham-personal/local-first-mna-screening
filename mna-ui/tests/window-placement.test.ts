import assert from "node:assert/strict";
import test from "node:test";
import { placeBeside, placeWindow } from "../src/files/document-window-geometry";

const dialog = { left: 0, top: 0, width: 880, height: 600 };
const viewport = { width: 1600, height: 900 };
const doc = { left: 1000, top: 24, width: 560, height: 720 };

test("places the dialog to the left of a document window when there is room", () => {
  const position = placeBeside(dialog, doc, viewport);
  assert.deepEqual(position, { left: 104, top: 150 });
  assert.equal(position.left + dialog.width, doc.left - 16);
  assert.deepEqual(placeWindow({ dialog, documents: [doc], viewport }), position);
});

test("places the dialog to the right of a document window when the left has no room", () => {
  assert.deepEqual(placeBeside(dialog, { ...doc, left: 100 }, viewport), { left: 676, top: 150 });
});

test("uses a spot above or below the document when both sides are blocked", () => {
  const wide = { left: 0, top: 500, width: 1000, height: 300 };
  assert.deepEqual(placeBeside({ ...dialog, height: 400 }, wide, { width: 1000, height: 1000 }), { left: 60, top: 84 });
});

test("falls back to the least-overlapping spot when no spot is free", () => {
  const wide = { left: 50, top: 0, width: 900, height: 480 };
  assert.deepEqual(placeBeside({ ...dialog, height: 600 }, wide, { width: 1000, height: 1000 }), { left: 60, top: 400 });
});

test("keeps a side spot inside the viewport when it would run off the right edge", () => {
  const edge = { left: 40, top: 0, width: 120, height: 800 };
  assert.deepEqual(placeBeside(dialog, edge, { width: 1000, height: 800 }), { left: 120, top: 100 });
});

test("every placement stays inside the viewport", () => {
  const size = { ...dialog, width: 600, height: 500 };
  const small = { width: 800, height: 600 };
  const documents = [
    { left: -200, top: -100, width: 400, height: 300 },
    { left: 700, top: 500, width: 300, height: 400 },
    { left: 0, top: 0, width: 800, height: 600 },
  ];
  for (const documentRect of documents) {
    const { left, top } = placeBeside(size, documentRect, small);
    assert.ok(left >= 0 && left <= small.width - size.width, `left ${left} for ${JSON.stringify(documentRect)}`);
    assert.ok(top >= 0 && top <= small.height - size.height, `top ${top} for ${JSON.stringify(documentRect)}`);
  }
});

test("keeps a dragged position and clamps it to the viewport", () => {
  assert.deepEqual(placeWindow({ dialog, documents: [doc], viewport, remembered: { left: 300, top: 40 } }), { left: 300, top: 40 });
  assert.deepEqual(placeWindow({ dialog, documents: [doc], viewport, remembered: { left: 1500, top: 880 } }), { left: 720, top: 300 });
});

test("centres the dialog when no document window is open", () => {
  assert.deepEqual(placeWindow({ dialog, documents: [], viewport }), { left: 360, top: 150 });
});
