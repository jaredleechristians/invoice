const { toIsoDate, addDaysIso, daysBetween } = require("./dates");
const { roundMoney } = require("./money");
const { httpError } = require("./errors");

const PERIOD_TYPES = new Set(["month", "quarter"]);

function roundHours(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function requireIso(value, field = "date") {
  const iso = toIsoDate(value);
  if (!iso) throw httpError(400, `A valid ${field} is required`);
  return iso;
}

function requirePeriodType(value) {
  const period = String(value || "month");
  if (!PERIOD_TYPES.has(period)) throw httpError(400, "Period must be month or quarter");
  return period;
}

/** Inclusive day count (15–31 Jan = 17). */
function daysInclusive(from, to) {
  const a = toIsoDate(from);
  const b = toIsoDate(to);
  if (!a || !b || b < a) return 0;
  return daysBetween(a, b) + 1;
}

function startOfCalendarMonth(iso) {
  const d = requireIso(iso);
  return `${d.slice(0, 7)}-01`;
}

function endOfCalendarMonth(iso) {
  const [y, m] = requireIso(iso).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m, 0));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function startOfCalendarQuarter(iso) {
  const [y, m] = requireIso(iso).split("-").map(Number);
  const startMonth = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${pad(startMonth)}-01`;
}

function endOfCalendarQuarter(iso) {
  const start = startOfCalendarQuarter(iso);
  const [y, m] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m + 2, 0));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

function fullCalendarPeriod(iso, periodType = "month") {
  const type = requirePeriodType(periodType);
  if (type === "quarter") {
    return { startsOn: startOfCalendarQuarter(iso), endsOn: endOfCalendarQuarter(iso), period: type };
  }
  return { startsOn: startOfCalendarMonth(iso), endsOn: endOfCalendarMonth(iso), period: type };
}

function nextFullPeriodStart(iso, periodType = "month") {
  const full = fullCalendarPeriod(iso, periodType);
  return addDaysIso(full.endsOn, 1);
}

/**
 * Clip a full calendar period to the agreement's start and optional end.
 * A mid-month start becomes a partial first period; a mid-month end a partial last.
 */
function clipPeriod(full, startDate, endDate) {
  const startsOn = startDate && startDate > full.startsOn ? startDate : full.startsOn;
  const endsOn = endDate && endDate < full.endsOn ? endDate : full.endsOn;
  if (endsOn < startsOn) return null;
  const daysInFullPeriod = daysInclusive(full.startsOn, full.endsOn);
  const daysInPeriod = daysInclusive(startsOn, endsOn);
  return {
    fullStartsOn: full.startsOn,
    fullEndsOn: full.endsOn,
    startsOn,
    endsOn,
    daysInPeriod,
    daysInFullPeriod,
    prorated: daysInPeriod !== daysInFullPeriod,
    period: full.period,
  };
}

function periodDocumentId(agreementId, fullStartsOn) {
  return `${agreementId}_${fullStartsOn}`;
}

function periodLabel(startsOn, endsOn) {
  const start = toIsoDate(startsOn);
  const end = toIsoDate(endsOn);
  if (!start || !end) return "";
  const fmt = (iso) => {
    const [y, m, d] = iso.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  };
  if (start === end) return fmt(start);
  return `${fmt(start)} – ${fmt(end)}`;
}

/**
 * Allowance and fee for a (possibly partial) period.
 * fraction = daysInPeriod / daysInFullCalendarPeriod
 * hoursAllowed is rounded to 2 decimal places; fee uses roundMoney.
 */
function prorateAmounts(hours, fee, daysInPeriod, daysInFullPeriod) {
  const includedHours = Math.max(0, Number(hours) || 0);
  const includedFee = Math.max(0, Number(fee) || 0);
  const fullDays = Number(daysInFullPeriod) || 0;
  const days = Number(daysInPeriod) || 0;
  if (fullDays <= 0 || days <= 0) {
    return { hoursAllowed: 0, fee: 0, prorated: true, fraction: 0 };
  }
  if (days === fullDays) {
    return { hoursAllowed: roundHours(includedHours), fee: roundMoney(includedFee), prorated: false, fraction: 1 };
  }
  const fraction = days / fullDays;
  return {
    hoursAllowed: roundHours(includedHours * fraction),
    fee: roundMoney(includedFee * fraction),
    prorated: true,
    fraction,
  };
}

function buildPeriodWindow(agreement, fullOrIso) {
  const periodType = requirePeriodType(agreement.period || "month");
  const full = typeof fullOrIso === "string" || !fullOrIso?.startsOn
    ? fullCalendarPeriod(fullOrIso?.startsOn || fullOrIso, periodType)
    : { ...fullOrIso, period: periodType };
  const startDate = requireIso(agreement.startDate, "startDate");
  const endDate = agreement.endDate ? requireIso(agreement.endDate, "endDate") : "";
  const clipped = clipPeriod(full, startDate, endDate);
  if (!clipped) return null;
  const amounts = prorateAmounts(agreement.hours, agreement.fee, clipped.daysInPeriod, clipped.daysInFullPeriod);
  return {
    ...clipped,
    hoursAllowed: amounts.hoursAllowed,
    fee: amounts.fee,
    fraction: amounts.fraction,
    currency: agreement.currency,
  };
}

function* iterateFullPeriods(startDate, endDate, periodType, { through } = {}) {
  const type = requirePeriodType(periodType);
  const start = requireIso(startDate, "startDate");
  const last = endDate ? requireIso(endDate, "endDate") : "";
  const cap = through ? requireIso(through) : last;
  if (!cap) throw httpError(400, "A through or end date is required to list periods");
  let cursor = fullCalendarPeriod(start, type).startsOn;
  const stopAt = fullCalendarPeriod(cap, type).startsOn;
  let guard = 0;
  while (cursor <= stopAt) {
    const full = fullCalendarPeriod(cursor, type);
    if (last && full.startsOn > last) break;
    yield full;
    cursor = nextFullPeriodStart(full.startsOn, type);
    if (++guard > 240) throw httpError(500, "Too many agreement periods");
  }
}

function listPeriodWindows(agreement, through) {
  const windows = [];
  for (const full of iterateFullPeriods(agreement.startDate, agreement.endDate, agreement.period || "month", { through })) {
    const window = buildPeriodWindow(agreement, full);
    if (window) windows.push(window);
  }
  return windows;
}

function periodCoveringDate(agreement, iso) {
  const date = requireIso(iso);
  if (date < agreement.startDate) return null;
  if (agreement.endDate && date > agreement.endDate) return null;
  return buildPeriodWindow(agreement, date);
}

/**
 * Close a period: remaining, expired, rolled-out and overage from used hours.
 * Rolled-in hours are never prorated. limitHours is a cap on hours rolled out;
 * blank / null means no cap.
 */
function closeHours({ hoursAllowed, hoursRolledIn = 0, hoursUsed = 0, rolloverPolicy } = {}) {
  const allowed = roundHours(hoursAllowed);
  const rolledIn = roundHours(hoursRolledIn);
  const used = roundHours(hoursUsed);
  const available = roundHours(allowed + rolledIn);
  const overage = roundHours(Math.max(0, used - available));
  const unused = roundHours(Math.max(0, available - used));
  const mode = rolloverPolicy?.mode === "rollover" ? "rollover" : "expire";
  let hoursRolledOut = 0;
  let hoursExpired = unused;
  if (mode === "rollover") {
    const rawLimit = rolloverPolicy?.limitHours;
    const cap = rawLimit === undefined || rawLimit === null || rawLimit === "" ? null : Number(rawLimit);
    if (cap != null && !Number.isFinite(cap)) throw httpError(400, "Rollover cap must be a number of hours");
    hoursRolledOut = cap == null ? unused : roundHours(Math.max(0, Math.min(unused, cap)));
    hoursExpired = roundHours(unused - hoursRolledOut);
  }
  return {
    hoursAllowed: allowed,
    hoursRolledIn: rolledIn,
    hoursUsed: used,
    hoursAvailable: available,
    hoursRemaining: unused,
    hoursOverage: overage,
    hoursExpired,
    hoursRolledOut,
    rolloverMode: mode,
  };
}

function hoursFromEntries(entries = []) {
  return roundHours(
    (entries || []).reduce((sum, e) => sum + (Number(e.hours) || (Number(e.minutes) || 0) / 60), 0)
  );
}

module.exports = {
  PERIOD_TYPES,
  roundHours,
  daysInclusive,
  startOfCalendarMonth,
  endOfCalendarMonth,
  startOfCalendarQuarter,
  endOfCalendarQuarter,
  fullCalendarPeriod,
  nextFullPeriodStart,
  clipPeriod,
  periodDocumentId,
  periodLabel,
  prorateAmounts,
  buildPeriodWindow,
  iterateFullPeriods,
  listPeriodWindows,
  periodCoveringDate,
  closeHours,
  hoursFromEntries,
  requireIso,
  requirePeriodType,
};
