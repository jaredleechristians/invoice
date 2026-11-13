const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})/;

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Normalise "2026-11-01", ISO datetimes or "27 Jul 2026" to YYYY-MM-DD ('' if unknown). */
function toIsoDate(value) {
  if (!value) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const raw = String(value).trim();
  const m = ISO_RE.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/on receipt/i.test(raw)) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return "";
  return toIsoDate(parsed);
}

function todayIso(now = new Date()) {
  return toIsoDate(now);
}

/** Civil date in a named zone (default Africa/Johannesburg). */
function todayIsoInZone(timeZone = "Africa/Johannesburg", now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function addDaysIso(iso, days) {
  const base = toIsoDate(iso);
  if (!base) return "";
  const [y, m, d] = base.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + Number(days || 0)));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Whole days from a to b (b - a) for YYYY-MM-DD strings. */
function daysBetween(a, b) {
  const pa = toIsoDate(a);
  const pb = toIsoDate(b);
  if (!pa || !pb) return 0;
  const ta = Date.UTC(...pa.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  const tb = Date.UTC(...pb.split("-").map((v, i) => (i === 1 ? Number(v) - 1 : Number(v))));
  return Math.round((tb - ta) / 86400000);
}

function monthKey(iso) {
  const d = toIsoDate(iso);
  return d ? d.slice(0, 7) : "";
}

function startOfMonthIso(now = new Date()) {
  return `${todayIso(now).slice(0, 7)}-01`;
}

function endOfMonthIso(now = new Date()) {
  const start = startOfMonthIso(now);
  const [y, m] = start.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m, 0));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Inclusive range check on YYYY-MM-DD strings; empty bounds are open. */
function inRange(iso, from, to) {
  const d = toIsoDate(iso);
  if (!d) return false;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

module.exports = {
  toIsoDate,
  todayIso,
  todayIsoInZone,
  addDaysIso,
  daysBetween,
  monthKey,
  startOfMonthIso,
  endOfMonthIso,
  inRange,
};
