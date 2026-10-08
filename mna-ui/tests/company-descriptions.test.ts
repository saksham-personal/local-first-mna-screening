import assert from "node:assert/strict";
import test from "node:test";
import { descriptionPreview, descriptionSections } from "../src/workspace/description-content";
import type { GridDescription } from "../src/lib/grid-client";

const mid: GridDescription["sources"][number] = { source: "MID", items: [{ label: "MID_Company Description", text: "MID claims platform" }, { label: "Pitchbook Description:", text: "PB software" }, { label: "Unused", text: " " }] };
const iscc: GridDescription["sources"][number] = { source: "ISCC", items: [{ label: "Company Description", text: "ISCC insurer software" }, { label: "Unused", text: "-" }] };
test("single-source tooltip has bold-label content without a source heading or prefix", () => {
  assert.deepEqual(descriptionSections({ company_id: "one", sources: [mid] }), [{ heading: undefined, items: [{ label: "Company Description", text: "MID claims platform" }, { label: "Pitchbook Description", text: "PB software" }] }]);
  assert.deepEqual(descriptionSections(undefined), []);
});
test("dual-source tooltip builds MID then ISCC sections with uppercase headings", () => {
  const sections = descriptionSections({ company_id: "one", sources: [iscc, mid] });
  assert.deepEqual(sections.map(section => section.heading), ["MID DESCRIPTION", "ISCC DESCRIPTION"]);
  assert.equal(sections[1].items.length, 1);
});
test("preview selects the exact description and source instead of leaking MID into ISCC cells", () => {
  const description = { company_id: "one", sources: [mid, iscc] };
  assert.equal(descriptionPreview(description, "MID_Pitchbook Description"), "PB software");
  assert.equal(descriptionPreview(description, "ISCC_Company Description"), "ISCC insurer software");
  assert.equal(descriptionPreview(description, "Company Description", "iscc"), "ISCC insurer software");
  assert.equal(descriptionPreview(undefined, "Company Description"), undefined);
});
