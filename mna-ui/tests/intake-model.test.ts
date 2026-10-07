import assert from "node:assert/strict";
import test from "node:test";
import {
  characterCount,
  emptyIntake,
  extractIntakeFieldsFromText,
  intakeToCriteria,
  normalizeIntake,
  sectorsFor,
} from "../src/intake/intake-model";

test("emptyIntake provides all fields with empty values", () => {
  assert.deepEqual(emptyIntake(), {
    submitterName: "",
    dueDate: "",
    seniorClientExecs: "",
    sameAsSubmitter: false,
    requestType: "",
    industry: "",
    sector: "",
    subSector: "",
    investmentThesis: "",
    productsServices: "",
    endMarkets: "",
    sizeParameters: [],
    ownershipPreference: [],
    geographyFocus: [],
  });
});

test("normalizeIntake trims known fields, de-duplicates arrays, and clears invalid sectors", () => {
  assert.deepEqual(normalizeIntake({
    submitterName: "  Analyst  ",
    industry: "Diversified",
    sector: "Healthcare Services",
    investmentThesis: " idea ",
    sizeParameters: [" $100MM - 250MM ", " $100MM - 250MM", "", 4],
    geographyFocus: ["Canada", "Canada"],
    sameAsSubmitter: true,
    extracted: true,
    hidden: "discard me",
  }), {
    ...emptyIntake(),
    submitterName: "Analyst",
    seniorClientExecs: "Analyst",
    industry: "Diversified",
    sector: "",
    investmentThesis: "idea",
    sizeParameters: ["$100MM - 250MM"],
    geographyFocus: ["Canada"],
    sameAsSubmitter: true,
    extracted: true,
  });
  assert.deepEqual(normalizeIntake({ sector: "Basic Materials" }).sector, "");
  assert.equal(normalizeIntake({ extracted: false }).extracted, false);
});

test("sectorsFor returns the industry choices and an empty list for unknown industries", () => {
  assert.deepEqual(sectorsFor("Diversified"), [
    "Aerospace & Defense",
    "Automotive",
    "Basic Materials",
    "Capital Goods & Other",
    "Chemicals",
    "Metals",
    "Transportation",
  ]);
  assert.deepEqual(sectorsFor("Unknown"), []);
});

test("intakeToCriteria separates core definition from recorded conditions", () => {
  const result = intakeToCriteria({
    ...emptyIntake(),
    submitterName: "Jordan Lee",
    dueDate: "2026-09-25",
    seniorClientExecs: "",
    sameAsSubmitter: true,
    requestType: "General Industry Screen",
    industry: "Diversified",
    sector: "Basic Materials",
    subSector: "Building products",
    investmentThesis: "We seek businesses with a durable service niche.",
    productsServices: "sEe AbOvE",
    endMarkets: "See above",
    sizeParameters: ["$100MM - 250MM", "$500MM+"],
    ownershipPreference: ["Sponsor owned"],
    geographyFocus: ["US - All regions", "Canada"],
  });
  assert.equal(result.definition, "We seek businesses with a durable service niche.");
  assert.match(result.criteriaText, /Submitter name: Jordan Lee/);
  assert.match(result.criteriaText, /Senior client exec\(s\): Jordan Lee/);
  assert.match(result.criteriaText, /Relevant products\/services: sEe AbOvE/);
  assert.match(result.criteriaText, /Focus on any specific end-markets: See above/);
  assert.match(result.criteriaText, /Geography focus: US - All regions, Canada/);
  assert.deepEqual(result.deferred, [
    "Industry: Diversified › Basic Materials › Building products",
    "Size: $100MM - 250MM, $500MM+",
    "Ownership: Sponsor owned",
    "Geography: US - All regions, Canada",
  ]);
  assert.deepEqual(result.metadata, {
    submitterName: "Jordan Lee",
    dueDate: "2026-09-25",
    seniorClientExecs: "Jordan Lee",
    requestType: "General Industry Screen",
  });
});

