// Run with: npm test (node --test --experimental-strip-types)
import test from "node:test";
import assert from "node:assert/strict";
import { agreementValue } from "../app/utils/agreementValue.ts";

test("monthly value is the period fee for calendar-month agreements", () => {
  const v = agreementValue({ fee: 10000, startDate: "2026-01-01", endDate: "2026-03-31", period: "month" });
  assert.equal(v?.monthlyValue, 10000);
  assert.equal(v?.openEnded, false);
  assert.equal(v?.annualValue, null);
  assert.equal(v?.totalValue, 30000);
});

test("total agreement value prorates partial first and last months", () => {
  // 15–31 Jan = 17/31 × 10000 = 5483.87; 1–10 Feb = 10/28 × 10000 = 3571.43
  const v = agreementValue({ fee: 10000, startDate: "2026-01-15", endDate: "2026-02-10", period: "month" });
  assert.equal(v?.monthlyValue, 10000);
  assert.equal(v?.totalValue, 9055.3);
  assert.equal(v?.openEnded, false);
  assert.equal(v?.annualValue, null);
});

test("a full first month plus a clipped last month matches period windows", () => {
  // Jan full 10000 + 1–10 Feb 3571.43
  const v = agreementValue({ fee: 10000, startDate: "2026-01-01", endDate: "2026-02-10", period: "month" });
  assert.equal(v?.totalValue, 13571.43);
});

test("open-ended agreements show annual value as fee × 12", () => {
  const v = agreementValue({ fee: 10000, startDate: "2026-01-15", endDate: "", period: "month" });
  assert.equal(v?.openEnded, true);
  assert.equal(v?.monthlyValue, 10000);
  assert.equal(v?.annualValue, 120000);
  assert.equal(v?.totalValue, null);
});

test("open-ended with a missing end date still yields an annual value", () => {
  const v = agreementValue({ fee: 2500, startDate: "2026-06-01", period: "month" });
  assert.equal(v?.openEnded, true);
  assert.equal(v?.annualValue, 30000);
});

test("a mid-quarter start is prorated by days in the quarter", () => {
  // 2026 Q1 is 90 days; 15 Feb–31 Mar = 45 days → 15000
  const v = agreementValue({ fee: 30000, startDate: "2026-02-15", endDate: "2026-03-31", period: "quarter" });
  assert.equal(v?.monthlyValue, 10000);
  assert.equal(v?.totalValue, 15000);
  assert.equal(v?.openEnded, false);
});

test("open-ended quarterly annual value is four period fees", () => {
  const v = agreementValue({ fee: 30000, startDate: "2026-01-01", period: "quarter" });
  assert.equal(v?.monthlyValue, 10000);
  assert.equal(v?.annualValue, 120000);
  assert.equal(v?.totalValue, null);
  assert.equal(v?.openEnded, true);
});

test("blank or invalid fee yields no summary", () => {
  assert.equal(agreementValue({ fee: "", startDate: "2026-01-01", endDate: "2026-12-31" }), null);
  assert.equal(agreementValue({ fee: null, startDate: "2026-01-01" }), null);
  assert.equal(agreementValue({}), null);
});
