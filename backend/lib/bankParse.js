// Bank statement parsing: OFX/QFX/QBO (SGML 1.x or XML 2.x) and generic CSV.
// Pure functions only (no Firestore) so they are easy to unit test.
const crypto = require("crypto");

const pad = (n) => String(n).padStart(2, "0");

function decodeEntities(s) {
  return String(s || "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .trim();
}

/**
 * Parse a bank amount string: "1,234.56", "-1 234,56", "(12.00)", "R 50.00",
 * "12.00 CR", "12.00 DR", "12.00-". Returns NaN when nothing numeric is found.
 */
function parseBankAmount(value) {
  if (typeof value === "number") return value;
  let s = String(value ?? "").trim();
  if (!s) return NaN;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\bDR\.?$/i.test(s) || /-$/.test(s)) { sign = -sign; s = s.replace(/\s*(DR\.?|-)$/i, ""); }
  s = s.replace(/\s*CR\.?$/i, "");
  if (/^\s*-/.test(s) || /^[^\d]*-/.test(s)) { sign = -sign; }
  s = s.replace(/[^\d.,]/g, "");
  if (!s) return NaN;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  if (lastComma > -1 && lastDot > -1) {
    // The later separator is the decimal one.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma > -1) {
    s = /,\d{1,2}$/.test(s) && (s.match(/,/g) || []).length === 1 ? s.replace(",", ".") : s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(sign * n * 100) / 100;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const monthNumber = (name) => MONTHS[String(name).toLowerCase().slice(0, 4)] || MONTHS[String(name).toLowerCase().slice(0, 3)] || 0;

function validIso(y, m, d) {
  y = Number(y); m = Number(m); d = Number(d);
  if (y < 100) y += 2000;
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return "";
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return "";
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * Parse a bank date to YYYY-MM-DD. `format` is "auto" | "dmy" | "mdy" | "ymd".
 * "auto" treats ambiguous slash dates as day-first (South African banks).
 */
function parseBankDate(value, format = "auto") {
  const s = String(value ?? "").trim();
  if (!s) return "";
  let m = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (m && !/^\d{4}[-/.]/.test(s)) return validIso(m[1], m[2], m[3]);
  m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return validIso(m[1], m[2], m[3]);
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{2,4})/.exec(s);
  if (m) {
    const mon = monthNumber(m[2]);
    if (mon) return validIso(m[3], mon, m[1]);
  }
  m = /^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/.exec(s);
  if (m && monthNumber(m[1])) return validIso(m[3], monthNumber(m[1]), m[2]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), m[3]];
    if (format === "ymd") return "";
    if (format === "mdy") return validIso(y, a, b);
    if (format === "dmy") return validIso(y, b, a);
    if (a > 12) return validIso(y, b, a);
    if (b > 12) return validIso(y, a, b);
    return validIso(y, b, a);
  }
  return "";
}

// ---------- OFX ----------

function looksLikeOfx(text) {
  return /<OFX>|OFXHEADER|<STMTTRN>/i.test(String(text || "").slice(0, 5000)) || /<STMTTRN>/i.test(String(text || ""));
}

function ofxField(block, tag) {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  return m ? decodeEntities(m[1]) : "";
}

