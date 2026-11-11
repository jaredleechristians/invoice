const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { invoiceTotal, roundMoney } = require("./money");
const { invoiceStatus } = require("./status");
const { canDeleteRecords, canWriteRecords, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { allocateNumber } = require("./numbering");
const { fetchAll } = require("./db");
const { toIsoDate, todayIso, addDaysIso } = require("./dates");
const {
  normalizeLines,
  companyVatRate,
  totalsFor,
  customerFields,
  issuerSnapshot,
  pickCurrency,
} = require("./documents");

function invoicesCol(db, companyId) {
  return companyRef(db, companyId).collection("invoices");
}

/** Add derived fields (status, outstanding, ...) to a stored invoice. */
function withComputed(invoice, now = new Date()) {
  const total = invoice.total ?? invoiceTotal(invoice.items || []);
  const computed = invoiceStatus(
    {
      total,
      paidAmount: invoice.paidAmount ?? 0,
      dueDate: invoice.dueDate,
      draft: invoice.draft,
      voided: invoice.voided,
    },
    now
  );
  return {
    ...invoice,
    currency: invoice.currency || "ZAR",
    issueDateIso: toIsoDate(invoice.issueDate),
    dueDateIso: toIsoDate(invoice.dueDate),
    total,
    ...computed,
  };
}

async function loadCompany(companyId) {
  const db = getDb();
  const snap = await companyRef(db, companyId).get();
  if (!snap.exists) throw httpError(404, "Company not found");
  return snap.data();
}

async function listInvoices(companyId, { q, status, customerId, currency, limit } = {}) {
  const db = getDb();
  let query = invoicesCol(db, companyId);
  if (customerId) query = query.where("customerId", "==", customerId);
  let rows = (await fetchAll(query)).map((r) => withComputed(r));
  rows.sort(
    (a, b) =>
      String(b.issueDateIso).localeCompare(String(a.issueDateIso)) ||
      String(b.invoiceNumber || "").localeCompare(String(a.invoiceNumber || "")) ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
  if (status) {
    const wanted = String(status).split(",");
    rows = rows.filter((r) => wanted.includes(r.status) || (wanted.includes("open") && r.outstanding > 0));
  }
  if (currency) rows = rows.filter((r) => r.currency === currency);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (r) =>
        r.invoiceNumber?.toLowerCase().includes(needle) ||
        r.billTo?.toLowerCase().includes(needle) ||
        r.customerName?.toLowerCase().includes(needle)
    );
  }
  if (limit) rows = rows.slice(0, Number(limit));
  return rows;
}

async function getInvoice(companyId, invoiceId) {
  const db = getDb();
  const snap = await invoicesCol(db, companyId).doc(invoiceId).get();
  if (!snap.exists) return null;
  return withComputed({ id: snap.id, ...snap.data() });
}

async function requireInvoice(companyId, invoiceId) {
  const inv = await getInvoice(companyId, invoiceId);
  if (!inv) throw httpError(404, "Invoice not found");
  return inv;
}

function assertFinalizable(doc) {
  const lines = (doc.items || []).filter((i) => String(i.description || "").trim());
  if (!lines.length) throw httpError(400, "Add at least one line item before finalizing");
  if (!doc.customerId && !String(doc.billTo || doc.customerName || "").trim()) {
    throw httpError(400, "Pick a customer before finalizing");
  }
  if (roundMoney(doc.total) < 0) throw httpError(400, "Invoice total cannot be negative");
}

