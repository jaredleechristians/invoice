// Journal queries, manual journals, opening balances, and the minimal trial-balance endpoint.
const { getDb } = require("../firebase");
const { companyRef } = require("../refs");
const { httpError } = require("../errors");
const { fetchAll } = require("../db");
const { toIsoDate, todayIso } = require("../dates");
const { randomId } = require("../ids");
const { canManageSettings, assertCan } = require("../permissions");
const { logAudit } = require("../audit");
const { ensureChart, listLedgerAccounts } = require("./accounts");
const { planPost, planReverse, sourceKey, nextVersion, ensureGoLiveDate, systemAccountsOf, baseCurrencyOf } = require("./post");
const { openingBalanceLines, toCents } = require("./rules");
const { planBankEntry } = require("./bankPost");

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
  if (sourceType) {
    const related = sourceType === "payment" ? "payment_bank" : sourceType === "expense" ? "expense_bank" : null;
    rows = rows.filter((e) => e.source?.type === sourceType || (related && e.source?.type === related));
  }
  if (sourceId) rows = rows.filter((e) => e.source?.id === sourceId);
  if (invoiceId) {
    const paySnap = await companyRef(getDb(), companyId).collection("payments").where("invoiceId", "==", invoiceId).get();
    const paymentIds = new Set(paySnap.docs.map((d) => d.id));
    rows = rows.filter(
      (e) =>
        (e.source?.type === "invoice" && e.source?.id === invoiceId) ||
        (e.source?.type === "payment" && paymentIds.has(e.source?.id)) ||
        (e.source?.type === "payment_bank" && paymentIds.has(e.source?.id))
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


const MANUAL_BLOCKED = new Set(["debtors", "creditors", "undeposited_funds", "expense_clearing", "transfers_in_transit"]);
const OPENING_BLOCKED = new Set(["debtors", "creditors", "undeposited_funds", "expense_clearing", "transfers_in_transit", "opening_balance_equity"]);

async function loadCompany(companyId) {
  const snap = await companyRef(getDb(), companyId).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : {};
}

function moneyToCents(value, label) {
  if (value == null || value === "") return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw httpError(400, `${label} must be a non-negative amount`);
  return toCents(n);
}

async function createManualJournal(companyId, uid, email, role, body = {}) {
  assertCan(canManageSettings, role);
  await ensureChart(companyId);
  const company = await loadCompany(companyId);
  const baseCurrency = baseCurrencyOf(company);
  const date = toIsoDate(body.date) || todayIso();
  const input = Array.isArray(body.lines) ? body.lines : [];
  if (input.length < 2) throw httpError(400, "A journal needs at least two lines");
  const accounts = await listLedgerAccounts(companyId, { includeArchived: true });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  let warning = "";
  const lines = input.map((l, i) => {
    const account = byId.get(l.accountId);
    if (!account || account.deletedAt) throw httpError(400, `Line ${i + 1}: account was not found`);
    if (account.active === false) throw httpError(400, `${account.name} is archived and cannot be posted to`);
    if (MANUAL_BLOCKED.has(account.systemKey)) {
      throw httpError(400, `${account.name} is a control account. Post through invoices, payments, expenses or transfers instead.`);
    }
    if (account.bankAccountId || account.subtype === "bank") {
      warning = "This journal posts to a bank account. If that line is later imported, reconciliation will be off.";
    }
    const debit = moneyToCents(l.debit, "Debit");
    const credit = moneyToCents(l.credit, "Credit");
    if ((debit > 0 && credit > 0) || (debit === 0 && credit === 0)) {
      throw httpError(400, `Line ${i + 1} must have either a debit or a credit`);
    }
    return {
      accountId: account.id,
      debit,
      credit,
      currency: baseCurrency,
      foreignAmount: debit - credit,
      rate: 1,
      description: String(l.description || "").trim().slice(0, 200),
    };
  });
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  if (debit !== credit) throw httpError(400, `Journal does not balance (${(debit / 100).toFixed(2)} vs ${(credit / 100).toFixed(2)} ${baseCurrency})`);

  const id = randomId();
  const db = getDb();
  let entry;
  await db.runTransaction(async (tx) => {
    const planned = await planPost(tx, companyId, {
      sourceKey: sourceKey("manual", id, 1),
      date,
      lines,
      kind: "manual",
      source: { type: "manual", id, number: "", event: "post", version: 1 },
      memo: String(body.memo || "").trim().slice(0, 300),
      createdBy: uid,
      baseCurrency,
    });
    planned.commit(tx);
    entry = planned.entry;
  });
  await ensureGoLiveDate(companyId, date);
  await logAudit({ companyId, uid, email, action: "journal.create", payload: { entryId: entry.id, number: entry.number, date } });
  const out = decorate(entry);
  if (warning) out.warning = warning;
  return out;
}

async function reverseManualJournal(companyId, uid, email, role, entryId, body = {}) {
  assertCan(canManageSettings, role);
  const existing = await getJournal(companyId, entryId);
  if (existing.kind === "reversal") throw httpError(409, "A reversal cannot be reversed. Post a new journal instead.");
  if (existing.reversedById) {
    return decorate(await getJournal(companyId, existing.reversedById));
  }
  const date = toIsoDate(body.date) || todayIso();
  const db = getDb();
  let entry;
  await db.runTransaction(async (tx) => {
    const planned = await planReverse(tx, companyId, {
      entryId: existing.id,
      date,
      event: "undo",
      createdBy: uid,
      memo: body.memo || `Reversal of ${existing.number}`,
    });
    planned.commit(tx);
    entry = planned.entry;
  });
  await logAudit({ companyId, uid, email, action: "journal.reverse", payload: { entryId: existing.id, reversalId: entry.id } });
  return decorate(entry);
}

function openingBlocked(account) {
  if (OPENING_BLOCKED.has(account.systemKey)) return account.name;
  if (account.bankAccountId || account.subtype === "bank") return `${account.name} (set the opening on the bank account in Settings)`;
  if (account.type === "income" || account.type === "expense") return `${account.name} (opening balances are for balance-sheet accounts)`;
  return null;
}

async function getOpeningBalances(companyId) {
  await ensureChart(companyId);
  const company = await loadCompany(companyId);
  const rows = (await listJournals(companyId, { sourceType: "opening" })).filter((e) => e.kind === "opening" && !e.reversesId);
  const current = rows.sort((a, b) => (b.source?.version || 0) - (a.source?.version || 0) || String(b.date).localeCompare(String(a.date)))[0] || null;
  return {
    goLiveDate: company.ledger?.goLiveDate || null,
    baseCurrency: baseCurrencyOf(company),
    entry: current && !current.reversedById ? current : current && current.reversedById ? null : current,
    latest: current,
  };
}

async function setOpeningBalances(companyId, uid, email, role, body = {}) {
  assertCan(canManageSettings, role);
  await ensureChart(companyId);
  const company = await loadCompany(companyId);
  const ctx = { baseCurrency: baseCurrencyOf(company), systemAccounts: systemAccountsOf(company) };
  const date = toIsoDate(body.date) || company.ledger?.goLiveDate || todayIso();
  const accounts = await listLedgerAccounts(companyId, { includeArchived: true });
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const items = (Array.isArray(body.lines) ? body.lines : []).map((l, i) => {
    const account = byId.get(l.accountId);
    if (!account) throw httpError(400, `Line ${i + 1}: account was not found`);
    if (account.active === false) throw httpError(400, `${account.name} is archived and cannot be posted to`);
    const blocked = openingBlocked(account);
    if (blocked) throw httpError(400, `Cannot set an opening balance on ${blocked}`);
    return {
      accountId: account.id,
      debit: moneyToCents(l.debit, "Debit"),
      credit: moneyToCents(l.credit, "Credit"),
      description: String(l.description || account.name).trim().slice(0, 200),
    };
  }).filter((l) => l.debit || l.credit);
  const lines = openingBalanceLines(items, ctx);
  const existing = (await listJournals(companyId, { sourceType: "opening" }))
    .filter((e) => e.kind === "opening" && !e.reversesId)
    .sort((a, b) => (b.source?.version || 0) - (a.source?.version || 0))[0];
  const currentLedger = existing && !existing.reversedById
    ? { entryId: existing.id, version: existing.source?.version || 1 }
    : existing
      ? { entryId: null, version: existing.source?.version || 1 }
      : null;
  if (!lines.length && !currentLedger?.entryId) {
    return { entry: null, goLiveDate: date, baseCurrency: ctx.baseCurrency };
  }

  const db = getDb();
  let entry = null;
  await db.runTransaction(async (tx) => {
    let reverse = { commit() {} };
    if (currentLedger?.entryId) {
      reverse = await planReverse(tx, companyId, {
        entryId: currentLedger.entryId,
        date: existing.date,
        event: "edit",
        createdBy: uid,
      });
    }
    let post = { commit() {}, entry: null };
    if (lines.length) {
      post = await planBankEntry(tx, companyId, {
        type: "opening",
        id: "company",
        date,
        lines,
        event: currentLedger?.entryId ? "edit" : "post",
        createdBy: uid,
        memo: "Opening balances",
        currentLedger,
        ctx,
        kind: "opening",
      });
    }
    reverse.commit(tx);
    post.commit(tx);
    entry = post.entry || null;
  });
  await ensureGoLiveDate(companyId, date);
  await logAudit({ companyId, uid, email, action: "ledger.openingBalances", payload: { entryId: entry?.id || null, date, lines: items.length } });
  return { entry: entry ? decorate(entry) : null, goLiveDate: date, baseCurrency: ctx.baseCurrency };
}

module.exports = {
  listJournals,
  getJournal,
  trialBalance,
  createManualJournal,
  reverseManualJournal,
  getOpeningBalances,
  setOpeningBalances,
};