/** Parse OFX/QFX/QBO text into { account, transactions }. */
function parseOfx(text) {
  const src = String(text || "");
  if (!looksLikeOfx(src)) throw Object.assign(new Error("This does not look like an OFX file"), { status: 400 });
  const transactions = [];
  const re = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>)/gi;
  let m;
  while ((m = re.exec(src))) {
    const block = m[1];
    const amount = parseBankAmount(ofxField(block, "TRNAMT"));
    const date = parseBankDate(ofxField(block, "DTPOSTED") || ofxField(block, "DTUSER"));
    if (!date || !Number.isFinite(amount)) continue;
    const name = ofxField(block, "NAME") || ofxField(block, "PAYEE");
    const memo = ofxField(block, "MEMO");
    const description = [name, memo && memo !== name ? memo : ""].filter(Boolean).join(" - ") || ofxField(block, "TRNTYPE");
    transactions.push({
      fitId: ofxField(block, "FITID"),
      date,
      amount,
      description: description.slice(0, 300),
      reference: (ofxField(block, "REFNUM") || ofxField(block, "CHECKNUM")).slice(0, 120),
      type: ofxField(block, "TRNTYPE"),
    });
  }
  const acctId = ofxField(src, "ACCTID");
  const ledger = /<LEDGERBAL>([\s\S]*?)(<\/LEDGERBAL>|<AVAILBAL>|$)/i.exec(src);
  return {
    format: "ofx",
    account: {
      bankId: ofxField(src, "BANKID"),
      accountLast4: acctId ? acctId.replace(/\s+/g, "").slice(-4) : "",
      currency: ofxField(src, "CURDEF").toUpperCase(),
      ledgerBalance: ledger ? parseBankAmount(ofxField(ledger[1], "BALAMT")) : null,
      ledgerDate: ledger ? parseBankDate(ofxField(ledger[1], "DTASOF")) : "",
    },
    transactions,
  };
}

// ---------- CSV ----------

function detectDelimiter(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim()).slice(0, 20);
  let best = ",";
  let bestScore = -1;
  for (const d of [",", ";", "\t", "|"]) {
    const counts = lines.map((l) => l.split(d).length - 1);
    const score = counts.filter((c) => c > 0).length * 10 + Math.min(...counts.concat([99]));
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF). Returns string[][]. */
function parseCsvRows(text, delimiter) {
  const src = String(text || "").replace(/^\uFEFF/, "");
  const d = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.trim() === "") { quoted = true; cell = ""; }
    else if (ch === d) { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

const HEADER_HINTS = {
  date: /^(transaction\s*)?date|^posting date|^value date|^datum/i,
  description: /description|narrative|details|transaction$|^payee|^beneficiary|^memo/i,
  amount: /^amount|^value$|^bedrag/i,
  debit: /debit|withdraw|money out|paid out/i,
  credit: /credit|deposit|money in|paid in/i,
  reference: /reference|^ref|cheque|check/i,
};

function headerRowIndex(rows) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const hits = rows[i].filter((c) => Object.values(HEADER_HINTS).some((re) => re.test(c))).length;
    const hasDate = rows[i].some((c) => HEADER_HINTS.date.test(c));
    if (hits >= 2 && hasDate) return i;
  }
  return -1;
}

/** Guess a column mapping from header names (indexes; -1 = not mapped). */
function guessMapping(rows) {
  const headerRow = headerRowIndex(rows);
  const headers = headerRow >= 0 ? rows[headerRow] : [];
  const find = (key, used) => headers.findIndex((h, i) => !used.includes(i) && HEADER_HINTS[key].test(h));
  const used = [];
  const pick = (key) => { const i = find(key, used); if (i >= 0) used.push(i); return i; };
  const date = pick("date");
  const amount = pick("amount");
  const debit = amount >= 0 ? -1 : pick("debit");
  const credit = amount >= 0 ? -1 : pick("credit");
  const reference = pick("reference");
  const description = pick("description");
  return {
    headerRow,
    date,
    description,
    amount,
    debit,
    credit,
    reference,
    dateFormat: "auto",
    // Some banks export money out as positive numbers in an "amount" column.
    invertAmount: false,
  };
}

function cleanMapping(mapping = {}, rows = []) {
  const guess = guessMapping(rows);
  const n = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));
  return {
    headerRow: n(mapping.headerRow, guess.headerRow),
    date: n(mapping.date, guess.date),
    description: n(mapping.description, guess.description),
    amount: n(mapping.amount, guess.amount),
    debit: n(mapping.debit, guess.debit),
    credit: n(mapping.credit, guess.credit),
    reference: n(mapping.reference, guess.reference),
    dateFormat: ["auto", "dmy", "mdy", "ymd"].includes(mapping.dateFormat) ? mapping.dateFormat : "auto",
    invertAmount: Boolean(mapping.invertAmount),
  };
}

