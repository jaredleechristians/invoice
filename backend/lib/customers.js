const { httpError } = require("./errors");
const { deletion } = require("./softDelete");
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { canDeleteRecords, canWriteRecords } = require("./permissions");
const { logAudit } = require("./audit");
const { companyRef } = require("./refs");
const { normalizeCurrency, roundMoney } = require("./money");

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


function parseOptionalTerms(value, existing) {
  if (value === undefined) return existing;
  if (value === null || value === "") return null;
  const d = Number(value);
  if (!Number.isInteger(d) || d < 0 || d > 365) throw httpError(400, "Payment terms must be 0–365 days");
  return d;
}

function parseOptionalLimit(value, existing) {
  if (value === undefined) return existing;
  if (value === null || value === "") return null;
  const n = roundMoney(value);
  if (Number.isNaN(n) || n < 0) throw httpError(400, "Credit limit must be zero or more");
  return n;
}

/** Customer terms if set, otherwise the company default (30 if unset). */
function effectivePaymentTermsDays(customer, company = {}) {
  if (customer && customer.paymentTermsDays != null && customer.paymentTermsDays !== "") {
    return Number(customer.paymentTermsDays);
  }
  return company.paymentTermsDays ?? 30;
}

function creditLimitCurrency(customer, company = {}) {
  return customer?.currency || company?.defaultCurrency || "ZAR";
}

/**
 * Outstanding vs optional credit limit for a customer, in the limit's currency.
 * `extraInvoice` is included when checking a document that is about to be published.
 */
async function customerCreditSnapshot(companyId, customerId, { extraInvoice } = {}) {
  const customer = await getCustomer(companyId, customerId);
  if (!customer) return null;
  const { loadCompany } = require("./invoices");
  const { listInvoices } = require("./invoices");
  const company = await loadCompany(companyId);
  const currency = creditLimitCurrency(customer, company);
  const invoices = await listInvoices(companyId, { customerId });
  let outstanding = 0;
  for (const inv of invoices) {
    if (inv.draft || inv.voided) continue;
    if ((inv.currency || "ZAR") !== currency) continue;
    outstanding = roundMoney(outstanding + (inv.outstanding || 0));
  }
  if (extraInvoice && !extraInvoice.voided && (extraInvoice.currency || "ZAR") === currency) {
    const already = invoices.some((i) => i.id && extraInvoice.id && i.id === extraInvoice.id);
    if (!already) outstanding = roundMoney(outstanding + roundMoney(extraInvoice.total || 0));
  }
  const limit = customer.creditLimit == null ? null : roundMoney(customer.creditLimit);
  const exceeded = limit != null && outstanding > limit + 0.001;
  return {
    customerId: customer.id,
    customerName: customer.name,
    currency,
    paymentTermsDays: customer.paymentTermsDays ?? null,
    effectivePaymentTermsDays: effectivePaymentTermsDays(customer, company),
    creditLimit: limit,
    outstanding,
    available: limit == null ? null : roundMoney(limit - outstanding),
    exceeded,
  };
}

async function creditLimitWarningForInvoice(companyId, invoice) {
  if (!invoice?.customerId) return null;
  const snap = await customerCreditSnapshot(companyId, invoice.customerId, { extraInvoice: invoice });
  if (!snap || snap.creditLimit == null || !snap.exceeded) return null;
  return {
    message: `This takes ${snap.customerName}'s outstanding ${snap.currency} to ${snap.outstanding.toFixed(2)}, over the ${snap.creditLimit.toFixed(2)} credit limit.`,
    ...snap,
  };
}

async function listCustomers(companyId, { q } = {}) {
  const db = getDb();
  const snap = await customersCol(db, companyId).orderBy("name").get();
  let rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => !c.deletedAt);
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
  if (!snap.exists || snap.data().deletedAt) return null;
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
  const doc = {
    ...data,
    paymentTermsDays: parseOptionalTerms(body.paymentTermsDays, null),
    creditLimit: parseOptionalLimit(body.creditLimit, null),
    createdAt: now,
    updatedAt: now,
  };
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
  const patch = {
    ...data,
    paymentTermsDays: parseOptionalTerms(body.paymentTermsDays, existing.paymentTermsDays ?? null),
    creditLimit: parseOptionalLimit(body.creditLimit, existing.creditLimit ?? null),
    updatedAt: new Date().toISOString(),
  };
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
  if (!(await getCustomer(companyId, customerId))) throw httpError(404, "Customer not found");
  await customersCol(db, companyId).doc(customerId).set(deletion(uid), { merge: true });
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
  effectivePaymentTermsDays,
  creditLimitCurrency,
  customerCreditSnapshot,
  creditLimitWarningForInvoice,
};
