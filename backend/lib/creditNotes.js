const { deletion } = require("./softDelete");
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { roundMoney } = require("./money");
const { canDeleteRecords, canWriteRecords, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { planNumber } = require("./numbering");
const { fetchAll } = require("./db");
const { toIsoDate, todayIso } = require("./dates");
const { stampLineAccounts, companyVatRate, totalsFor, issuerSnapshot } = require("./documents");
const { creditNoteLines } = require("./ledger/rules");
const { planPost, planReverse, sourceKey, nextVersion, ensureGoLiveDate } = require("./ledger/post");

function creditNotesCol(db, companyId) {
  return companyRef(db, companyId).collection("creditNotes");
}

function invoicesCol(db, companyId) {
  return companyRef(db, companyId).collection("invoices");
}

function sumCredits(notes) {
  return roundMoney(
    (notes || [])
      .filter((n) => !n.voided && !n.deletedAt && !n.draft)
      .reduce((s, n) => s + roundMoney(n.total), 0)
  );
}

function noteStatus(note) {
  if (note.voided) return "void";
  if (note.draft) return "draft";
  return "issued";
}

function withComputed(note) {
  return {
    ...note,
    currency: note.currency || "ZAR",
    issueDateIso: toIsoDate(note.issueDate),
    total: roundMoney(note.total ?? 0),
    status: noteStatus(note),
  };
}

function invoicesLib() {
  return require("./invoices");
}

async function listCreditNotes(companyId, { q, invoiceId, customerId, status } = {}) {
  const db = getDb();
  let query = creditNotesCol(db, companyId);
  if (invoiceId) query = query.where("invoiceId", "==", invoiceId);
  let rows = (await fetchAll(query))
    .filter((n) => !n.deletedAt)
    .map(withComputed);
  if (customerId) rows = rows.filter((n) => n.customerId === customerId);
  if (status) rows = rows.filter((n) => n.status === status);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter(
      (n) =>
        (n.creditNoteNumber || "").toLowerCase().includes(needle) ||
        (n.customerName || "").toLowerCase().includes(needle) ||
        (n.reason || "").toLowerCase().includes(needle)
    );
  }
  rows.sort(
    (a, b) =>
      String(b.issueDateIso || "").localeCompare(String(a.issueDateIso || "")) ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || ""))
  );
  return rows;
}

async function getCreditNote(companyId, id) {
  const snap = await creditNotesCol(getDb(), companyId).doc(id).get();
  if (!snap.exists || snap.data().deletedAt) return null;
  return withComputed({ id: snap.id, ...snap.data() });
}

async function requireCreditNote(companyId, id) {
  const note = await getCreditNote(companyId, id);
  if (!note) throw httpError(404, "Credit note not found");
  return note;
}

async function countActiveCreditNotes(companyId, invoiceId, { includeVoided = false, includeDrafts = false } = {}) {
  const rows = await listCreditNotes(companyId, { invoiceId });
  return rows.filter((n) => (includeVoided || !n.voided) && (includeDrafts || !n.draft)).length;
}

