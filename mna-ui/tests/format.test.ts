import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDateTime,
  formatTime,
  plural,
  pluralWord,
} from "../src/lib/format";

// Intl uses a narrow no-break space before AM/PM on newer ICU builds.
const plain = (value: string) => value.replace(/\s/g, " ");

test("plural prints the count with the right word", () => {
  assert.equal(plural(0, "company", "companies"), "0 companies");
  assert.equal(plural(1, "company", "companies"), "1 company");
  assert.equal(plural(2, "company", "companies"), "2 companies");
  assert.equal(plural(1, "PitchBook ID"), "1 PitchBook ID");
  assert.equal(plural(3, "file"), "3 files");
  assert.equal(plural(1234, "row"), `${(1234).toLocaleString()} rows`);
  assert.equal(pluralWord(1, "run"), "run");
  assert.equal(pluralWord(2, "run"), "runs");
});

test("times use one format with an optional seconds precision", () => {
  const date = new Date(2026, 9, 6, 1, 33, 49);
  assert.equal(plain(formatTime(date, { locale: "en-US" })), "1:33 AM");
  assert.equal(plain(formatTime(date, { locale: "en-US", seconds: true })), "1:33:49 AM");
  assert.equal(
    formatTime(date.toISOString(), { locale: "en-US" }),
    formatTime(date, { locale: "en-US" }),
  );
  assert.equal(formatTime(undefined), "");
  assert.equal(formatTime("not a time"), "");
  assert.equal(formatTime(null), "");
});

test("date and time show the year only outside the current year", () => {
  const now = new Date(2026, 9, 6, 12, 0, 0);
  const date = new Date(2026, 9, 6, 1, 33, 49);
  assert.equal(plain(formatDateTime(date, { locale: "en-US", now })), "Oct 6, 1:33 AM");
  assert.equal(
    plain(formatDateTime(date, { locale: "en-US", now, seconds: true })),
    "Oct 6, 1:33:49 AM",
  );
  const earlier = new Date(2025, 11, 31, 23, 5, 0);
  assert.match(plain(formatDateTime(earlier, { locale: "en-US", now })), /^Dec 31, 2025.*11:05 PM$/);
  assert.equal(formatDateTime("nope"), "");
});
