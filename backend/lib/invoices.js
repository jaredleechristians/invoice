const { deletion } = require("./softDelete");
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { invoiceTotal, roundMoney } = require("./money");
const { invoiceStatus } = require("./status");
const { canDeleteRecords, canWriteRecords, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { planNumber } = require("./numbering");
const { fetchAll } = require("./db");
const { paymentAccounts } = require("./bankAccounts");
const { toIsoDate, todayIso, addDaysIso } = require("./dates");
const {
  normalizeLines,
  stampLineAccounts,
  cleanExchangeRate,
  companyVatRate,
  totalsFor,
  customerFields,
  issuerSnapshot,
  pickCurrency,
} = require("./documents");
const { ensureChart } = require("./ledger/accounts");
const { invoiceLines } = require("./ledger/rules");
const { planPost, planReverse, sourceKey, nextVersion, systemAccountsOf, baseCurrencyOf, ensureGoLiveDate } = require("./ledger/post");
const { effectivePaymentTermsDays, creditLimitWarningForInvoice } = require("./customers");

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
      creditedAmount: invoice.creditedAmount ?? 0,
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

/**
 * Company settings for documents. bankAccounts comes from the bank accounts
 * collection (accounts marked "Show on invoices"), not the old settings field.
 */
async function loadCompany(companyId) {
  const db = getDb();
  const snap = await companyRef(db, companyId).get();
  if (!snap.exists) throw httpError(404, "Company not found");
  const data = snap.data();
  return { ...data, bankAccounts: await paymentAccounts(companyId, data) };
}

async function loadLedgerCtx(companyId) {
  await ensureChart(companyId);
  const snap = await companyRef(getDb(), companyId).get();
  const company = snap.exists ? snap.data() : {};
  return { company, baseCurrency: baseCurrencyOf(company), systemAccounts: systemAccountsOf(company) };
}

function ledgerFingerprint(inv) {
  return JSON.stringify({
    issueDate: inv.issueDate,
    currency: inv.currency,
    exchangeRate: inv.exchangeRate || null,
    customerId: inv.customerId || "",
    vatRate: inv.vatRate ?? 0,
    subtotal: inv.subtotal,
    taxTotal: inv.taxTotal,
    total: inv.total,
    items: (inv.items || []).map((i) => ({
      accountId: i.accountId || "",
      qty: i.qty,
      unitPrice: i.unitPrice,
      taxable: i.taxable !== false,
    })),
  });
}

async function planInvoiceLedger(tx, companyId, { invoiceId, doc, event, createdBy, currentLedger, reverseDate, postDate, ctx }) {
  let reverse = { commit() {} };
  if (currentLedger?.entryId && event !== "post") {
    reverse = await planReverse(tx, companyId, {
      entryId: currentLedger.entryId,
      date: reverseDate || doc.issueDate,
      event,
      createdBy,
    });
  }
  const shouldPost = event === "post" || event === "edit" || event === "restore";
  let post = { commit() {}, id: null, skipped: true };
  let ledger = currentLedger || null;
  if (shouldPost) {
    const lines = invoiceLines(doc, ctx);
    if (lines.length) {
      const version = currentLedger?.entryId ? nextVersion(currentLedger) : 1;
      post = await planPost(tx, companyId, {
        sourceKey: sourceKey("invoice", invoiceId, version),
        date: postDate || doc.issueDate,
        lines,
        source: { type: "invoice", id: invoiceId, number: doc.invoiceNumber || "", event, version },
        memo: `${doc.invoiceNumber || "Invoice"} ${doc.customerName || ""}`.trim(),
        createdBy,
        baseCurrency: ctx.baseCurrency,
      });
      ledger = { entryId: post.id, version };
    }
  }
  return {
    ledger,
    commit(writeTx) {
      reverse.commit(writeTx);
      post.commit(writeTx);
    },
  };
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
  if (!snap.exists || snap.data().deletedAt) return null;
  return withComputed({ id: snap.id, ...snap.data() });
}

async function requireInvoice(companyId, invoiceId) {
  const inv = await getInvoice(companyId, invoiceId);
  if (!inv) throw httpError(404, "Invoice not found");
  return inv;
}

function assertFinalizable(doc, company = {}) {
  const lines = (doc.items || []).filter((i) => String(i.description || "").trim());
  if (!lines.length) throw httpError(400, "Add at least one line item before publishing");
  if (!doc.customerId && !String(doc.billTo || doc.customerName || "").trim()) {
    throw httpError(400, "Pick a customer before publishing");
  }
  if (roundMoney(doc.total) < 0) throw httpError(400, "Invoice total cannot be negative");
  const base = company.baseCurrency || "ZAR";
  if ((doc.currency || base) !== base && !doc.exchangeRate) {
    throw httpError(400, "An exchange rate is required before publishing a foreign-currency invoice");
  }
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
  const items = await stampLineAccounts(companyId, body.items);
  const vatRate = body.vatRate !== undefined && company.vatRegistered ? Number(body.vatRate) || 0 : companyVatRate(company);
  const totals = totalsFor(items, vatRate);
  const issueDate = toIsoDate(body.issueDate) || todayIso();
  const terms = effectivePaymentTermsDays(cust.customer, company);
  const dueDate =
    body.dueDate !== undefined ? toIsoDate(body.dueDate) || String(body.dueDate || "") : addDaysIso(issueDate, terms);
  const base = company.baseCurrency || "ZAR";

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
    exchangeRate: currency === base ? null : cleanExchangeRate(body.exchangeRate),
    notes: body.notes !== undefined ? String(body.notes || "") : company.defaultNotes || "",
    footer: String(body.footer || ""),
    banking: body.banking || null,
    legal: body.legal || null,
    issuer: null,
    paidAmount: 0,
    creditedAmount: 0,
    payload: body.payload || null,
    sourceQuoteId: String(body.sourceQuoteId || ""),
    duplicatedFrom: String(body.duplicatedFrom || ""),
    createdAt: now,
    updatedAt: now,
    createdBy: uid,
  };

  if (draft) {
    const computed = withComputed(doc);
    const timeEntries = require("./timeEntries");
    if (timeEntries.entryIdsFromItems(doc.items).length) {
      await timeEntries.runWithTx(async (tx, tdb) => {
        const prepared = await timeEntries.prepareInvoiceTimeEntries(tx, tdb, companyId, id, {
          items: doc.items,
          customerId: doc.customerId,
        });
        tx.set(invoicesCol(tdb, companyId).doc(id), { ...doc, status: computed.status });
        timeEntries.commitInvoiceTimeEntries(tx, id, prepared, { billed: false, customerId: doc.customerId });
      });
    } else {
      await invoicesCol(db, companyId).doc(id).set({ ...doc, status: computed.status });
    }
  } else {
    assertFinalizable(doc, company);
    doc.issuer = doc.payload ? null : issuerSnapshot(company, currency);
    doc.finalizedAt = now;
    const ctx = await loadLedgerCtx(companyId);
    await db.runTransaction(async (tx) => {
      let commitNumber = null;
      if (body.invoiceNumber) {
        doc.invoiceNumber = String(body.invoiceNumber);
      } else {
        const planned = await planNumber(tx, companyId, "invoices");
        doc.invoiceNumber = planned.number;
        commitNumber = planned.commit;
      }
      const posting = await planInvoiceLedger(tx, companyId, {
        invoiceId: id,
        doc,
        event: "post",
        createdBy: uid,
        currentLedger: null,
        postDate: doc.issueDate,
        ctx,
      });
      const timeEntries = require("./timeEntries");
      const preparedTime = await timeEntries.prepareInvoiceTimeEntries(tx, db, companyId, id, {
        items: doc.items,
        customerId: doc.customerId,
      });
      if (commitNumber) commitNumber(tx);
      const computed = withComputed(doc);
      tx.set(invoicesCol(db, companyId).doc(id), { ...doc, status: computed.status, ledger: posting.ledger });
      posting.commit(tx);
      timeEntries.commitInvoiceTimeEntries(tx, id, preparedTime, { billed: true, customerId: doc.customerId });
      doc.ledger = posting.ledger;
    });
    await ensureGoLiveDate(companyId);
  }

  await logAudit({
    companyId,
    uid,
    email,
    action: "invoice.create",
    payload: { invoiceId: id, invoiceNumber: doc.invoiceNumber, draft, total: doc.total, currency },
  });
  const created = withComputed({ id, ...doc });
  return draft ? created : withCreditLimitWarning(companyId, created);
}

