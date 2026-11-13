// Run with: npm test (node --test --experimental-strip-types)
import test from "node:test";
import assert from "node:assert/strict";
import { agreementValue, agreementLineTotal, linesValue } from "../app/utils/agreementValue.ts";

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

test("line totals are qty × rate and the period value is their sum", () => {
  assert.equal(agreementLineTotal({ qty: 20, rate: 500 }), 10000);
  assert.equal(agreementLineTotal({ qty: 2.5, rate: 99.99 }), 249.98);
  assert.equal(agreementLineTotal({ qty: "", rate: 500 }), 0);
  assert.equal(linesValue([{ qty: 20, rate: 500 }, { qty: 1, rate: 1500 }, { qty: 0, rate: 250 }]), 11500);
  assert.equal(linesValue([]), 0);
});

test("agreement value from lines: monthly sum, annual when open-ended", () => {
  const lines = [{ qty: 20, rate: 500 }, { qty: 1, rate: 1500 }];
  const v = agreementValue({ lines, startDate: "2026-01-01", period: "month" });
  assert.equal(v?.monthlyValue, 11500);
  assert.equal(v?.annualValue, 138000);
  assert.equal(v?.openEnded, true);
});

test("agreement value from lines with an end date prorates like the backend", () => {
  // 11500 × 17/31 = 6306.45; Feb full 11500
  const v = agreementValue({ lines: [{ qty: 20, rate: 500 }, { qty: 1, rate: 1500 }], startDate: "2026-01-15", endDate: "2026-02-28", period: "month" });
  assert.equal(v?.monthlyValue, 11500);
  assert.equal(v?.totalValue, 17806.45);
  assert.equal(v?.openEnded, false);
});

test("lines take precedence over a legacy fee", () => {
  const v = agreementValue({ lines: [{ qty: 2, rate: 100 }], fee: 9999, startDate: "2026-01-01" });
  assert.equal(v?.monthlyValue, 200);
});

test("a pre-1.10 agreement reads as one time-tracked form line", async () => {
  const { agreementFormLines, agreementLinesPayload } = await import("../app/utils/agreementValue.ts");
  const lines = agreementFormLines({ serviceId: "svc", hours: 20, fee: 10000, rate: 500, overageRate: null });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].qty, 1);
  assert.equal(lines[0].rate, 10000);
  assert.equal(lines[0].includedQty, 20);
  assert.equal(lines[0].overageRate, 500);
  assert.equal(lines[0].tracksTime, true);
  const payload = agreementLinesPayload([
    { ...lines[0], description: "Support" },
    { key: "x", serviceId: "h", description: "Hosting", qty: "1", rate: "", includedQty: "5", overageRate: "9", tracksTime: false },
  ]);
  assert.deepEqual(payload[1], { serviceId: "h", description: "Hosting", qty: 1, rate: null, includedQty: null, overageRate: null, tracksTime: false });
  assert.equal(payload[0].includedQty, 20);
});

test("Object.assign applies an AgreementForm emit onto a reactive page form so qty and rate update the value without a service", async () => {
  const { reactive } = await import("vue");
  const form = reactive({
    name: "",
    customerId: "",
    lines: [{ key: "1", serviceId: "", description: "", qty: 1, rate: "", includedQty: "", overageRate: "", tracksTime: true }],
    startDate: "2026-01-01",
    endDate: "",
    period: "month" as const,
    currency: "",
    autoPublish: false,
    rolloverMode: "expire" as const,
    limitHours: "",
  });
  // AgreementForm emits a whole new object. v-model cannot reassign a const reactive,
  // so the new/edit pages Object.assign the emit onto the existing form.
  Object.assign(form, { ...form, lines: [{ ...form.lines[0], qty: 1, rate: 10 }] });
  assert.equal(form.lines[0].qty, 1);
  assert.equal(form.lines[0].rate, 10);
  assert.equal(form.lines[0].serviceId, "");
  const v = agreementValue({ lines: form.lines, startDate: form.startDate, endDate: form.endDate, period: form.period });
  assert.equal(v?.monthlyValue, 10);
  assert.equal(v?.annualValue, 120);
});
