const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { canDeleteRecords, canWriteRecords, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { allocateNumber } = require("./numbering");
const { fetchAll } = require("./db");
const { toIsoDate, todayIso, addDaysIso } = require("./dates");
const { loadCompany, withComputed: invoiceComputed } = require("./invoices");
const {
  normalizeLines,
  companyVatRate,
  totalsFor,
  customerFields,
  issuerSnapshot,
  pickCurrency,
} = require("./documents");

const QUOTE_STATUSES = ["draft", "sent", "accepted", "declined", "converted"];

function quotesCol(db, companyId) {
  return companyRef(db, companyId).collection("quotes");
}

function withQuoteComputed(q, now = new Date()) {
  const expiry = toIsoDate(q.expiryDate);
  const expired = Boolean(expiry) && expiry < todayIso(now) && ["draft", "sent"].includes(q.status);
  return {
    ...q,
    currency: q.currency || "ZAR",
    issueDateIso: toIsoDate(q.issueDate),
    expiryDateIso: expiry,
    expired,
    displayStatus: expired ? "expired" : q.status,
  };
}

async function listQuotes(companyId, { q, status, customerId } = {}) {
  const db = getDb();
  let query = quotesCol(db, companyId);
  if (customerId) query = query.where("customerId", "==", customerId);
  let rows = (await fetchAll(query)).map((r) => withQuoteComputed(r));
  rows.sort((a, b) => String(b.issueDateIso).localeCompare(String(a.issueDateIso)) || String(b.quoteNumber).localeCompare(String(a.quoteNumber)));
  if (status) rows = rows.filter((r) => r.displayStatus === status || r.status === status);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((r) => r.quoteNumber?.toLowerCase().includes(needle) || r.customerName?.toLowerCase().includes(needle));
  }
  return rows;
}

async function getQuote(companyId, quoteId) {
  const db = getDb();
  const snap = await quotesCol(db, companyId).doc(quoteId).get();
  if (!snap.exists) return null;
  return withQuoteComputed({ id: snap.id, ...snap.data() });
}

async function requireQuote(companyId, quoteId) {
  const q = await getQuote(companyId, quoteId);
  if (!q) throw httpError(404, "Quote not found");
  return q;
}

async function createQuote(companyId, uid, email, role, body = {}) {
  assertCan(canWriteRecords, role);
  const db = getDb();
  const company = await loadCompany(companyId);
  const cust = await customerFields(companyId, body);
  const currency = pickCurrency(body, {}, company, cust.customer);
  const items = normalizeLines(body.items);
  const vatRate = companyVatRate(company);
  const issueDate = toIsoDate(body.issueDate) || todayIso();
  const id = randomId();
  const now = new Date().toISOString();
  const doc = {
    quoteNumber: await allocateNumber(companyId, "quotes"),
    status: "draft",
    customerId: cust.customerId,
    customerName: cust.customerName,
    customerSnapshot: cust.customerSnapshot,
    billTo: cust.billTo,
    currency,
    issueDate,
    expiryDate: body.expiryDate !== undefined ? toIsoDate(body.expiryDate) : addDaysIso(issueDate, company.quoteValidDays ?? 30),
    reference: String(body.reference || "").slice(0, 120),
    items,
    vatRate,
    ...totalsFor(items, vatRate),
    notes: body.notes !== undefined ? String(body.notes || "") : "",
    convertedInvoiceId: "",
    createdAt: now,
    updatedAt: now,
    createdBy: uid,
  };
  await quotesCol(db, companyId).doc(id).set(doc);
  await logAudit({ companyId, uid, email, action: "quote.create", payload: { quoteId: id, quoteNumber: doc.quoteNumber } });
  return withQuoteComputed({ id, ...doc });
}

