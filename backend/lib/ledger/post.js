// Transactional journal posting. Entries are immutable; corrections are
// reversals. The journal document id is the sourceKey (e.g. invoice:<id>:v1),
// and posting uses tx.create so a retried request cannot post twice.
const { getDb } = require("../firebase");
const { companyRef } = require("../refs");
const { httpError } = require("../errors");
const { planNumber } = require("../numbering");
const { todayIso } = require("../dates");
const { swapLines } = require("./rules");

function sourceKey(type, id, version) {
  return `${type}:${id}:v${version}`;
}

function reversalKey(key) {
  return `${key}:rev`;
}

function entryIdFor(key) {
  return String(key);
}

function nextVersion(ledger) {
  return (Number(ledger?.version) || 0) + 1;
}

function validateLines(lines) {
  if (!Array.isArray(lines) || !lines.length) throw httpError(400, "Journal has no lines");
  let debit = 0;
  let credit = 0;
  for (const l of lines) {
    if (!l.accountId) throw httpError(400, "Each journal line needs an account");
    const d = Number(l.debit) || 0;
    const c = Number(l.credit) || 0;
    if (d < 0 || c < 0) throw httpError(400, "Journal line amounts cannot be negative");
    if ((d > 0 && c > 0) || (d === 0 && c === 0)) {
      throw httpError(400, "Each journal line must have either a debit or a credit");
    }
    if (!Number.isInteger(d) || !Number.isInteger(c)) throw httpError(400, "Journal amounts must be integer cents");
    debit += d;
    credit += c;
  }
  if (debit !== credit) throw httpError(400, `Journal does not balance (${debit} vs ${credit} cents)`);
  return { debit, credit };
}

/**
 * Read-phase planner for a new entry. Call before any transaction writes, then
 * `commit(tx)` in the write phase. If the sourceKey already exists, the
 * existing entry is returned and commit is a no-op (idempotent).
 */
async function planPost(tx, companyId, {
  sourceKey: key,
  date,
  lines,
  kind = "auto",
  source,
  memo,
  createdBy,
  baseCurrency,
  reversesId = null,
}) {
  if (!key) throw httpError(400, "Journal sourceKey is required");
  const db = getDb();
  const cref = companyRef(db, companyId);
  const id = entryIdFor(key);
  const entryRef = cref.collection("journals").doc(id);
  const existing = await tx.get(entryRef);
  if (existing.exists) {
    return { id, entry: { id, ...existing.data() }, skipped: true, commit() {} };
  }

  const totals = validateLines(lines);
  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const snaps = await Promise.all(accountIds.map((aid) => tx.get(cref.collection("accounts").doc(aid))));
  for (const snap of snaps) {
    if (!snap.exists || snap.data().deletedAt) throw httpError(400, `Account ${snap.id} was not found`);
    const a = snap.data();
    if (a.active === false) throw httpError(400, `${a.name || snap.id} is archived and cannot be posted to`);
  }

  const plannedNumber = await planNumber(tx, companyId, "journals");
  const now = new Date().toISOString();
  const entry = {
    number: plannedNumber.number,
    date: date || todayIso(),
    kind,
    source: source || null,
    sourceKey: key,
    memo: memo || "",
    lines: lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      currency: l.currency,
      foreignAmount: l.foreignAmount,
      rate: l.rate,
      customerId: l.customerId || "",
      bankAccountId: l.bankAccountId || "",
      description: l.description || "",
    })),
    accountIds,
    baseCurrency: baseCurrency || "ZAR",
    totalCents: totals.debit,
    reversesId: reversesId || null,
    reversedById: null,
    createdAt: now,
    createdBy: createdBy || "",
  };
  return {
    id,
    entry: { id, ...entry },
    skipped: false,
    commit(writeTx) {
      plannedNumber.commit(writeTx);
      writeTx.create(entryRef, entry);
    },
  };
}

/**
 * Reverse an existing entry on `date`. If it is already reversed, returns the
 * existing reversal and commit is a no-op.
 */
async function planReverse(tx, companyId, { entryId, date, event = "delete", createdBy, memo }) {
  if (!entryId) return { id: null, entry: null, skipped: true, commit() {} };
  const db = getDb();
  const cref = companyRef(db, companyId);
  const origRef = cref.collection("journals").doc(entryId);
  const origSnap = await tx.get(origRef);
  if (!origSnap.exists) throw httpError(400, "Journal entry to reverse was not found");
  const orig = origSnap.data();
  if (orig.reversedById) {
    const existing = await tx.get(cref.collection("journals").doc(orig.reversedById));
    const entry = existing.exists ? { id: existing.id, ...existing.data() } : null;
    return { id: orig.reversedById, entry, skipped: true, commit() {} };
  }
  const key = reversalKey(orig.sourceKey || entryId);
  const planned = await planPost(tx, companyId, {
    sourceKey: key,
    date: date || orig.date,
    lines: swapLines(orig.lines),
    kind: "reversal",
    source: orig.source ? { ...orig.source, event, version: orig.source.version } : { type: "manual", event },
    memo: memo || `Reversal of ${orig.number}`,
    createdBy,
    baseCurrency: orig.baseCurrency,
    reversesId: entryId,
  });
  return {
    id: planned.id,
    entry: planned.entry,
    skipped: planned.skipped,
    commit(writeTx) {
      planned.commit(writeTx);
      if (!planned.skipped) writeTx.set(origRef, { reversedById: planned.id }, { merge: true });
    },
  };
}

/** Set company.ledger.goLiveDate once, on first post or catch-up (1.5.0 go-live). */
async function ensureGoLiveDate(companyId, date = todayIso()) {
  const db = getDb();
  const cref = companyRef(db, companyId);
  const snap = await cref.get();
  const ledger = snap.exists ? snap.data().ledger || {} : {};
  if (ledger.goLiveDate) return ledger.goLiveDate;
  await cref.set({ ledger: { ...ledger, goLiveDate: date } }, { merge: true });
  return date;
}

function systemAccountsOf(company) {
  return company?.ledger?.systemAccounts || {};
}

function baseCurrencyOf(company) {
  return company?.baseCurrency || "ZAR";
}

module.exports = {
  sourceKey,
  reversalKey,
  entryIdFor,
  nextVersion,
  planPost,
  planReverse,
  ensureGoLiveDate,
  systemAccountsOf,
  baseCurrencyOf,
};