const EDITABLE = ["billTo", "notes", "footer", "reference", "banking", "legal", "payload"];

async function updateInvoice(companyId, uid, email, role, invoiceId, body = {}) {
  assertCan(canWriteRecords, role);
  const existing = await requireInvoice(companyId, invoiceId);
  if (existing.voided) throw httpError(409, "Void invoices cannot be edited");
  const db = getDb();
  const company = await loadCompany(companyId);
  const base = company.baseCurrency || "ZAR";
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
    if (currency === base) patch.exchangeRate = null;
  }
  if (body.exchangeRate !== undefined) {
    if (roundMoney(existing.paidAmount) > 0 && cleanExchangeRate(body.exchangeRate) !== (existing.exchangeRate || null)) {
      throw httpError(409, "Cannot change the exchange rate after payments were recorded");
    }
    const currency = patch.currency || existing.currency;
    patch.exchangeRate = currency === base ? null : cleanExchangeRate(body.exchangeRate);
  }
  if (body.issueDate !== undefined) patch.issueDate = toIsoDate(body.issueDate) || existing.issueDate;
  if (body.dueDate !== undefined) patch.dueDate = toIsoDate(body.dueDate) || String(body.dueDate || "");
  if (body.items !== undefined || body.vatRate !== undefined) {
    const items = body.items !== undefined ? await stampLineAccounts(companyId, body.items) : existing.items || [];
    const vatRate =
      body.vatRate !== undefined ? (company.vatRegistered ? Number(body.vatRate) || 0 : 0) : existing.vatRate ?? 0;
    Object.assign(patch, { items, vatRate }, totalsFor(items, vatRate));
    if (!existing.draft && patch.total < roundMoney((existing.paidAmount || 0) + (existing.creditedAmount || 0))) {
      throw httpError(409, "Invoice total cannot be less than the amount already paid and credited");
    }
  }

  const merged = { ...existing, ...patch };
  const wantFinalize = existing.draft && (body.finalize === true || body.draft === false);
  if (wantFinalize) {
    assertFinalizable(merged, company);
    patch.draft = false;
    patch.issuer = issuerSnapshot(company, merged.currency || "ZAR");
    patch.finalizedAt = patch.updatedAt;
    Object.assign(merged, patch);
  } else if (!existing.draft && patch.currency) {
    // Re-pick bank accounts for the new currency on a finalized invoice.
    patch.issuer = { ...(existing.issuer || issuerSnapshot(company, patch.currency)), bankAccounts: issuerSnapshot(company, patch.currency).bankAccounts };
    merged.issuer = patch.issuer;
  }

  if (!existing.draft && !wantFinalize) {
    const currency = merged.currency || base;
    if (currency !== base && !merged.exchangeRate) {
      throw httpError(400, "An exchange rate is required before publishing a foreign-currency invoice");
    }
  }

  const shouldPost = wantFinalize || (!existing.draft && ledgerFingerprint(existing) !== ledgerFingerprint(merged));
  if (!shouldPost && !wantFinalize) {
    const computed = withComputed(merged);
    await invoicesCol(db, companyId)
      .doc(invoiceId)
      .set({ ...patch, status: computed.status }, { merge: true });
    const timeEntries = require("./timeEntries");
    if (timeEntries.entryIdsFromItems(merged.items).length || timeEntries.entryIdsFromItems(existing.items).length) {
      await timeEntries.runWithTx((tx, tdb) =>
        timeEntries.syncInvoiceTimeEntries(tx, tdb, companyId, invoiceId, {
          items: merged.items,
          previousItems: existing.items,
          billed: !merged.draft,
          customerId: merged.customerId,
        })
      );
    }
  } else {
    const ctx = await loadLedgerCtx(companyId);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(invoicesCol(db, companyId).doc(invoiceId));
      if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Invoice not found");
      if (snap.data().voided) throw httpError(409, "Void invoices cannot be edited");
      let commitNumber = null;
      if (wantFinalize && !merged.invoiceNumber) {
        const planned = await planNumber(tx, companyId, "invoices");
        patch.invoiceNumber = planned.number;
        merged.invoiceNumber = planned.number;
        commitNumber = planned.commit;
      } else if (wantFinalize) {
        patch.invoiceNumber = existing.invoiceNumber;
      }
      Object.assign(merged, patch);
      const posting = await planInvoiceLedger(tx, companyId, {
        invoiceId,
        doc: merged,
        event: wantFinalize ? "post" : "edit",
        createdBy: uid,
        currentLedger: wantFinalize ? null : existing.ledger,
        reverseDate: existing.issueDate,
        postDate: merged.issueDate,
        ctx,
      });
      const timeEntries = require("./timeEntries");
      const preparedTime = await timeEntries.prepareInvoiceTimeEntries(tx, db, companyId, invoiceId, {
        items: merged.items,
        previousItems: existing.items,
        customerId: merged.customerId,
      });
      const computed = withComputed(merged);
      if (commitNumber) commitNumber(tx);
      tx.set(invoicesCol(db, companyId).doc(invoiceId), { ...patch, status: computed.status, ledger: posting.ledger }, { merge: true });
      posting.commit(tx);
      timeEntries.commitInvoiceTimeEntries(tx, invoiceId, preparedTime, { billed: true, customerId: merged.customerId });
      merged.ledger = posting.ledger;
    });
    await ensureGoLiveDate(companyId);
  }

  await logAudit({
    companyId,
    uid,
    email,
    action: wantFinalize ? "invoice.finalize" : "invoice.update",
    payload: { invoiceId, invoiceNumber: merged.invoiceNumber, total: merged.total },
  });
  const out = withComputed(merged);
  return wantFinalize || !out.draft ? withCreditLimitWarning(companyId, out) : out;
}

