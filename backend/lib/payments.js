const { deletion } = require("./softDelete");
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { roundMoney } = require("./money");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { canWriteRecords, canDeleteRecords, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { getInvoice, withComputed } = require("./invoices");
const { fetchAll } = require("./db");
const { toIsoDate, todayIso } = require("./dates");
const { releaseTransaction, PAYMENT_LINK_CLEAR } = require("./bankLinks");

const PAYMENT_METHODS = ["bank_transfer", "cash", "card", "paypal", "wise", "paystack", "other"];

function paymentsCol(db, companyId) {
  return companyRef(db, companyId).collection("payments");
}

/** Sum of non-void payment amounts. Exported for tests. */
function sumPayments(payments) {
  return roundMoney((payments || []).filter((p) => !p.voided && !p.deletedAt).reduce((s, p) => s + roundMoney(p.amount), 0));
}

function normalizePayment(p) {
  return { ...p, paidAtIso: toIsoDate(p.paidAt), currency: p.currency || "ZAR", method: p.method || "other" };
}

async function listPayments(companyId, { invoiceId, includeVoided = true } = {}) {
  const db = getDb();
  let query = paymentsCol(db, companyId);
  if (invoiceId) query = query.where("invoiceId", "==", invoiceId);
  let rows = (await fetchAll(query)).map(normalizePayment);
  if (!includeVoided) rows = rows.filter((p) => !p.voided);
  return rows.sort((a, b) => String(b.paidAtIso).localeCompare(String(a.paidAtIso)) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Re-derive invoice.paidAmount from its payments inside a transaction, applying
 * `change` (a payment being added/voided/removed) to the set read from Firestore.
 */
async function applyPaymentChange(db, companyId, invoiceId, change) {
  const invoiceRef = companyRef(db, companyId).collection("invoices").doc(invoiceId);
  return db.runTransaction(async (tx) => {
    const invSnap = await tx.get(invoiceRef);
    if (!invSnap.exists) throw httpError(404, "Invoice not found");
    const invoice = invSnap.data();
    const paySnap = await tx.get(paymentsCol(db, companyId).where("invoiceId", "==", invoiceId));
    let payments = paySnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const result = change({ invoice, payments, tx });
    payments = result.payments;
    const paidAmount = sumPayments(payments);
    const computed = withComputed({ ...invoice, paidAmount });
    tx.set(invoiceRef, { paidAmount, status: computed.status, updatedAt: new Date().toISOString() }, { merge: true });
    return { ...result, paidAmount, status: computed.status };
  });
}

function validatePaymentInput(body) {
  const amount = roundMoney(body.amount);
  if (!body.invoiceId || !(amount > 0)) throw httpError(400, "invoiceId and a positive amount are required");
  const method = PAYMENT_METHODS.includes(body.method) ? body.method : "bank_transfer";
  const paidAt = toIsoDate(body.paidAt) || todayIso();
  return {
    invoiceId: String(body.invoiceId),
    amount,
    paidAt,
    method,
    reference: String(body.reference || "").trim().slice(0, 120),
    note: String(body.note || "").trim().slice(0, 500),
  };
}

/** `extra` lets internal callers (bank reconcile) add link/forex fields. */
async function recordPayment(companyId, uid, email, role, body = {}, extra = {}) {
  assertCan(canWriteRecords, role);
  const input = validatePaymentInput(body);
  const db = getDb();
  const paymentId = randomId();
  const now = new Date().toISOString();

  const result = await applyPaymentChange(db, companyId, input.invoiceId, ({ invoice, payments, tx }) => {
    if (invoice.voided) throw httpError(409, "Cannot record payments on a void invoice");
    if (invoice.draft) throw httpError(409, "Publish the invoice before recording payments");
    const outstanding = roundMoney(roundMoney(invoice.total) - sumPayments(payments));
    if (input.amount > outstanding + 0.001) {
      throw httpError(400, `Payment exceeds the outstanding balance (${outstanding.toFixed(2)} ${invoice.currency || "ZAR"})`);
    }
    const doc = {
      ...input,
      currency: invoice.currency || "ZAR",
      invoiceNumber: invoice.invoiceNumber || "",
      customerId: invoice.customerId || "",
      customerName: invoice.customerName || "",
      voided: false,
      ...extra,
      createdAt: now,
      createdBy: uid,
    };
    tx.set(paymentsCol(db, companyId).doc(paymentId), doc);
    return { payment: { id: paymentId, ...doc }, payments: [...payments, doc] };
  });

  await logAudit({
    companyId,
    uid,
    email,
    action: "payment.record",
    payload: { invoiceId: input.invoiceId, paymentId, amount: input.amount, currency: result.payment.currency },
  });
  return { payment: normalizePayment(result.payment), invoice: await getInvoice(companyId, input.invoiceId) };
}

async function loadPayment(db, companyId, paymentId) {
  const snap = await paymentsCol(db, companyId).doc(paymentId).get();
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Payment not found");
  return { id: snap.id, ...snap.data() };
}

async function voidPayment(companyId, uid, email, role, paymentId, { reason = "" } = {}) {
  assertCan(canWriteRecords, role);
  const db = getDb();
  const payment = await loadPayment(db, companyId, paymentId);
  if (payment.voided) throw httpError(409, "Payment is already void");
  const now = new Date().toISOString();
  const patch = { voided: true, voidedAt: now, voidedBy: uid, voidReason: String(reason || "").slice(0, 500) };
  await applyPaymentChange(db, companyId, payment.invoiceId, ({ payments, tx }) => {
    tx.set(paymentsCol(db, companyId).doc(paymentId), patch, { merge: true });
    return { payments: payments.map((p) => (p.id === paymentId ? { ...p, ...patch } : p)) };
  });
  if (payment.transactionId) await releaseTransaction(companyId, payment.transactionId);
  await logAudit({ companyId, uid, email, action: "payment.void", payload: { paymentId, invoiceId: payment.invoiceId, amount: payment.amount } });
  return { payment: normalizePayment({ ...payment, ...patch }), invoice: await getInvoice(companyId, payment.invoiceId) };
}

async function deletePayment(companyId, uid, email, role, paymentId) {
  assertCan(canDeleteRecords, role);
  const db = getDb();
  const payment = await loadPayment(db, companyId, paymentId);
  // Unlink from the bank line (released below), so a restore starts clean.
  const gone = { ...deletion(uid), ...(payment.transactionId ? PAYMENT_LINK_CLEAR : {}) };
  const invSnap = await companyRef(db, companyId).collection("invoices").doc(payment.invoiceId).get();
  if (invSnap.exists) {
    await applyPaymentChange(db, companyId, payment.invoiceId, ({ payments, tx }) => {
      tx.set(paymentsCol(db, companyId).doc(paymentId), gone, { merge: true });
      return { payments: payments.map((p) => (p.id === paymentId ? { ...p, ...gone } : p)) };
    });
  } else {
    await paymentsCol(db, companyId).doc(paymentId).set(gone, { merge: true });
  }
  if (payment.transactionId) await releaseTransaction(companyId, payment.transactionId);
  await logAudit({ companyId, uid, email, action: "payment.delete", payload: { paymentId, invoiceId: payment.invoiceId, amount: payment.amount } });
  return { invoice: invSnap.exists ? await getInvoice(companyId, payment.invoiceId) : null };
}

module.exports = { PAYMENT_METHODS, listPayments, recordPayment, voidPayment, deletePayment, sumPayments, applyPaymentChange };
