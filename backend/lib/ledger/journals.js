// Journal queries and the minimal trial-balance endpoint (Phase 1).
// Manual journals and opening balances are 1.6.0.
const { getDb } = require("../firebase");
const { companyRef } = require("../refs");
const { httpError } = require("../errors");
const { fetchAll } = require("../db");
const { toIsoDate } = require("../dates");
const { ensureChart, listLedgerAccounts } = require("./accounts");

const journalsCol = (companyId) => companyRef(getDb(), companyId).collection("journals");

function decorate(entry) {
  return {
    ...entry,
    reversed: Boolean(entry.reversedById),
  };
}

async function listJournals(companyId, { accountId, from, to, sourceType, sourceId, invoiceId } = {}) {
  await ensureChart(companyId);
  let rows = (await fetchAll(journalsCol(companyId))).map(decorate);
  if (accountId) rows = rows.filter((e) => (e.accountIds || []).includes(accountId));
  if (from) rows = rows.filter((e) => e.date >= from);
  if (to) rows = rows.filter((e) => e.date <= to);
  if (sourceType) rows = rows.filter((e) => e.source?.type === sourceType);
  if (sourceId) rows = rows.filter((e) => e.source?.id === sourceId);
  if (invoiceId) {
    const paySnap = await companyRef(getDb(), companyId).collection("payments").where("invoiceId", "==", invoiceId).get();
    const paymentIds = new Set(paySnap.docs.map((d) => d.id));
    rows = rows.filter(
      (e) =>
        (e.source?.type === "invoice" && e.source?.id === invoiceId) ||
        (e.source?.type === "payment" && paymentIds.has(e.source?.id))
    );
  }
  rows.sort(
    (a, b) =>
      String(a.date).localeCompare(String(b.date)) ||
      String(a.number || "").localeCompare(String(b.number || "")) ||
      String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
  );
  return rows;
}

async function getJournal(companyId, entryId) {
  const snap = await journalsCol(companyId).doc(String(entryId || "")).get();
  if (!snap.exists) throw httpError(404, "Journal entry not found");
  return decorate({ id: snap.id, ...snap.data() });
}

/**
 * Minimal trial balance as at `asOf` (inclusive). Nets each account to the
 * debit or credit column. Totals must match.
 */
async function trialBalance(companyId, { asOf } = {}) {
  await ensureChart(companyId);
  const asOfDate = toIsoDate(asOf) || asOf || "9999-12-31";
  const [accounts, entries] = await Promise.all([
    listLedgerAccounts(companyId, { includeArchived: true }),
    listJournals(companyId, { to: asOfDate }),
  ]);
  const byId = new Map(accounts.map((a) => [a.id, { ...a, debit: 0, credit: 0 }]));
  for (const entry of entries) {
    for (const line of entry.lines || []) {
      const row = byId.get(line.accountId);
      if (!row) continue;
      row.debit += Number(line.debit) || 0;
      row.credit += Number(line.credit) || 0;
    }
  }
  const rows = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const a of accounts) {
    const row = byId.get(a.id);
    const net = (row.debit || 0) - (row.credit || 0);
    if (!net && !row.debit && !row.credit) continue;
    const debit = net > 0 ? net : 0;
    const credit = net < 0 ? -net : 0;
    totalDebit += debit;
    totalCredit += credit;
    rows.push({
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      debit,
      credit,
      balance: net,
    });
  }
  const companySnap = await companyRef(getDb(), companyId).get();
  return {
    asOf: toIsoDate(asOf) || null,
    baseCurrency: companySnap.data()?.baseCurrency || "ZAR",
    accounts: rows,
    totals: { debit: totalDebit, credit: totalCredit },
  };
}

module.exports = { listJournals, getJournal, trialBalance };