async function finalizeInvoice(companyId, uid, email, role, invoiceId) {
  const existing = await requireInvoice(companyId, invoiceId);
  if (!existing.draft) throw httpError(409, "Invoice is already published");
  return updateInvoice(companyId, uid, email, role, invoiceId, { finalize: true });
}

async function countActivePayments(companyId, invoiceId, { includeVoided = false } = {}) {
  const db = getDb();
  const snap = await companyRef(db, companyId).collection("payments").where("invoiceId", "==", invoiceId).get();
  return snap.docs.filter((d) => !d.data().deletedAt && (includeVoided || !d.data().voided)).length;
}

async function voidInvoice(companyId, uid, email, role, invoiceId, { reason = "" } = {}) {
  assertCan(canDeleteRecords, role);
  const existing = await requireInvoice(companyId, invoiceId);
  if (existing.voided) throw httpError(409, "Invoice is already void");
  if (existing.draft) throw httpError(409, "Drafts can be deleted instead of voided");
  if ((await countActivePayments(companyId, invoiceId)) > 0) {
    throw httpError(409, "Void or delete this invoice's payments first");
  }
  if ((await countActiveCreditNotes(companyId, invoiceId)) > 0) {
    throw httpError(409, "Void or delete this invoice's credit notes first");
  }
  const db = getDb();
  const now = new Date().toISOString();
  const voidDate = todayIso();
  const patch = { voided: true, voidedAt: now, voidedBy: uid, voidReason: String(reason || "").slice(0, 500), status: "void", updatedAt: now };
  const ctx = await loadLedgerCtx(companyId);
  await db.runTransaction(async (tx) => {
    const posting = await planInvoiceLedger(tx, companyId, {
      invoiceId,
      doc: existing,
      event: "void",
      createdBy: uid,
      currentLedger: existing.ledger,
      reverseDate: voidDate,
      ctx,
    });
    const timeEntries = require("./timeEntries");
    const preparedTime = await timeEntries.prepareDetachInvoiceTimeEntries(tx, db, companyId, invoiceId, { items: existing.items });
    tx.set(invoicesCol(db, companyId).doc(invoiceId), { ...patch, ledger: posting.ledger }, { merge: true });
    posting.commit(tx);
    timeEntries.commitDetachInvoiceTimeEntries(tx, preparedTime);
  });
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
    items: (src.items || []).map((i) => {
      const { timeEntryId, ...rest } = i;
      void timeEntryId;
      return rest;
    }),
    notes: src.notes || "",
    footer: src.footer || "",
    reference: src.reference || "",
    exchangeRate: src.exchangeRate,
    duplicatedFrom: invoiceId,
  });
}

