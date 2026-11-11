// Run with: npm test (node --test --experimental-strip-types)
import test from "node:test";
import assert from "node:assert/strict";
import { lastDayOfMonth, normalizeTaxYearEndMonth, previousTaxYearRange, taxYearLabel, taxYearPresets, taxYearRange } from "../app/utils/taxYear.ts";

test("default is the SA tax year: 1 Mar to end Feb", () => {
  assert.deepEqual(taxYearRange("2026-11-11"), { from: "2026-03-01", to: "2027-02-28" });
  assert.deepEqual(taxYearRange("2026-03-01"), { from: "2026-03-01", to: "2027-02-28" });
  assert.deepEqual(taxYearRange("2026-02-28"), { from: "2025-03-01", to: "2026-02-28" });
  assert.deepEqual(taxYearRange("2026-01-15", undefined), { from: "2025-03-01", to: "2026-02-28" });
});

test("leap year February ends on the 29th", () => {
  assert.equal(lastDayOfMonth(2028, 2), 29);
  assert.equal(lastDayOfMonth(2100, 2), 28);
  assert.deepEqual(taxYearRange("2027-06-01", 2), { from: "2027-03-01", to: "2028-02-29" });
  assert.deepEqual(taxYearRange("2028-02-29", 2), { from: "2027-03-01", to: "2028-02-29" });
  assert.deepEqual(previousTaxYearRange("2028-05-01", 2), { from: "2027-03-01", to: "2028-02-29" });
});

test("June year end: 1 Jul to 30 Jun", () => {
  assert.deepEqual(taxYearRange("2026-11-11", 6), { from: "2026-07-01", to: "2027-06-30" });
  assert.deepEqual(taxYearRange("2026-06-30", 6), { from: "2025-07-01", to: "2026-06-30" });
  assert.deepEqual(taxYearRange("2026-07-01", 6), { from: "2026-07-01", to: "2027-06-30" });
  assert.deepEqual(previousTaxYearRange("2026-11-11", 6), { from: "2025-07-01", to: "2026-06-30" });
});

test("December year end is the calendar year", () => {
  assert.deepEqual(taxYearRange("2026-11-11", 12), { from: "2026-01-01", to: "2026-12-31" });
  assert.deepEqual(previousTaxYearRange("2026-01-01", 12), { from: "2025-01-01", to: "2025-12-31" });
});

test("invalid end months fall back to February", () => {
  for (const v of [0, 13, "x", null, 2.5]) assert.equal(normalizeTaxYearEndMonth(v), 2);
  assert.equal(normalizeTaxYearEndMonth("6"), 6);
});

test("labels and presets", () => {
  assert.equal(taxYearLabel({ from: "2026-03-01", to: "2027-02-28" }), "Mar 2026 - Feb 2027");
  const [current, last] = taxYearPresets("2026-11-11", 2);
  assert.deepEqual(current, { label: "This tax year (Mar 2026 - Feb 2027)", from: "2026-03-01", to: "2026-11-11" });
  assert.deepEqual(last, { label: "Last tax year (Mar 2025 - Feb 2026)", from: "2025-03-01", to: "2026-02-28" });
  assert.equal(taxYearPresets("2026-11-11", 6)[0]!.label, "This tax year (Jul 2026 - Jun 2027)");
});