async function planCreditNoteLedger(tx, companyId, { creditNoteId, doc, event, createdBy, currentLedger, reverseDate, postDate, ctx }) {
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
    const lines = creditNoteLines(doc, ctx);
    if (lines.length) {
      const version = currentLedger?.entryId ? nextVersion(currentLedger) : 1;
      post = await planPost(tx, companyId, {
        sourceKey: sourceKey("credit_note", creditNoteId, version),
        date: postDate || doc.issueDate,
        lines,
        source: {
          type: "credit_note",
          id: creditNoteId,
          invoiceId: doc.invoiceId,
          number: doc.creditNoteNumber || "",
          event,
          version,
        },
        memo: `${doc.creditNoteNumber || "Credit note"} ${doc.invoiceNumber || ""} ${doc.customerName || ""}`.trim(),
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

function remainingOnInvoice(invoice, notes, { ignoreId } = {}) {
  const paid = roundMoney(invoice.paidAmount || 0);
  const credited = sumCredits((notes || []).filter((n) => n.id !== ignoreId));
  return roundMoney(roundMoney(invoice.total) - paid - credited);
}

async function writeInvoiceCredits(tx, db, companyId, invoice, notes) {
  const { withComputed } = invoicesLib();
  const creditedAmount = sumCredits(notes);
  const computed = withComputed({ ...invoice, creditedAmount });
  tx.set(
    invoicesCol(db, companyId).doc(invoice.id || invoice._id),
    { creditedAmount, status: computed.status, updatedAt: new Date().toISOString() },
    { merge: true }
  );
  return { creditedAmount, status: computed.status, outstanding: computed.outstanding };
}

async function loadInvoiceNotes(tx, db, companyId, invoiceId) {
  const invSnap = await tx.get(invoicesCol(db, companyId).doc(invoiceId));
  if (!invSnap.exists || invSnap.data().deletedAt) throw httpError(404, "Invoice not found");
  const invoice = { id: invSnap.id, ...invSnap.data() };
  const notesSnap = await tx.get(creditNotesCol(db, companyId).where("invoiceId", "==", invoiceId));
  const notes = notesSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((n) => !n.deletedAt);
  return { invoice, notes };
}

async function buildFromInvoice(companyId, body, existing = {}) {
  const { requireInvoice, loadCompany, loadLedgerCtx } = invoicesLib();
  const invoiceId = String(body.invoiceId || existing.invoiceId || "");
  if (!invoiceId) throw httpError(400, "A credit note must be linked to an invoice");
  const invoice = existing._invoice || (await requireInvoice(companyId, invoiceId));
  if (invoice.draft) throw httpError(409, "Publish the invoice before issuing a credit note");
  if (invoice.voided) throw httpError(409, "Cannot credit a void invoice");
  const company = await loadCompany(companyId);
  const items = await stampLineAccounts(
    companyId,
    body.items !== undefined ? body.items : existing.items || invoice.items || []
  );
  const vatRate =
    body.vatRate !== undefined
      ? company.vatRegistered
        ? Number(body.vatRate) || 0
        : 0
      : existing.vatRate ?? invoice.vatRate ?? companyVatRate(company);
  const totals = totalsFor(items, vatRate);
  if (roundMoney(totals.total) <= 0) throw httpError(400, "Credit note total must be greater than zero");
  const issueDate = toIsoDate(body.issueDate) || existing.issueDate || todayIso();
  return {
    invoice,
    company,
    ctx: await loadLedgerCtx(companyId),
    doc: {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber || "",
      customerId: invoice.customerId || "",
      customerName: invoice.customerName || "",
      customerSnapshot: invoice.customerSnapshot || null,
      billTo: invoice.billTo || invoice.customerName || "",
      currency: invoice.currency || "ZAR",
      exchangeRate: invoice.exchangeRate || null,
      issueDate,
      items,
      vatRate,
      ...totals,
      reason: String(body.reason !== undefined ? body.reason : existing.reason || "").slice(0, 500),
      notes: String(body.notes !== undefined ? body.notes : existing.notes || "").slice(0, 2000),
      footer: String(body.footer !== undefined ? body.footer : existing.footer || ""),
      appliedToInvoiceId: invoice.id,
    },
  };
}

async function createCreditNote(companyId, uid, email, role, body = {}) {
  assertCan(canWriteRecords, role);
  const db = getDb();
  const id = randomId();
  const now = new Date().toISOString();
  const draft = body.finalize === true ? false : body.draft === false ? false : true;
  const built = await buildFromInvoice(companyId, body);
  const doc = {
    creditNoteNumber: "",
    draft,
    voided: false,
    ...built.doc,
    issuer: null,
    createdAt: now,
    updatedAt: now,
    createdBy: uid,
  };

  if (draft) {
    await creditNotesCol(db, companyId).doc(id).set({ ...doc, status: "draft" });
  } else {
    await db.runTransaction(async (tx) => {
      const { invoice, notes } = await loadInvoiceNotes(tx, db, companyId, doc.invoiceId);
      if (doc.total > remainingOnInvoice(invoice, notes) + 0.001) {
        throw httpError(400, "Credit note cannot exceed the invoice's remaining outstanding balance");
      }
      const planned = await planNumber(tx, companyId, "creditNotes");
      doc.creditNoteNumber = planned.number;
      doc.issuer = issuerSnapshot(built.company, doc.currency);
      doc.finalizedAt = now;
      const posting = await planCreditNoteLedger(tx, companyId, {
        creditNoteId: id,
        doc,
        event: "post",
        createdBy: uid,
        currentLedger: null,
        postDate: doc.issueDate,
        ctx: built.ctx,
      });
      planned.commit(tx);
      const computed = withComputed(doc);
      tx.set(creditNotesCol(db, companyId).doc(id), { ...doc, status: computed.status, ledger: posting.ledger });
      await writeInvoiceCredits(tx, db, companyId, invoice, [...notes, { id, ...doc }]);
      posting.commit(tx);
      doc.ledger = posting.ledger;
    });
    await ensureGoLiveDate(companyId);
  }

  await logAudit({
    companyId,
    uid,
    email,
    action: "creditNote.create",
    payload: { creditNoteId: id, creditNoteNumber: doc.creditNoteNumber, invoiceId: doc.invoiceId, draft, total: doc.total },
  });
  return withComputed({ id, ...doc });
}

async function updateCreditNote(companyId, uid, email, role, id, body = {}) {
  assertCan(canWriteRecords, role);
  const existing = await requireCreditNote(companyId, id);
  if (existing.voided) throw httpError(409, "Void credit notes cannot be edited");
  const db = getDb();
  const now = new Date().toISOString();
  const built = await buildFromInvoice(companyId, { ...body, invoiceId: existing.invoiceId }, existing);
  const patch = { ...built.doc, updatedAt: now };
  const wantFinalize = existing.draft && (body.finalize === true || body.draft === false);
  if (wantFinalize) {
    patch.draft = false;
    patch.issuer = issuerSnapshot(built.company, built.doc.currency);
    patch.finalizedAt = now;
  } else if (!existing.draft) {
    // Published notes can have items/reason edited; ledger is reversed and re-posted.
  }

  const merged = { ...existing, ...patch };
  if (existing.draft && !wantFinalize) {
    await creditNotesCol(db, companyId).doc(id).set({ ...patch, status: "draft" }, { merge: true });
  } else {
    await db.runTransaction(async (tx) => {
      const { invoice, notes } = await loadInvoiceNotes(tx, db, companyId, existing.invoiceId);
      const others = notes.filter((n) => n.id !== id);
      if (merged.total > remainingOnInvoice(invoice, others) + 0.001) {
        throw httpError(400, "Credit note cannot exceed the invoice's remaining outstanding balance");
      }
      let commitNumber = null;
      if (wantFinalize && !merged.creditNoteNumber) {
        const planned = await planNumber(tx, companyId, "creditNotes");
        patch.creditNoteNumber = planned.number;
        merged.creditNoteNumber = planned.number;
        commitNumber = planned.commit;
      }
      const posting = await planCreditNoteLedger(tx, companyId, {
        creditNoteId: id,
        doc: merged,
        event: wantFinalize ? "post" : "edit",
        createdBy: uid,
        currentLedger: wantFinalize ? null : existing.ledger,
        reverseDate: existing.issueDate,
        postDate: merged.issueDate,
        ctx: built.ctx,
      });
      if (commitNumber) commitNumber(tx);
      const computed = withComputed(merged);
      tx.set(creditNotesCol(db, companyId).doc(id), { ...patch, status: computed.status, ledger: posting.ledger }, { merge: true });
      await writeInvoiceCredits(tx, db, companyId, invoice, [...others, { id, ...merged, draft: false, voided: false }]);
      posting.commit(tx);
      merged.ledger = posting.ledger;
    });
    await ensureGoLiveDate(companyId);
  }

  await logAudit({
    companyId,
    uid,
    email,
    action: wantFinalize ? "creditNote.finalize" : "creditNote.update",
    payload: { creditNoteId: id, creditNoteNumber: merged.creditNoteNumber, total: merged.total },
  });
  return withComputed(merged);
}

async function finalizeCreditNote(companyId, uid, email, role, id) {
  const existing = await requireCreditNote(companyId, id);
  if (!existing.draft) throw httpError(409, "Credit note is already published");
  return updateCreditNote(companyId, uid, email, role, id, { finalize: true });
}

async function voidCreditNote(companyId, uid, email, role, id, { reason = "" } = {}) {
  assertCan(canDeleteRecords, role);
  const existing = await requireCreditNote(companyId, id);
  if (existing.voided) throw httpError(409, "Credit note is already void");
  if (existing.draft) throw httpError(409, "Drafts can be deleted instead of voided");
  const db = getDb();
  const now = new Date().toISOString();
  const voidDate = todayIso();
  const patch = {
    voided: true,
    voidedAt: now,
    voidedBy: uid,
    voidReason: String(reason || "").slice(0, 500),
    status: "void",
    updatedAt: now,
  };
  const { loadLedgerCtx } = invoicesLib();
  const ctx = await loadLedgerCtx(companyId);
  await db.runTransaction(async (tx) => {
    const { invoice, notes } = await loadInvoiceNotes(tx, db, companyId, existing.invoiceId);
    const posting = await planCreditNoteLedger(tx, companyId, {
      creditNoteId: id,
      doc: existing,
      event: "void",
      createdBy: uid,
      currentLedger: existing.ledger,
      reverseDate: voidDate,
      ctx,
    });
    tx.set(creditNotesCol(db, companyId).doc(id), { ...patch, ledger: posting.ledger }, { merge: true });
    await writeInvoiceCredits(tx, db, companyId, invoice, notes.map((n) => (n.id === id ? { ...n, ...patch } : n)));
    posting.commit(tx);
  });
  await logAudit({
    companyId,
    uid,
    email,
    action: "creditNote.void",
    payload: { creditNoteId: id, creditNoteNumber: existing.creditNoteNumber, reason: patch.voidReason },
  });
  return withComputed({ ...existing, ...patch });
}

async function deleteCreditNote(companyId, uid, email, role, id) {
  assertCan(canDeleteRecords, role);
  const existing = await requireCreditNote(companyId, id);
  const db = getDb();
  const shouldReverse = !existing.draft && !existing.voided && existing.ledger?.entryId;
  if (shouldReverse) {
    const { loadLedgerCtx } = invoicesLib();
    const ctx = await loadLedgerCtx(companyId);
    await db.runTransaction(async (tx) => {
      const { invoice, notes } = await loadInvoiceNotes(tx, db, companyId, existing.invoiceId);
      const posting = await planCreditNoteLedger(tx, companyId, {
        creditNoteId: id,
        doc: existing,
        event: "delete",
        createdBy: uid,
        currentLedger: existing.ledger,
        reverseDate: existing.issueDate,
        ctx,
      });
      tx.set(creditNotesCol(db, companyId).doc(id), { ...deletion(uid), ledger: posting.ledger }, { merge: true });
      await writeInvoiceCredits(
        tx,
        db,
        companyId,
        invoice,
        notes.map((n) => (n.id === id ? { ...n, deletedAt: true } : n))
      );
      posting.commit(tx);
    });
  } else {
    await creditNotesCol(db, companyId).doc(id).set(deletion(uid), { merge: true });
  }
  await logAudit({
    companyId,
    uid,
    email,
    action: "creditNote.delete",
    payload: { creditNoteId: id, creditNoteNumber: existing.creditNoteNumber, draft: existing.draft },
  });
}

module.exports = {
  listCreditNotes,
  getCreditNote,
  requireCreditNote,
  countActiveCreditNotes,
  createCreditNote,
  updateCreditNote,
  finalizeCreditNote,
  voidCreditNote,
  deleteCreditNote,
  withComputed,
  sumCredits,
  planCreditNoteLedger,
  remainingOnInvoice,
  loadInvoiceNotes,
  writeInvoiceCredits,
};
