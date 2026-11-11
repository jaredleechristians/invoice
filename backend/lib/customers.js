const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { canDeleteRecords, canWriteRecords } = require("./permissions");
const { logAudit } = require("./audit");
const { companyRef } = require("./refs");
const { normalizeCurrency } = require("./money");

function customersCol(db, companyId) {
  return companyRef(db, companyId).collection("customers");
}

function normalizeCustomerInput(body) {
  return {
    name: String(body.name || "").trim(),
    email: String(body.email || "").trim(),
    phone: String(body.phone || "").trim(),
    address: String(body.address || "").trim(),
    notes: String(body.notes || "").trim(),
    taxNumber: String(body.taxNumber || "").trim(),
    currency: body.currency ? normalizeCurrency(body.currency, "") : "",
  };
}

async function listCustomers(companyId, { q } = {}) {
  const db = getDb();
  const snap = await customersCol(db, companyId).orderBy("name").get();
  let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (c) =>
        c.name?.toLowerCase().includes(needle) ||
        c.email?.toLowerCase().includes(needle)
    );
  }
  return rows;
}

async function getCustomer(companyId, customerId) {
  const db = getDb();
  const snap = await customersCol(db, companyId).doc(customerId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function createCustomer(companyId, uid, email, role, body) {
  if (!canWriteRecords(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const data = normalizeCustomerInput(body);
  if (!data.name) {
    const err = new Error("Customer name is required");
    err.status = 400;
    throw err;
  }
  const db = getDb();
  const id = randomId();
  const now = new Date().toISOString();
  const doc = { ...data, createdAt: now, updatedAt: now };
  await customersCol(db, companyId).doc(id).set(doc);
  await logAudit({
    companyId,
    uid,
    email,
    action: "customer.create",
    payload: { customerId: id, name: data.name },
  });
  return { id, ...doc };
}

async function updateCustomer(companyId, uid, email, role, customerId, body) {
  if (!canWriteRecords(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const existing = await getCustomer(companyId, customerId);
  if (!existing) {
    const err = new Error("Customer not found");
    err.status = 404;
    throw err;
  }
  const data = normalizeCustomerInput({ ...existing, ...body });
  if (!data.name) {
    const err = new Error("Customer name is required");
    err.status = 400;
    throw err;
  }
  const db = getDb();
  const patch = { ...data, updatedAt: new Date().toISOString() };
  await customersCol(db, companyId).doc(customerId).set(patch, { merge: true });
  await logAudit({
    companyId,
    uid,
    email,
    action: "customer.update",
    payload: { customerId },
  });
  return { id: customerId, ...existing, ...patch };
}

async function deleteCustomer(companyId, uid, email, role, customerId) {
  if (!canDeleteRecords(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const db = getDb();
  await customersCol(db, companyId).doc(customerId).delete();
  await logAudit({
    companyId,
    uid,
    email,
    action: "customer.delete",
    payload: { customerId },
  });
}

module.exports = {
  listCustomers,
  getCustomer,
  createCustomer,
  updateCustomer,
  deleteCustomer,
};
