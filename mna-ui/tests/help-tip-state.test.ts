import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  helpTipClosed,
  helpTipDelay,
  helpTipReduce,
  type HelpTipEvent,
  type HelpTipState,
} from "../src/ui/help-tip-state";
import Skeleton from "../src/ui/Skeleton";

const run = (events: HelpTipEvent[], from: HelpTipState = helpTipClosed) =>
  events.reduce(helpTipReduce, from);

test("hover and keyboard focus open a tip temporarily and leaving closes it", () => {
  assert.deepEqual(run(["hover-in"]), { open: true, pinned: false });
  assert.deepEqual(run(["hover-in", "hover-out"]), helpTipClosed);
  assert.deepEqual(run(["focus"]), { open: true, pinned: false });
  assert.deepEqual(run(["focus", "blur"]), helpTipClosed);
  assert.deepEqual(run(["hover-out", "blur"]), helpTipClosed);
});

test("a click pins the tip so hover-out and blur no longer close it", () => {
  const pinned = run(["hover-in", "click"]);
  assert.deepEqual(pinned, { open: true, pinned: true });
  assert.equal(run(["hover-out", "blur"], pinned), pinned);
  assert.deepEqual(run(["click"], pinned), helpTipClosed);
  // A tap on touch has no hover: it arrives as focus plus click.
  assert.deepEqual(run(["focus", "click"]), { open: true, pinned: true });
  assert.deepEqual(run(["click"]), { open: true, pinned: true });
});

test("escape or an outside press always closes and unpins", () => {
  assert.deepEqual(
    run(["dismiss"], { open: true, pinned: true }),
    helpTipClosed,
  );
  assert.deepEqual(
    run(["dismiss"], { open: true, pinned: false }),
    helpTipClosed,
  );
  assert.equal(run(["dismiss"]), helpTipClosed);
});

test("unchanged transitions return the same state object", () => {
  const open = { open: true, pinned: false };
  assert.equal(helpTipReduce(open, "hover-in"), open);
  assert.equal(helpTipReduce(helpTipClosed, "hover-out"), helpTipClosed);
  assert.equal(helpTipReduce(helpTipClosed, "dismiss"), helpTipClosed);
});

test("only hover is delayed", () => {
  assert.ok(helpTipDelay("hover-in") > 0);
  assert.ok(helpTipDelay("hover-out") > 0);
  for (const event of ["focus", "blur", "click", "dismiss"] as const)
    assert.equal(helpTipDelay(event), 0);
});

test("skeletons announce a busy status with a hidden label and hide their shapes", () => {
  const html = renderToStaticMarkup(
    createElement(Skeleton, {
      variant: "table",
      rows: 3,
      cols: 4,
      label: "Loading company table",
    }),
  );
  assert.match(html, /role="status"/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /<span class="sr-only">Loading company table<\/span>/);
  assert.match(html, /ui-skeleton-table/);
  // 4 header cells + 3 rows x 4 cells, every shape hidden from assistive technology.
  assert.equal(html.match(/ui-skeleton-bone/g)?.length, 16);
  assert.equal(html.match(/<i [^>]*aria-hidden="true"/g)?.length, 16);
  assert.match(html, /repeat\(4, minmax\(0, 1fr\)\)/);
});

test("skeleton variants render and clamp their counts", () => {
  for (const variant of [
    "line",
    "block",
    "table",
    "card",
    "list",
    "drawer",
  ] as const) {
    const html = renderToStaticMarkup(createElement(Skeleton, { variant }));
    assert.match(html, new RegExp(`ui-skeleton-${variant}`));
    assert.match(html, /<span class="sr-only">Loading<\/span>/);
  }
  const lines = renderToStaticMarkup(
    createElement(Skeleton, { variant: "line", lines: 500 }),
  );
  assert.equal(lines.match(/ui-skeleton-bone/g)?.length, 12);
  const none = renderToStaticMarkup(
    createElement(Skeleton, { variant: "list", rows: -4 }),
  );
  assert.equal(none.match(/ui-skeleton-item/g)?.length, 1);
  const block = renderToStaticMarkup(
    createElement(Skeleton, { height: 40, width: "50%" }),
  );
  assert.match(block, /height:40px/);
  assert.match(block, /width:50%/);
});