async function updateQuote(companyId, uid, email, role, quoteId, body = {}) {
  assertCan(canWriteRecords, role);
  const existing = await requireQuote(companyId, quoteId);
  if (existing.status === "converted") throw httpError(409, "Converted quotes cannot be edited");
  const company = await loadCompany(companyId);
  const db = getDb();
  const patch = { updatedAt: new Date().toISOString() };
  for (const key of ["billTo", "notes", "reference"]) if (body[key] !== undefined) patch[key] = String(body[key] || "");
  if (body.customerId !== undefined || body.customerName !== undefined) {
    const cust = await customerFields(companyId, body, existing);
    Object.assign(patch, { customerId: cust.customerId, customerName: cust.customerName, customerSnapshot: cust.customerSnapshot, billTo: cust.billTo });
  }
  if (body.currency !== undefined) patch.currency = pickCurrency(body, existing, company, null);
  if (body.issueDate !== undefined) patch.issueDate = toIsoDate(body.issueDate) || existing.issueDate;
  if (body.expiryDate !== undefined) patch.expiryDate = toIsoDate(body.expiryDate);
  if (body.items !== undefined) {
    const items = normalizeLines(body.items);
    const vatRate = existing.vatRate ?? companyVatRate(company);
    Object.assign(patch, { items, vatRate }, totalsFor(items, vatRate));
  }
  if (body.status !== undefined) {
    if (!["draft", "sent", "accepted", "declined"].includes(body.status)) throw httpError(400, "Invalid quote status");
    patch.status = body.status;
  }
  await quotesCol(db, companyId).doc(quoteId).set(patch, { merge: true });
  await logAudit({ companyId, uid, email, action: "quote.update", payload: { quoteId, status: patch.status } });
  return withQuoteComputed({ ...existing, ...patch });
}

/**
 * Convert a quote into a draft invoice. Runs in a transaction so a quote can
 * only ever be converted once.
 */
async function convertQuote(companyId, uid, email, role, quoteId) {
  assertCan(canWriteRecords, role);
  const db = getDb();
  const company = await loadCompany(companyId);
  const quoteRef = quotesCol(db, companyId).doc(quoteId);
  const invoiceId = randomId();
  const now = new Date().toISOString();
  const issueDate = todayIso();

  const invoice = await db.runTransaction(async (tx) => {
    const snap = await tx.get(quoteRef);
    if (!snap.exists) throw httpError(404, "Quote not found");
    const quote = snap.data();
    if (quote.status === "converted" || quote.convertedInvoiceId) {
      throw httpError(409, "Quote was already converted");
    }
    if (quote.status === "declined") throw httpError(409, "Declined quotes cannot be converted");
    const doc = {
      invoiceNumber: "",
      draft: true,
      voided: false,
      customerId: quote.customerId || "",
      customerName: quote.customerName || "",
      customerSnapshot: quote.customerSnapshot || null,
      billTo: quote.billTo || "",
      currency: quote.currency || "ZAR",
      issueDate,
      dueDate: addDaysIso(issueDate, company.paymentTermsDays ?? 30),
      reference: quote.reference || quote.quoteNumber || "",
      items: quote.items || [],
      vatRate: quote.vatRate || 0,
      subtotal: quote.subtotal || 0,
      taxTotal: quote.taxTotal || 0,
      total: quote.total || 0,
      notes: quote.notes || company.defaultNotes || "",
      footer: "",
      banking: null,
      legal: null,
      issuer: null,
      paidAmount: 0,
      payload: null,
      sourceQuoteId: quoteId,
      duplicatedFrom: "",
      status: "draft",
      createdAt: now,
      updatedAt: now,
      createdBy: uid,
    };
    tx.set(companyRef(db, companyId).collection("invoices").doc(invoiceId), doc);
    tx.set(quoteRef, { status: "converted", convertedInvoiceId: invoiceId, convertedAt: now, updatedAt: now }, { merge: true });
    return { id: invoiceId, ...doc };
  });

  await logAudit({ companyId, uid, email, action: "quote.convert", payload: { quoteId, invoiceId } });
  return { invoice: invoiceComputed(invoice), quote: await getQuote(companyId, quoteId) };
}

async function duplicateQuote(companyId, uid, email, role, quoteId) {
  const src = await requireQuote(companyId, quoteId);
  return createQuote(companyId, uid, email, role, {
    customerId: src.customerId || undefined,
    customerName: src.customerId ? undefined : src.customerName,
    billTo: src.billTo,
    currency: src.currency,
    items: src.items || [],
    notes: src.notes || "",
    reference: src.reference || "",
  });
}

async function deleteQuote(companyId, uid, email, role, quoteId) {
  assertCan(canDeleteRecords, role);
  const existing = await requireQuote(companyId, quoteId);
  const db = getDb();
  await quotesCol(db, companyId).doc(quoteId).delete();
  await logAudit({ companyId, uid, email, action: "quote.delete", payload: { quoteId, quoteNumber: existing.quoteNumber } });
}

/** Issuer block for quote PDFs (quotes are never frozen; always live settings). */
function quoteIssuer(company, quote) {
  return issuerSnapshot(company, quote.currency || "ZAR");
}

module.exports = {
  QUOTE_STATUSES,
  listQuotes,
  getQuote,
  requireQuote,
  createQuote,
  updateQuote,
  convertQuote,
  duplicateQuote,
  deleteQuote,
  quoteIssuer,
  withQuoteComputed,
};
