function round2(n: number) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function toIsoDate(value: unknown): string {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function addDaysIso(iso: string, days: number): string {
  const base = toIsoDate(iso);
  if (!base) return "";
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + Number(days || 0)));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function daysBetween(a: string, b: string): number {
  const pa = toIsoDate(a);
  const pb = toIsoDate(b);
  if (!pa || !pb) return 0;
  const [ay, am, ad] = pa.split("-").map(Number);
  const [by, bm, bd] = pb.split("-").map(Number);
  return Math.round((Date.UTC(by!, bm! - 1, bd!) - Date.UTC(ay!, am! - 1, ad!)) / 86400000);
}

function daysInclusive(from: string, to: string): number {
  const a = toIsoDate(from);
  const b = toIsoDate(to);
  if (!a || !b || b < a) return 0;
  return daysBetween(a, b) + 1;
}

function startOfCalendarMonth(iso: string): string {
  const d = toIsoDate(iso);
  return d ? `${d.slice(0, 7)}-01` : "";
}

function endOfCalendarMonth(iso: string): string {
  const d = toIsoDate(iso);
  if (!d) return "";
  const [y, m] = d.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m!, 0));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function startOfCalendarQuarter(iso: string): string {
  const d = toIsoDate(iso);
  if (!d) return "";
  const [y, m] = d.split("-").map(Number);
  const startMonth = Math.floor((m! - 1) / 3) * 3 + 1;
  return `${y}-${pad(startMonth)}-01`;
}

function endOfCalendarQuarter(iso: string): string {
  const start = startOfCalendarQuarter(iso);
  if (!start) return "";
  const [y, m] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! + 2, 0));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function periodType(value: unknown): "month" | "quarter" {
  return String(value || "month") === "quarter" ? "quarter" : "month";
}

function fullCalendarPeriod(iso: string, type: "month" | "quarter") {
  if (type === "quarter") {
    return { startsOn: startOfCalendarQuarter(iso), endsOn: endOfCalendarQuarter(iso) };
  }
  return { startsOn: startOfCalendarMonth(iso), endsOn: endOfCalendarMonth(iso) };
}

function nextFullPeriodStart(iso: string, type: "month" | "quarter"): string {
  return addDaysIso(fullCalendarPeriod(iso, type).endsOn, 1);
}

function clipPeriod(full: { startsOn: string; endsOn: string }, startDate: string, endDate: string) {
  const startsOn = startDate && startDate > full.startsOn ? startDate : full.startsOn;
  const endsOn = endDate && endDate < full.endsOn ? endDate : full.endsOn;
  if (endsOn < startsOn) return null;
  const daysInFullPeriod = daysInclusive(full.startsOn, full.endsOn);
  const daysInPeriod = daysInclusive(startsOn, endsOn);
  return { startsOn, endsOn, daysInPeriod, daysInFullPeriod };
}

/** Same rounding as backend prorateAmounts for the period fee. */
function prorateFee(fee: number, daysInPeriod: number, daysInFullPeriod: number): number {
  const includedFee = Math.max(0, Number(fee) || 0);
  const fullDays = Number(daysInFullPeriod) || 0;
  const days = Number(daysInPeriod) || 0;
  if (fullDays <= 0 || days <= 0) return 0;
  if (days === fullDays) return round2(includedFee);
  return round2(includedFee * (days / fullDays));
}

export type AgreementLineInput = {
  id?: string;
  serviceId?: string;
  description?: string;
  qty?: number | string | null;
  rate?: number | string | null;
  includedQty?: number | string | null;
  overageRate?: number | string | null;
  tracksTime?: boolean;
};