async function createInvoice(companyId, uid, email, role, body = {}) {
  assertCan(canWriteRecords, role);
  const db = getDb();
  const company = await loadCompany(companyId);
  const id = randomId();
  const now = new Date().toISOString();
  // Legacy API default (import-local): finalized unless draft:true is sent.
  const draft = body.finalize === true ? false : Boolean(body.draft);

  const cust = await customerFields(companyId, body);
  const currency = pickCurrency(body, {}, company, cust.customer);
  const items = normalizeLines(body.items);
  const vatRate = body.vatRate !== undefined && company.vatRegistered ? Number(body.vatRate) || 0 : companyVatRate(company);
  const totals = totalsFor(items, vatRate);
  const issueDate = toIsoDate(body.issueDate) || todayIso();
  const terms = company.paymentTermsDays ?? 30;
  const dueDate =
    body.dueDate !== undefined ? toIsoDate(body.dueDate) || String(body.dueDate || "") : addDaysIso(issueDate, terms);

  const doc = {
    invoiceNumber: "",
    draft,
    voided: false,
    customerId: cust.customerId,
    customerName: cust.customerName,
    customerSnapshot: cust.customerSnapshot,
    billTo: cust.billTo,
    currency,
    issueDate,
    dueDate,
    reference: String(body.reference || "").slice(0, 120),
    items,
    vatRate,
    ...totals,
    notes: body.notes !== undefined ? String(body.notes || "") : company.defaultNotes || "",
    footer: String(body.footer || ""),
    banking: body.banking || null,
    legal: body.legal || null,
    issuer: null,
    paidAmount: 0,
    payload: body.payload || null,
    sourceQuoteId: String(body.sourceQuoteId || ""),
    duplicatedFrom: String(body.duplicatedFrom || ""),
    createdAt: now,
    updatedAt: now,
    createdBy: uid,
  };

  if (!draft) {
    assertFinalizable(doc);
    doc.invoiceNumber = body.invoiceNumber ? String(body.invoiceNumber) : await allocateNumber(companyId, "invoices");
    doc.issuer = doc.payload ? null : issuerSnapshot(company, currency);
    doc.finalizedAt = now;
  }

  const computed = withComputed(doc);
  await invoicesCol(db, companyId).doc(id).set({ ...doc, status: computed.status });
  await logAudit({
    companyId,
    uid,
    email,
    action: "invoice.create",
    payload: { invoiceId: id, invoiceNumber: doc.invoiceNumber, draft, total: doc.total, currency },
  });
  return withComputed({ id, ...doc });
}

const EDITABLE = ["billTo", "notes", "footer", "reference", "banking", "legal", "payload"];

async function updateInvoice(companyId, uid, email, role, invoiceId, body = {}) {
  assertCan(canWriteRecords, role);
  const existing = await requireInvoice(companyId, invoiceId);
  if (existing.voided) throw httpError(409, "Void invoices cannot be edited");
  const db = getDb();
  const company = await loadCompany(companyId);
  const patch = { updatedAt: new Date().toISOString() };

  for (const key of EDITABLE) if (body[key] !== undefined) patch[key] = body[key];

  if (body.customerId !== undefined || body.customerName !== undefined) {
    const cust = await customerFields(companyId, body, existing);
    Object.assign(patch, {
      customerId: cust.customerId,
      customerName: cust.customerName,
      customerSnapshot: cust.customerSnapshot,
      billTo: cust.billTo,
    });
  }
  if (body.currency !== undefined) {
    const currency = pickCurrency(body, existing, company, null);
    if (currency !== existing.currency && roundMoney(existing.paidAmount) > 0) {
      throw httpError(409, "Cannot change currency after payments were recorded");
    }
    patch.currency = currency;
  }
  if (body.issueDate !== undefined) patch.issueDate = toIsoDate(body.issueDate) || existing.issueDate;
  if (body.dueDate !== undefined) patch.dueDate = toIsoDate(body.dueDate) || String(body.dueDate || "");
  if (body.items !== undefined || body.vatRate !== undefined) {
    const items = body.items !== undefined ? normalizeLines(body.items) : existing.items || [];
    const vatRate =
      body.vatRate !== undefined ? (company.vatRegistered ? Number(body.vatRate) || 0 : 0) : existing.vatRate ?? 0;
    Object.assign(patch, { items, vatRate }, totalsFor(items, vatRate));
    if (!existing.draft && patch.total < roundMoney(existing.paidAmount)) {
      throw httpError(409, "Invoice total cannot be less than the amount already paid");
    }
  }

  const merged = { ...existing, ...patch };
  const wantFinalize = existing.draft && (body.finalize === true || body.draft === false);
  if (wantFinalize) {
    assertFinalizable(merged);
    patch.draft = false;
    patch.invoiceNumber = existing.invoiceNumber || (await allocateNumber(companyId, "invoices"));
    patch.issuer = issuerSnapshot(company, merged.currency || "ZAR");
    patch.finalizedAt = patch.updatedAt;
    Object.assign(merged, patch);
  } else if (!existing.draft && patch.currency) {
    // Re-pick bank accounts for the new currency on a finalized invoice.
    patch.issuer = { ...(existing.issuer || issuerSnapshot(company, patch.currency)), bankAccounts: issuerSnapshot(company, patch.currency).bankAccounts };
    merged.issuer = patch.issuer;
  }

  const computed = withComputed(merged);
  await invoicesCol(db, companyId)
    .doc(invoiceId)
    .set({ ...patch, status: computed.status }, { merge: true });
  await logAudit({
    companyId,
    uid,
    email,
    action: wantFinalize ? "invoice.finalize" : "invoice.update",
    payload: { invoiceId, invoiceNumber: merged.invoiceNumber, total: merged.total },
  });
  return computed;
}

