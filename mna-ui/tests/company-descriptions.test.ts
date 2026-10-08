import assert from "node:assert/strict";
import test from "node:test";
import { combinedDescriptionText, descriptionPreview, descriptionSections, withDescriptionValues } from "../src/workspace/description-content";
import type { GridCatalogColumn, GridCompany, GridDescription } from "../src/lib/grid-client";
import { catalogColumnSpecs } from "../src/workspace/company-catalog";
import { filterRows } from "../src/grid/grid-filter";

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
  assert.equal(descriptionPreview(description, "ISCC_Missing Description"), undefined);
});

test("cached page descriptions participate in filters without replacing column definitions", () => {
  const catalog: GridCatalogColumn[] = [{ id: "ISCC_Company Description", label: "ISCC_Company Description", source: "iscc", group: "iscc", type: "text", default_visible: true }];
  const columns = catalogColumnSpecs(catalog);
  const original = { company_id: "one", values: { Company: "One" } } as unknown as GridCompany;
  assert.equal(withDescriptionValues(original, catalog, undefined), original);
  const row = withDescriptionValues(original, catalog, { company_id: "one", sources: [mid, iscc] });
  assert.equal(row.values?.Company, "One");
  assert.equal(row.values?.[catalog[0].id], "ISCC insurer software");
  assert.deepEqual(filterRows([row], columns, { quick: "", columns: { [catalog[0].id]: { kind: "text", contains: "insurer" } } }), [row]);
  assert.deepEqual(original.values, { Company: "One" });
  const missing = withDescriptionValues(original, catalog, { company_id: "one", sources: [mid] });
  assert.equal(missing.values?.[catalog[0].id], null);
});

test("combined Description column previews the first description and filters on all of them", () => {
  const description = { company_id: "C1", sources: [
    { source: "MID" as const, items: [{ label: "Company Description", text: "Claims software" }, { label: "Offerings", text: "claims, billing" }] },
    { source: "ISCC" as const, items: [{ label: "Company Description", text: "Insurance claims platform" }] },
  ] };
  assert.equal(descriptionPreview(description, "Description", "derived"), "Claims software");
  assert.equal(combinedDescriptionText(description), "Claims software · claims, billing · Insurance claims platform");
  assert.equal(combinedDescriptionText({ company_id: "C2", sources: [] }), undefined);
});
