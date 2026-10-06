import assert from "node:assert/strict";
import test from "node:test";
import {
  DOCK_MIN_WIDTH,
  DOCK_RAIL_WIDTH,
  DOCK_STORAGE_KEY,
  clampDockWidth,
  collapseDock,
  defaultDockState,
  dockColumnWidth,
  loadDockState,
  maxDockWidth,
  openDock,
  parseDockState,
  resizeDock,
  saveDockState,
  toggleExpandedDock,
} from "../src/chat/dock-state";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

test("the dock key and the three column widths are stable", () => {
  assert.equal(DOCK_STORAGE_KEY, "screening-dock-v1");
  assert.equal(dockColumnWidth({ mode: "rail" }, 1440), DOCK_RAIL_WIDTH);
  assert.equal(DOCK_RAIL_WIDTH, 44);
  assert.equal(dockColumnWidth({ mode: "default" }, 1440), 390);
  assert.equal(dockColumnWidth({ mode: "default" }, 1100), 350);
  assert.equal(dockColumnWidth({ mode: "default", width: 500 }, 1440), 500);
  assert.equal(dockColumnWidth({ mode: "expanded" }, 1440), maxDockWidth(1440));
});

test("the dock is limited to 60% of the window and never below 320 px", () => {
  assert.equal(maxDockWidth(1440), 864);
  assert.equal(clampDockWidth(2000, 1440), 864);
  assert.equal(clampDockWidth(100, 1440), DOCK_MIN_WIDTH);
  assert.equal(clampDockWidth(333.4, 1440), 333);
  // A narrow window still honours the minimum even though 60% is smaller.
  assert.equal(maxDockWidth(500), DOCK_MIN_WIDTH);
});

test("the dock leaves room for the navigation and the workspace", () => {
  // 1024 px window with a 236 px sidebar: 60% would leave only 174 px for the workspace.
  assert.equal(maxDockWidth(1024), 614);
  assert.equal(maxDockWidth(1024, 236), 468);
  assert.equal(clampDockWidth(600, 1024, 236), 468);
  assert.equal(dockColumnWidth({ mode: "expanded" }, 1024, 236), 468);
});

test("saved dock state is validated and falls back to the default", () => {
  assert.deepEqual(parseDockState(null), defaultDockState);
  assert.deepEqual(parseDockState(""), defaultDockState);
  assert.deepEqual(parseDockState("not json"), defaultDockState);
  assert.deepEqual(parseDockState('{"mode":"sideways"}'), { mode: "default" });
  assert.deepEqual(parseDockState('{"mode":"rail","width":420.4}'), { mode: "rail", width: 420 });
  assert.deepEqual(parseDockState('{"mode":"expanded","width":12}'), { mode: "expanded" });
  assert.deepEqual(parseDockState('{"mode":"default","width":"wide"}'), { mode: "default" });
});

test("dock state round-trips through storage and survives blocked storage", () => {
  const storage = memoryStorage();
  saveDockState({ mode: "rail", width: 480 }, storage);
  assert.equal(storage.values.get(DOCK_STORAGE_KEY), '{"mode":"rail","width":480}');
  assert.deepEqual(loadDockState(storage), { mode: "rail", width: 480 });

  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(loadDockState(blocked), defaultDockState);
  assert.doesNotThrow(() => saveDockState({ mode: "default" }, blocked));
});

test("the rail remembers the dragged width and reopening restores it", () => {
  const dragged = resizeDock(520, 1440);
  assert.deepEqual(dragged, { mode: "default", width: 520 });
  const rail = collapseDock(dragged);
  assert.deepEqual(rail, { mode: "rail", width: 520 });
  assert.deepEqual(openDock(rail), { mode: "default", width: 520 });
  // Opening an already-open dock changes nothing.
  assert.equal(openDock(dragged), dragged);
});

test("expanding toggles and dragging leaves the expanded mode", () => {
  assert.deepEqual(toggleExpandedDock({ mode: "default", width: 400 }), { mode: "expanded", width: 400 });
  assert.deepEqual(toggleExpandedDock({ mode: "expanded", width: 400 }), { mode: "default", width: 400 });
  assert.deepEqual(resizeDock(5000, 1440), { mode: "default", width: 864 });
});