test("the printed form extractor maps labels, option values, and common date text", () => {
  const text = `
Submitter name:
Jordan Lee
Due date:
25 Sep 2026
Senior client
exec(s):
Same as submitter
Request type:
General Industry Screen
Industry:
Diversified
Sector:
Basic Materials
Sub-sector:
Building products
Investment thesis:
We seek businesses that source lumber…
Relevant products/services:
See above
Focus on any specific end-markets:
Residential construction
General size parameters:
$100MM - 250MM, $500MM+
Ownership preference:
Sponsor owned
Geography focus:
US - All regions, Canada
`;
  const result = extractIntakeFieldsFromText(text);
  assert.equal(result.fields.submitterName, "Jordan Lee");
  assert.equal(result.fields.dueDate, "2026-09-25");
  assert.equal(result.fields.sameAsSubmitter, true);
  assert.equal(result.fields.requestType, "General Industry Screen");
  assert.equal(result.fields.industry, "Diversified");
  assert.equal(result.fields.sector, "Basic Materials");
  assert.equal(result.fields.subSector, "Building products");
  assert.equal(result.fields.investmentThesis, "We seek businesses that source lumber…");
  assert.deepEqual(result.fields.sizeParameters, ["$100MM - 250MM", "$500MM+"]);
  assert.deepEqual(result.fields.geographyFocus, ["US - All regions", "Canada"]);
  assert.equal(result.matched.length, 13);
  assert.deepEqual(extractIntakeFieldsFromText("An unrelated document").fields, {});
});

test("the printed form extractor handles a flat single-line document without matching labels in prose", () => {
  const text = "Submitter name: Casey Morgan Due date: 25 Sep 2026 Senior client exec(s): Same as submitter Request type: General Industry Screen Industry: Diversified Sector: Basic Materials Sub-sector: Building products Investment thesis: We seek businesses that source lumber and serve residential construction Relevant products/services: Engineered wood Focus on any specific end-markets: Residential construction General size parameters: $100MM - 250MM, $500MM+ Ownership preference: Sponsor owned Geography focus: US - All regions, Canada";
  const result = extractIntakeFieldsFromText(text);

  assert.equal(result.fields.submitterName, "Casey Morgan");
  assert.equal(result.fields.dueDate, "2026-09-25");
  assert.equal(result.fields.sameAsSubmitter, true);
  assert.equal(result.fields.requestType, "General Industry Screen");
  assert.equal(result.fields.industry, "Diversified");
  assert.equal(result.fields.sector, "Basic Materials");
  assert.equal(result.fields.subSector, "Building products");
  assert.equal(result.fields.investmentThesis, "We seek businesses that source lumber and serve residential construction");
  assert.deepEqual(result.fields.sizeParameters, ["$100MM - 250MM", "$500MM+"]);
  assert.deepEqual(result.fields.geographyFocus, ["US - All regions", "Canada"]);
  assert.equal(result.matched.length, 13);
  assert.deepEqual(extractIntakeFieldsFromText("The industry has changed and its sector is growing.").matched, []);
});

test("the printed form extractor rejects impossible calendar dates", () => {
  const result = extractIntakeFieldsFromText("Due date: 31 Feb 2026");
  assert.equal(result.fields.dueDate, "");
});

test("a later prose mention of a label does not erase an earlier value", () => {
  const result = extractIntakeFieldsFromText("Industry: Diversified\nSector: Basic Materials\nNotes: we want the leaders in the Industry\nleaders in the sector: x");
  assert.equal(result.fields.industry, "Diversified");
  assert.equal(result.fields.sector, "Basic Materials");
});

test("ownership matching does not read Non-sponsor owned as Sponsor owned", () => {
  const result = extractIntakeFieldsFromText("Ownership preference: Non-sponsor owned / Family or founder owned");
  assert.deepEqual(result.fields.ownershipPreference, ["Non-sponsor owned / Family or founder owned"]);
});

test("characterCount counts without imposing a maximum", () => {
  assert.equal(characterCount("a".repeat(100_001)), 100_001);
});