async function deleteInvoice(companyId, uid, email, role, invoiceId) {
  assertCan(canDeleteRecords, role);
  const existing = await requireInvoice(companyId, invoiceId);
  if ((await countActivePayments(companyId, invoiceId, { includeVoided: true })) > 0) {
    throw httpError(409, "This invoice has payments. Delete them first, or void the invoice instead.");
  }
  if ((await countActiveCreditNotes(companyId, invoiceId, { includeVoided: true, includeDrafts: true })) > 0) {
    throw httpError(409, "This invoice has credit notes. Delete or void them first.");
  }
  const db = getDb();
  // Soft delete: the document (and its number) stays, hidden everywhere.
  // Reverse a published (non-void) invoice on the original issue date.
  const shouldReverse = !existing.draft && !existing.voided && existing.ledger?.entryId;
  if (shouldReverse) {
    const ctx = await loadLedgerCtx(companyId);
    await db.runTransaction(async (tx) => {
      const posting = await planInvoiceLedger(tx, companyId, {
        invoiceId,
        doc: existing,
        event: "delete",
        createdBy: uid,
        currentLedger: existing.ledger,
        reverseDate: existing.issueDate,
        ctx,
      });
      const timeEntries = require("./timeEntries");
      const preparedTime = await timeEntries.prepareDetachInvoiceTimeEntries(tx, db, companyId, invoiceId, { items: existing.items });
      tx.set(invoicesCol(db, companyId).doc(invoiceId), { ...deletion(uid), ledger: posting.ledger }, { merge: true });
      posting.commit(tx);
      timeEntries.commitDetachInvoiceTimeEntries(tx, preparedTime);
    });
  } else {
    const timeEntries = require("./timeEntries");
    if (timeEntries.entryIdsFromItems(existing.items).length) {
      await timeEntries.runWithTx(async (tx, tdb) => {
        const preparedTime = await timeEntries.prepareDetachInvoiceTimeEntries(tx, tdb, companyId, invoiceId, { items: existing.items });
        tx.set(invoicesCol(tdb, companyId).doc(invoiceId), deletion(uid), { merge: true });
        timeEntries.commitDetachInvoiceTimeEntries(tx, preparedTime);
      });
    } else {
      await invoicesCol(db, companyId).doc(invoiceId).set(deletion(uid), { merge: true });
    }
  }
  await logAudit({ companyId, uid, email, action: "invoice.delete", payload: { invoiceId, invoiceNumber: existing.invoiceNumber, draft: existing.draft } });
}


async function countActiveCreditNotes(companyId, invoiceId, opts = {}) {
  return require("./creditNotes").countActiveCreditNotes(companyId, invoiceId, opts);
}

async function withCreditLimitWarning(companyId, invoice) {
  const warning = await creditLimitWarningForInvoice(companyId, invoice);
  return warning ? { ...invoice, creditLimitWarning: warning } : invoice;
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
  loadLedgerCtx,
  planInvoiceLedger,
  cleanExchangeRate,
};
