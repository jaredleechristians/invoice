const crypto = require("crypto");
const { roundMoney } = require("./money");
const { httpError } = require("./errors");

/**
 * Agreement lines: one or more billable services that make up the agreement value.
 *
 * line = {
 *   id, serviceId, description,
 *   qty,            // 0..n, decimals allowed
 *   rate,           // unit price
 *   includedQty,    // usage allowance per period (time-tracked line only; blank = qty)
 *   overageRate,    // rate for usage beyond includedQty (blank = line rate)
 *   tracksTime,     // time entries logged against the agreement count against this line
 * }
 *
 * Period value = sum(qty × rate). At most one line tracks time, because time entries
 * are linked to an agreement (not to a line).
 */

const MAX_LINES = 50;
const LEGACY_KEYS = ["serviceId", "hours", "fee", "rate", "overageRate"];

function roundQty(value) {
  return Math.round((Number(value) + Number.EPSILON) * 10000) / 10000;
}

function blank(v) {
  return v === undefined || v === null || v === "";
}

function lineId() {
  return crypto.randomBytes(6).toString("hex");
}

function lineTotal(line) {
  return roundMoney((Number(line?.qty) || 0) * (Number(line?.rate) || 0));
}

function periodValue(lines = []) {
  return roundMoney((lines || []).reduce((sum, l) => sum + lineTotal(l), 0));
}

function trackedLine(lines = []) {
  return (lines || []).find((l) => l && l.tracksTime) || null;
}

/** Included qty per full period for the time-tracked line (blank = its qty). */
function includedQtyOf(line) {
  if (!line) return 0;
  return roundQty(blank(line.includedQty) ? Number(line.qty) || 0 : Number(line.includedQty) || 0);
}

function overageRateOf(line) {
  if (!line) return 0;
  return roundMoney(blank(line.overageRate) ? Number(line.rate) || 0 : Number(line.overageRate) || 0);
}

function money(value, label, index) {
  const n = roundMoney(value);
  if (!Number.isFinite(n) || n < 0) throw httpError(400, `Line ${index + 1}: ${label} cannot be negative`);
  return n;
}

function quantity(value, label, index) {
  const n = roundQty(value);
  if (!Number.isFinite(n) || n < 0) throw httpError(400, `Line ${index + 1}: ${label} cannot be negative`);
  return n;
}

/** Validate one raw line. rate may stay null here and be filled from the service later. */
function normalizeLine(raw = {}, index = 0) {
  const serviceId = String(raw.serviceId || "").trim();
  if (!serviceId) throw httpError(400, `Line ${index + 1}: pick a billable service`);
  const qtyRaw = blank(raw.qty) ? 1 : raw.qty;
  return {
    id: String(raw.id || "").trim().slice(0, 40) || lineId(),
    serviceId,
    description: String(raw.description || "").trim().slice(0, 500),
    qty: quantity(qtyRaw, "qty", index),
    rate: blank(raw.rate) ? null : money(raw.rate, "rate", index),
    includedQty: blank(raw.includedQty) ? null : quantity(raw.includedQty, "included qty", index),
    overageRate: blank(raw.overageRate) ? null : money(raw.overageRate, "overage rate", index),
    tracksTime: Boolean(raw.tracksTime),
  };
}

/**
 * Convert the 1.9.x single-service shape (serviceId, hours, fee, rate, overageRate)
 * into one line: qty 1 at the period fee, with the included hours tracked and
 * overage falling back to the standard rate as before.
 */
function legacyToLines(src = {}) {
  const serviceId = String(src.serviceId || "").trim();
  if (!serviceId) return [];
  const hours = Number(src.hours) || 0;
  const fee = roundMoney(src.fee || 0);
  let standard = blank(src.rate) ? null : roundMoney(src.rate);
  if (standard == null) standard = hours > 0 ? roundMoney(fee / hours) : 0;
  const overage = blank(src.overageRate) ? standard : roundMoney(src.overageRate);
  return [
    {
      id: "legacy",
      serviceId,
      description: String(src.description || "").trim(),
      qty: 1,
      rate: fee,
      includedQty: roundQty(hours),
      overageRate: overage,
      tracksTime: true,
    },
  ];
}

/** Lines for a stored agreement; legacy (pre-1.10) agreements read as one line. */
function linesOf(agreement = {}) {
  if (Array.isArray(agreement.lines) && agreement.lines.length) return agreement.lines;
  return legacyToLines(agreement);
}

function hasLegacyKeys(body = {}) {
  return LEGACY_KEYS.some((k) => body[k] !== undefined);
}