async function finalizeInvoice(companyId, uid, email, role, invoiceId) {
  const existing = await requireInvoice(companyId, invoiceId);
  if (!existing.draft) throw httpError(409, "Invoice is already finalized");
  return updateInvoice(companyId, uid, email, role, invoiceId, { finalize: true });
}

async function countActivePayments(companyId, invoiceId, { includeVoided = false } = {}) {
  const db = getDb();
  const snap = await companyRef(db, companyId).collection("payments").where("invoiceId", "==", invoiceId).get();
  return snap.docs.filter((d) => includeVoided || !d.data().voided).length;
}

async function voidInvoice(companyId, uid, email, role, invoiceId, { reason = "" } = {}) {
  assertCan(canDeleteRecords, role);
  const existing = await requireInvoice(companyId, invoiceId);
  if (existing.voided) throw httpError(409, "Invoice is already void");
  if (existing.draft) throw httpError(409, "Drafts can be deleted instead of voided");
  if ((await countActivePayments(companyId, invoiceId)) > 0) {
    throw httpError(409, "Void or delete this invoice's payments first");
  }
  const db = getDb();
  const now = new Date().toISOString();
  const patch = { voided: true, voidedAt: now, voidedBy: uid, voidReason: String(reason || "").slice(0, 500), status: "void", updatedAt: now };
  await invoicesCol(db, companyId).doc(invoiceId).set(patch, { merge: true });
  await logAudit({ companyId, uid, email, action: "invoice.void", payload: { invoiceId, invoiceNumber: existing.invoiceNumber, reason: patch.voidReason } });
  return withComputed({ ...existing, ...patch });
}

async function duplicateInvoice(companyId, uid, email, role, invoiceId) {
  const src = await requireInvoice(companyId, invoiceId);
  const company = await loadCompany(companyId);
  const issueDate = todayIso();
  return createInvoice(companyId, uid, email, role, {
    draft: true,
    customerId: src.customerId || undefined,
    customerName: src.customerId ? undefined : src.customerName,
    billTo: src.billTo,
    currency: src.currency || "ZAR",
    issueDate,
    dueDate: addDaysIso(issueDate, company.paymentTermsDays ?? 30),
    items: src.items || [],
    notes: src.notes || "",
    footer: src.footer || "",
    reference: src.reference || "",
    duplicatedFrom: invoiceId,
  });
}

async function deleteInvoice(companyId, uid, email, role, invoiceId) {
  assertCan(canDeleteRecords, role);
  const existing = await requireInvoice(companyId, invoiceId);
  if ((await countActivePayments(companyId, invoiceId, { includeVoided: true })) > 0) {
    throw httpError(409, "This invoice has payments. Delete them first, or void the invoice instead.");
  }
  const db = getDb();
  await invoicesCol(db, companyId).doc(invoiceId).delete();
  await logAudit({ companyId, uid, email, action: "invoice.delete", payload: { invoiceId, invoiceNumber: existing.invoiceNumber, draft: existing.draft } });
}

module.exports = {
  listInvoices,
  getInvoice,
  requireInvoice,
  createInvoice,
  updateInvoice,
  finalizeInvoice,
  voidInvoice,
  duplicateInvoice,
  deleteInvoice,
  withComputed,
  loadCompany,
};
