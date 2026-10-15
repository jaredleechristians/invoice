const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { roundMoney } = require("./money");
const { invoiceStatus } = require("./status");
const { canWriteRecords } = require("./permissions");
const { logAudit } = require("./audit");
const { companyRef } = require("./companies");
const { getInvoice } = require("./invoices");

function paymentsCol(db, companyId) {
  return companyRef(db, companyId).collection("payments");
}

async function listPayments(companyId, { invoiceId } = {}) {
  const db = getDb();
  let query = paymentsCol(db, companyId).orderBy("paidAt", "desc");
  if (invoiceId) query = query.where("invoiceId", "==", invoiceId);
  const snap = await query.limit(500).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function recordPayment(companyId, uid, email, role, body) {
  if (!canWriteRecords(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const invoiceId = body.invoiceId;
  const amount = roundMoney(body.amount);
  if (!invoiceId || amount <= 0) {
    const err = new Error("invoiceId and positive amount are required");
    err.status = 400;
    throw err;
  }
  const db = getDb();
  const invoiceRef = companyRef(db, companyId).collection("invoices").doc(invoiceId);
  const paymentId = randomId();
  const paidAt = body.paidAt || new Date().toISOString();
  const note = String(body.note || "").trim();

  const result = await db.runTransaction(async (tx) => {
    const invSnap = await tx.get(invoiceRef);
    if (!invSnap.exists) {
      const err = new Error("Invoice not found");
      err.status = 404;
      throw err;
    }
    const invoice = invSnap.data();
    const paidAmount = roundMoney((invoice.paidAmount || 0) + amount);
    const computed = invoiceStatus({
      total: invoice.total,
      paidAmount,
      dueDate: invoice.dueDate,
    });
    tx.set(paymentsCol(db, companyId).doc(paymentId), {
      invoiceId,
      amount,
      paidAt,
      note,
      createdAt: new Date().toISOString(),
      createdBy: uid,
    });
    tx.set(
      invoiceRef,
      { paidAmount, status: computed.status, updatedAt: new Date().toISOString() },
      { merge: true }
    );
    return { paymentId, paidAmount, status: computed.status };
  });

  await logAudit({
    companyId,
    uid,
    email,
    action: "payment.record",
    payload: { invoiceId, paymentId: result.paymentId, amount },
  });

  const invoice = await getInvoice(companyId, invoiceId);
  return {
    payment: {
      id: result.paymentId,
      invoiceId,
      amount,
      paidAt,
      note,
    },
    invoice,
  };
}

module.exports = { listPayments, recordPayment };