/**
 * Lines for a create/update body.
 * - body.lines wins.
 * - otherwise a legacy payload (serviceId/hours/fee/...) becomes one line, merged over
 *   the existing agreement's legacy view on update.
 * - otherwise the existing lines are kept.
 */
function linesFromBody(body = {}, existing = {}) {
  let raw;
  let fromLegacy = false;
  if (body.lines !== undefined) {
    if (!Array.isArray(body.lines)) throw httpError(400, "Lines must be a list");
    raw = body.lines;
  } else if (hasLegacyKeys(body)) {
    const merged = { ...legacyView(existing), ...body };
    if (blank(merged.hours)) throw httpError(400, "Included hours are required");
    if (blank(merged.fee)) throw httpError(400, "Period fee is required");
    if (Number(merged.hours) < 0) throw httpError(400, "Included hours cannot be negative");
    if (Number(merged.fee) < 0) throw httpError(400, "Period fee cannot be negative");
    if (!blank(merged.rate) && Number(merged.rate) < 0) throw httpError(400, "Standard rate cannot be negative");
    if (!blank(merged.overageRate) && Number(merged.overageRate) < 0) throw httpError(400, "Overage rate cannot be negative");
    if (!String(merged.serviceId || "").trim()) throw httpError(400, "Pick a billable service");
    raw = legacyToLines(merged);
    fromLegacy = true;
  } else {
    raw = linesOf(existing);
  }
  if (!raw.length) throw httpError(400, "Add at least one line with a billable service");
  if (raw.length > MAX_LINES) throw httpError(400, `An agreement can have at most ${MAX_LINES} lines`);
  const lines = raw.map((l, i) => normalizeLine(l, i));
  const seen = new Set();
  for (const l of lines) {
    if (seen.has(l.id)) l.id = lineId();
    seen.add(l.id);
  }
  const flagged = lines.filter((l) => l.tracksTime);
  if (flagged.length > 1) throw httpError(400, "Only one line can count time entries");
  // No line says either way (e.g. an API caller): the first line is the hours line.
  if (!fromLegacy && !flagged.length && !raw.some((l) => l && l.tracksTime !== undefined)) {
    lines[0].tracksTime = true;
  }
  for (const l of lines) {
    if (!l.tracksTime) {
      l.includedQty = null;
      l.overageRate = null;
    }
  }
  return lines;
}

/**
 * Agreement-level fields derived from the lines. Periods (allowance and fee proration),
 * the hours report, time entries and older API readers keep using these.
 */
function derivedFields(lines = []) {
  const tracked = trackedLine(lines);
  return {
    serviceId: (tracked || lines[0] || {}).serviceId || "",
    hours: includedQtyOf(tracked),
    fee: periodValue(lines),
    rate: tracked ? roundMoney(tracked.rate || 0) : 0,
    overageRate: tracked && !blank(tracked.overageRate) ? roundMoney(tracked.overageRate) : null,
  };
}

/** Legacy view of any agreement, for readers that still expect serviceId/hours/fee. */
function legacyView(agreement = {}) {
  if (Array.isArray(agreement.lines) && agreement.lines.length) return { ...derivedFields(agreement.lines) };
  return {
    serviceId: agreement.serviceId,
    hours: agreement.hours,
    fee: agreement.fee,
    rate: agreement.rate,
    overageRate: agreement.overageRate,
  };
}

/**
 * Split a (possibly prorated) period fee across the lines.
 * Each line gets round(lineTotal × fraction); the rounding remainder goes on the
 * last non-zero line so the lines always add up to periodFee.
 */
function prorateLines(lines = [], periodFee, fraction = 1) {
  const f = Number(fraction);
  const full = !Number.isFinite(f) || f >= 1;
  const amounts = lines.map((l) => (full ? lineTotal(l) : roundMoney(lineTotal(l) * f)));
  const target = periodFee == null ? roundMoney(amounts.reduce((s, a) => s + a, 0)) : roundMoney(periodFee);
  const diff = roundMoney(target - amounts.reduce((s, a) => s + a, 0));
  if (diff !== 0) {
    let idx = -1;
    for (let i = amounts.length - 1; i >= 0; i--) if (amounts[i] > 0) { idx = i; break; }
    if (idx >= 0) amounts[idx] = roundMoney(amounts[idx] + diff);
  }
  return lines.map((line, i) => ({ line, amount: amounts[i] }));
}

module.exports = {
  MAX_LINES,
  roundQty,
  lineTotal,
  periodValue,
  trackedLine,
  includedQtyOf,
  overageRateOf,
  normalizeLine,
  legacyToLines,
  linesOf,
  linesFromBody,
  hasLegacyKeys,
  derivedFields,
  legacyView,
  prorateLines,
};