function num(raw: unknown): number {
  if (raw === "" || raw === undefined || raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** qty × rate, rounded like the backend (roundMoney). */
export function agreementLineTotal(line: AgreementLineInput): number {
  return round2(num(line.qty) * num(line.rate));
}

/** Period value = sum of line totals (matches backend agreementLines.periodValue). */
export function linesValue(lines: AgreementLineInput[] | null | undefined): number {
  return round2((lines || []).reduce((sum, l) => sum + agreementLineTotal(l), 0));
}

export type AgreementValueInput = {
  /** When given, the period fee is the sum of the lines. */
  lines?: AgreementLineInput[] | null;
  fee?: number | string | null;
  startDate?: string | null;
  endDate?: string | null;
  period?: string | null;
};

export type AgreementValue = {
  monthlyValue: number;
  annualValue: number | null;
  totalValue: number | null;
  openEnded: boolean;
};

function parseFee(raw: unknown): number | null {
  if (raw === "" || raw === undefined || raw === null) return null;
  const fee = Number(raw);
  if (!Number.isFinite(fee) || fee < 0) return null;
  return fee;
}

function monthlyFromFee(fee: number, type: "month" | "quarter"): number {
  return type === "quarter" ? round2(fee / 3) : round2(fee);
}

function annualFromFee(fee: number, type: "month" | "quarter"): number {
  return type === "quarter" ? round2(fee * 4) : round2(fee * 12);
}

function totalProratedFees(fee: number, startDate: string, endDate: string, type: "month" | "quarter"): number | null {
  const start = toIsoDate(startDate);
  const last = toIsoDate(endDate);
  if (!start || !last || last < start) return null;
  let total = 0;
  let cursor = fullCalendarPeriod(start, type).startsOn;
  const stopAt = fullCalendarPeriod(last, type).startsOn;
  let guard = 0;
  while (cursor <= stopAt) {
    const full = fullCalendarPeriod(cursor, type);
    if (full.startsOn > last) break;
    const clipped = clipPeriod(full, start, last);
    if (clipped) total = round2(total + prorateFee(fee, clipped.daysInPeriod, clipped.daysInFullPeriod));
    cursor = nextFullPeriodStart(full.startsOn, type);
    if (++guard > 240) break;
  }
  return total;
}

/**
 * Live agreement-value summary. The period fee is the sum of the agreement lines
 * (qty × rate), or a legacy single fee. Monthly value is the period fee for calendar-month
 * agreements (or fee / 3 for quarters). With an end date, total value is the sum of
 * prorated period fees, matching the recurring-invoice period logic. With no end
 * date, annual value is 12 calendar months of the monthly value (fee × 12, or fee × 4
 * for quarters).
 */
export function agreementValue(input: AgreementValueInput): AgreementValue | null {
  const fee = input.lines && input.lines.length ? linesValue(input.lines) : parseFee(input.fee);
  if (fee == null) return null;
  const type = periodType(input.period);
  const monthlyValue = monthlyFromFee(fee, type);
  const end = toIsoDate(input.endDate);
  if (!end) {
    return { monthlyValue, annualValue: annualFromFee(fee, type), totalValue: null, openEnded: true };
  }
  const start = toIsoDate(input.startDate);
  return {
    monthlyValue,
    annualValue: null,
    totalValue: start ? totalProratedFees(fee, start, end, type) : null,
    openEnded: false,
  };
}

/** Editable line in the agreement form. Numbers stay as typed (string | number) until save. */
export type AgreementFormLine = {
  key: string;
  id?: string;
  serviceId: string;
  description: string;
  qty: number | string;
  rate: number | string;
  includedQty: number | string;
  overageRate: number | string;
  tracksTime: boolean;
};

let lineSeq = 0;
function nextKey() {
  lineSeq += 1;
  return `l${Date.now().toString(36)}${lineSeq}`;
}

export function blankAgreementLine(tracksTime = false): AgreementFormLine {
  return { key: nextKey(), serviceId: "", description: "", qty: 1, rate: "", includedQty: "", overageRate: "", tracksTime };
}

type StoredAgreement = AgreementLineInput & {
  lines?: AgreementLineInput[] | null;
  hours?: number | string | null;
  fee?: number | string | null;
};

/**
 * Form lines for an agreement from the API. Pre-1.10 agreements without lines read as
 * one time-tracked line: qty 1 at the period fee, included qty = hours.
 */
export function agreementFormLines(a: StoredAgreement | null | undefined): AgreementFormLine[] {
  const src: AgreementLineInput[] = a?.lines && a.lines.length
    ? a.lines
    : a?.serviceId
      ? [{ serviceId: a.serviceId, qty: 1, rate: a.fee ?? 0, includedQty: a.hours ?? "", overageRate: a.overageRate ?? a.rate ?? "", tracksTime: true }]
      : [];
  const lines = src.map((l) => ({
    key: nextKey(),
    id: l.id,
    serviceId: String(l.serviceId || ""),
    description: String(l.description || ""),
    qty: l.qty ?? 1,
    rate: l.rate ?? "",
    includedQty: l.includedQty ?? "",
    overageRate: l.overageRate ?? "",
    tracksTime: Boolean(l.tracksTime),
  }));
  return lines.length ? lines : [blankAgreementLine(true)];
}

function optionalNumber(v: unknown): number | null {
  if (v === "" || v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** API payload for the lines (every line sends tracksTime explicitly). */
export function agreementLinesPayload(lines: AgreementFormLine[]) {
  return lines.map((l) => ({
    ...(l.id ? { id: l.id } : {}),
    serviceId: l.serviceId,
    description: l.description,
    qty: optionalNumber(l.qty) ?? 0,
    rate: optionalNumber(l.rate),
    includedQty: l.tracksTime ? optionalNumber(l.includedQty) : null,
    overageRate: l.tracksTime ? optionalNumber(l.overageRate) : null,
    tracksTime: Boolean(l.tracksTime),
  }));
}
