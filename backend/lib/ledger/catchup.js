// Idempotent catch-up for documents published before 1.5.0 posting went live.
// Not a backfill: production is empty; this only posts live documents that
// have no ledger.entryId. Foreign invoices without a rate are listed, not posted.
const { getDb } = require("../firebase");
const { companyRef } = require("../refs");
const { fetchAll } = require("../db");
const { canManageSettings, assertCan } = require("../permissions");
const { logAudit } = require("../audit");
const { todayIso } = require("../dates");
const { ensureChart } = require("./accounts");
const { invoiceLines, paymentLines, expenseLines, documentRate } = require("./rules");
const { planPost, sourceKey, ensureGoLiveDate, systemAccountsOf, baseCurrencyOf } = require("./post");

async function postOne(companyId, { key, date, lines, source, memo, createdBy, baseCurrency }) {
  if (!lines.length) return { skipped: true };
  const db = getDb();
  return db.runTransaction(async (tx) => {
    const planned = await planPost(tx, companyId, {
      sourceKey: key,
      date,
      lines,
      kind: "auto",
      source,
      memo,
      createdBy,
      baseCurrency,
    });
    planned.commit(tx);
    return planned;
  });
}

async function catchUpCompany(companyId, uid, email, role) {
  assertCan(canManageSettings, role);
  await ensureChart(companyId);
  const goLiveDate = await ensureGoLiveDate(companyId);
  const db = getDb();
  const cref = companyRef(db, companyId);
  const companySnap = await cref.get();
  const company = companySnap.exists ? companySnap.data() : {};
  const systemAccounts = systemAccountsOf(company);
  const baseCurrency = baseCurrencyOf(company);
  const ctx = { systemAccounts, baseCurrency };

  const posted = [];
  const skipped = [];
  const needsRate = [];

  const invoices = await fetchAll(cref.collection("invoices"));
  for (const inv of invoices) {
    if (inv.draft || inv.voided || inv.ledger?.entryId) {
      skipped.push({ type: "invoice", id: inv.id, reason: inv.ledger?.entryId ? "already-posted" : "not-live" });
      continue;
    }
    try {
      documentRate(inv, baseCurrency);
    } catch {
      needsRate.push({ type: "invoice", id: inv.id, number: inv.invoiceNumber, currency: inv.currency });
      continue;
    }
    const lines = invoiceLines(inv, ctx);
    const version = 1;
    const planned = await postOne(companyId, {
      key: sourceKey("invoice", inv.id, version),
      date: inv.issueDate,
      lines,
      source: { type: "invoice", id: inv.id, number: inv.invoiceNumber || "", event: "post", version },
      memo: `${inv.invoiceNumber || "Invoice"} ${inv.customerName || ""}`.trim(),
      createdBy: uid,
      baseCurrency,
    });
    if (!planned.skipped) {
      await cref.collection("invoices").doc(inv.id).set({ ledger: { entryId: planned.id, version } }, { merge: true });
      posted.push({ type: "invoice", id: inv.id, entryId: planned.id });
    }
  }

  const payments = await fetchAll(cref.collection("payments"));
  for (const pay of payments) {
    if (pay.voided || pay.ledger?.entryId) {
      skipped.push({ type: "payment", id: pay.id, reason: pay.ledger?.entryId ? "already-posted" : "not-live" });
      continue;
    }
    const invSnap = await cref.collection("invoices").doc(pay.invoiceId).get();
    if (!invSnap.exists) {
      skipped.push({ type: "payment", id: pay.id, reason: "invoice-missing" });
      continue;
    }
    const inv = { id: invSnap.id, ...invSnap.data() };
    const lines = paymentLines(pay, inv, ctx);
    const version = 1;
    const planned = await postOne(companyId, {
      key: sourceKey("payment", pay.id, version),
      date: pay.paidAt,
      lines,
      source: { type: "payment", id: pay.id, number: pay.invoiceNumber || "", event: "post", version },
      memo: `Payment ${inv.invoiceNumber || ""}`.trim(),
      createdBy: uid,
      baseCurrency,
    });
    if (!planned.skipped) {
      await cref.collection("payments").doc(pay.id).set({ ledger: { entryId: planned.id, version } }, { merge: true });
      posted.push({ type: "payment", id: pay.id, entryId: planned.id });
    }
  }

  const expenses = await fetchAll(cref.collection("expenses"));
  for (const exp of expenses) {
    if (exp.ledger?.entryId) {
      skipped.push({ type: "expense", id: exp.id, reason: "already-posted" });
      continue;
    }
    try {
      documentRate(exp, baseCurrency);
    } catch {
      needsRate.push({ type: "expense", id: exp.id, vendor: exp.vendor, currency: exp.currency });
      continue;
    }
    const lines = expenseLines(exp, ctx);
    const version = 1;
    const planned = await postOne(companyId, {
      key: sourceKey("expense", exp.id, version),
      date: exp.date,
      lines,
      source: { type: "expense", id: exp.id, number: exp.vendor || "", event: "post", version },
      memo: exp.vendor || "Expense",
      createdBy: uid,
      baseCurrency,
    });
    if (!planned.skipped) {
      await cref.collection("expenses").doc(exp.id).set({ ledger: { entryId: planned.id, version } }, { merge: true });
      posted.push({ type: "expense", id: exp.id, entryId: planned.id });
    }
  }

  await logAudit({
    companyId,
    uid,
    email,
    action: "ledger.catchup",
    payload: { posted: posted.length, needsRate: needsRate.length, goLiveDate },
  });
  return { goLiveDate: goLiveDate || todayIso(), posted, skipped, needsRate };
}

module.exports = { catchUpCompany };