/**
 * Turn CSV rows into transactions using a mapping. Rows that do not parse
 * (no date or no amount) are skipped and counted.
 */
function mapCsv(rows, mappingInput = {}) {
  const mapping = cleanMapping(mappingInput, rows);
  if (mapping.date < 0) throw Object.assign(new Error("Pick the date column"), { status: 400 });
  if (mapping.amount < 0 && mapping.debit < 0 && mapping.credit < 0) {
    throw Object.assign(new Error("Pick an amount column, or debit and credit columns"), { status: 400 });
  }
  const start = mapping.headerRow >= 0 ? mapping.headerRow + 1 : 0;
  const transactions = [];
  let skipped = 0;
  for (const row of rows.slice(start)) {
    const date = parseBankDate(row[mapping.date], mapping.dateFormat);
    let amount = NaN;
    if (mapping.amount >= 0) {
      amount = parseBankAmount(row[mapping.amount]);
      if (mapping.invertAmount && Number.isFinite(amount)) amount = -amount;
    } else {
      const debit = mapping.debit >= 0 ? parseBankAmount(row[mapping.debit]) : NaN;
      const credit = mapping.credit >= 0 ? parseBankAmount(row[mapping.credit]) : NaN;
      if (Number.isFinite(debit) && debit !== 0) amount = -Math.abs(debit);
      else if (Number.isFinite(credit) && credit !== 0) amount = Math.abs(credit);
      else if (Number.isFinite(debit) || Number.isFinite(credit)) amount = 0;
    }
    if (!date || !Number.isFinite(amount) || amount === 0) { skipped++; continue; }
    transactions.push({
      fitId: "",
      date,
      amount: Math.round(amount * 100) / 100,
      description: String(mapping.description >= 0 ? row[mapping.description] || "" : "").replace(/\s+/g, " ").trim().slice(0, 300),
      reference: String(mapping.reference >= 0 ? row[mapping.reference] || "" : "").trim().slice(0, 120),
      type: "",
    });
  }
  return { format: "csv", mapping, transactions, skipped };
}

// ---------- dedupe ----------

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/**
 * Stable per-account keys. OFX lines use FITID; others hash
 * account+date+amount+description plus a running index so identical rows in
 * one file stay distinct (and re-importing the same file yields the same keys).
 */
function dedupeKeys(accountId, transactions) {
  const seen = new Map();
  return transactions.map((t) => {
    if (t.fitId) return { ...t, dedupeKey: `fitid:${t.fitId}`, docId: sha(`${accountId}|fitid:${t.fitId}`).slice(0, 32) };
    const base = `${t.date}|${Number(t.amount).toFixed(2)}|${String(t.description || "").toLowerCase().replace(/\s+/g, " ").trim()}`;
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    const key = `hash:${sha(`${base}|${n}`).slice(0, 40)}`;
    return { ...t, dedupeKey: key, docId: sha(`${accountId}|${key}`).slice(0, 32) };
  });
}

/** Parse any supported file. CSV returns headers/rows for the mapping step. */
function parseStatement(text, { mapping } = {}) {
  if (looksLikeOfx(text)) return { ...parseOfx(text), headers: [], sample: [] };
  const rows = parseCsvRows(text);
  if (!rows.length) throw Object.assign(new Error("The file is empty"), { status: 400 });
  const out = mapCsv(rows, mapping);
  const hr = out.mapping.headerRow;
  const width = Math.max(...rows.slice(0, 30).map((r) => r.length));
  const headers = hr >= 0 ? rows[hr] : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  return { ...out, headers, sample: rows.slice(hr >= 0 ? hr + 1 : 0, (hr >= 0 ? hr + 1 : 0) + 5), account: null };
}

module.exports = {
  parseBankAmount,
  parseBankDate,
  parseOfx,
  parseCsvRows,
  detectDelimiter,
  guessMapping,
  mapCsv,
  dedupeKeys,
  parseStatement,
  looksLikeOfx,
};
