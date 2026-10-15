const { getDb } = require("./firebase");
const { randomId, formatInvoiceNumber } = require("./ids");
const { invoiceTotal } = require("./money");
const { invoiceStatus } = require("./status");
const { canDeleteRecords, canWriteRecords } = require("./permissions");
const { logAudit } = require("./audit");
const { companyRef } = require("./companies");
const { getCustomer } = require("./customers");

function invoicesCol(db, companyId) {
  return companyRef(db, companyId).collection("invoices");
}

function withComputed(invoice) {
  const total = invoice.total ?? invoiceTotal(invoice.items || []);
  const paidAmount = invoice.paidAmount ?? 0;
  const computed = invoiceStatus({ total, paidAmount, dueDate: invoice.dueDate });
  return { ...invoice, total, ...computed };
}

async function allocateInvoiceNumber(companyId) {
  const db = getDb();
  const counterRef = companyRef(db, companyId).collection("counters").doc("invoices");
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const data = snap.exists ? snap.data() : { next: 1, prefix: "INV-" };
    const next = Number(data.next) || 1;
    const prefix = data.prefix || "INV-";
    const invoiceNumber = formatInvoiceNumber(prefix, next);
    tx.set(counterRef, { next: next + 1, prefix }, { merge: true });
    return invoiceNumber;
  });
}

async function listInvoices(companyId, { q, status, customerId, limit = 100 } = {}) {
  const db = getDb();
  let query = invoicesCol(db, companyId).orderBy("issueDate", "desc");
  if (customerId) query = query.where("customerId", "==", customerId);
  const snap = await query.limit(Math.min(limit, 500)).get();
  let rows = snap.docs.map((d) => withComputed({ id: d.id, ...d.data() }));
  if (status) rows = rows.filter((r) => r.status === status);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (r) =>
        r.invoiceNumber?.toLowerCase().includes(needle) ||
        r.billTo?.toLowerCase().includes(needle) ||
        r.customerName?.toLowerCase().includes(needle)
    );
  }
  return rows;
}

async function getInvoice(companyId, invoiceId) {
  const db = getDb();
  const snap = await invoicesCol(db, companyId).doc(invoiceId).get();
  if (!snap.exists) return null;
  return withComputed({ id: snap.id, ...snap.data() });
}

async function createInvoice(companyId, uid, email, role, body) {
  if (!canWriteRecords(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const db = getDb();
  const id = randomId();
  const now = new Date().toISOString();
  const draft = Boolean(body.draft);
  let invoiceNumber = body.invoiceNumber ? String(body.invoiceNumber) : "";
  if (!draft && !invoiceNumber) {
    invoiceNumber = await allocateInvoiceNumber(companyId);
  }
  let customerName = body.customerName || "";
  let customerSnapshot = body.customerSnapshot || null;
  if (body.customerId) {
    const customer = await getCustomer(companyId, body.customerId);
    if (customer) {
      customerName = customer.name;
      customerSnapshot = {
        id: customer.id,
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        address: customer.address,
      };
    }
  }
  const items = Array.isArray(body.items) ? body.items : [];
  const total = invoiceTotal(items);
  const doc = {
    invoiceNumber,
    draft,
    customerId: body.customerId || "",
    customerName,
    customerSnapshot,
    issueDate: body.issueDate || now.slice(0, 10),
    dueDate: body.dueDate || "",
    billTo: body.billTo || customerName,
    items,
    notes: body.notes || "",
    banking: body.banking || null,
    legal: body.legal || null,
    footer: body.footer || "",
    paidAmount: 0,
    total,
    payload: body.payload || null,
    createdAt: now,
    updatedAt: now,
    createdBy: uid,
  };
  const computed = invoiceStatus(doc);
  await invoicesCol(db, companyId).doc(id).set({ ...doc, status: computed.status });
  await logAudit({
    companyId,
    uid,
    email,
    action: "invoice.create",
    payload: { invoiceId: id, invoiceNumber },
  });
  return withComputed({ id, ...doc, status: computed.status });
}

async function updateInvoice(companyId, uid, email, role, invoiceId, body) {
  if (!canWriteRecords(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const existing = await getInvoice(companyId, invoiceId);
  if (!existing) {
    const err = new Error("Invoice not found");
    err.status = 404;
    throw err;
  }
  const db = getDb();
  const patch = { updatedAt: new Date().toISOString() };
  const fields = [
    "issueDate",
    "dueDate",
    "billTo",
    "items",
    "notes",
    "banking",
    "legal",
    "footer",
    "payload",
    "customerId",
    "customerName",
    "customerSnapshot",
    "draft",
  ];
  for (const key of fields) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (patch.items) patch.total = invoiceTotal(patch.items);
  if (existing.draft && body.finalize) {
    patch.draft = false;
    if (!existing.invoiceNumber) {
      patch.invoiceNumber = await allocateInvoiceNumber(companyId);
    }
  }
  const merged = { ...existing, ...patch };
  const computed = invoiceStatus(merged);
  await invoicesCol(db, companyId)
    .doc(invoiceId)
    .set({ ...patch, total: merged.total, status: computed.status }, { merge: true });
  await logAudit({
    companyId,
    uid,
    email,
    action: "invoice.update",
    payload: { invoiceId },
  });
  return withComputed({ ...merged, status: computed.status });
}

async function deleteInvoice(companyId, uid, email, role, invoiceId) {
  if (!canDeleteRecords(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const db = getDb();
  await invoicesCol(db, companyId).doc(invoiceId).delete();
  await logAudit({
    companyId,
    uid,
    email,
    action: "invoice.delete",
    payload: { invoiceId },
  });
}

module.exports = {
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  deleteInvoice,
  withComputed,
};
