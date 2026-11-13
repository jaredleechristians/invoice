/** Undo a soft delete (owners/admins). Bank imports can't be restored; import the file again. */
const { getDb } = require("./firebase");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { logAudit } = require("./audit");
const { assertCan, canDeleteRecords, canManageSettings } = require("./permissions");
const { RESTORE } = require("./softDelete");

const KINDS = {
  invoice: "invoices",
  quote: "quotes",
  customer: "customers",
  product: "products",
  expense: "expenses",
  payment: "payments",
  expenseCategory: "expenseCategories",
  bankAccount: "bankAccounts",
  creditNote: "creditNotes",
  timeEntry: "timeEntries",
};

async function restoreRecord(companyId, uid, email, role, kind, id) {
  const collection = KINDS[kind];
  if (!collection) throw httpError(400, `kind must be one of ${Object.keys(KINDS).join(", ")}`);
  assertCan(kind === "bankAccount" || kind === "expenseCategory" ? canManageSettings : canDeleteRecords, role);
  const db = getDb();
  const ref = companyRef(db, companyId).collection(collection).doc(String(id || ""));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "Not found");
  const data = snap.data();
  if (!data.deletedAt) return { id: snap.id, restored: false };
  const patch = { ...RESTORE, restoredAt: new Date().toISOString(), restoredBy: uid };
  if (kind === "payment") {
    const { applyPaymentChange, planPaymentPost } = require("./payments");
    const { loadLedgerCtx } = require("./invoices");
    const inv = await companyRef(db, companyId).collection("invoices").doc(data.invoiceId).get();
    if (!inv.exists || inv.data().deletedAt) throw httpError(409, "Restore the invoice first");
    const ctx = await loadLedgerCtx(companyId);
    const shouldPost = !data.voided;
    await applyPaymentChange(
      db,
      companyId,
      data.invoiceId,
      ({ payments, tx, posting }) => {
        const next = posting ? { ...patch, ledger: posting.ledger } : patch;
        tx.set(ref, next, { merge: true });
        posting?.commit(tx);
        return { payments: payments.map((p) => (p.id === snap.id ? { ...p, ...patch } : p)) };
      },
      async (tx, { invoice }) => {
        if (!shouldPost) return { posting: null };
        return {
          posting: await planPaymentPost(tx, companyId, {
            paymentId: snap.id,
            payment: { ...data, ...patch },
            invoice,
            event: "restore",
            createdBy: uid,
            currentLedger: data.ledger,
            ctx,
          }),
        };
      }
    );
  } else if (kind === "invoice" && !data.draft && !data.voided) {
    const invoices = require("./invoices");
    const ctx = await invoices.loadLedgerCtx(companyId);
    await db.runTransaction(async (tx) => {
      const posting = await invoices.planInvoiceLedger(tx, companyId, {
        invoiceId: snap.id,
        doc: { id: snap.id, ...data, ...patch },
        event: "restore",
        createdBy: uid,
        currentLedger: data.ledger,
        reverseDate: data.issueDate,
        postDate: data.issueDate,
        ctx,
      });
      const timeEntries = require("./timeEntries");
      const preparedTime = await timeEntries.prepareInvoiceTimeEntries(tx, db, companyId, snap.id, {
        items: data.items,
        customerId: data.customerId,
      });
      tx.set(ref, { ...patch, ledger: posting.ledger }, { merge: true });
      posting.commit(tx);
      timeEntries.commitInvoiceTimeEntries(tx, snap.id, preparedTime, { billed: true, customerId: data.customerId });
    });
  } else if (kind === "creditNote") {
    const creditNotes = require("./creditNotes");
    const invoices = require("./invoices");
    const inv = await companyRef(db, companyId).collection("invoices").doc(data.invoiceId).get();
    if (!inv.exists || inv.data().deletedAt) throw httpError(409, "Restore the invoice first");
    const shouldPost = !data.draft && !data.voided;
    const ctx = shouldPost ? await invoices.loadLedgerCtx(companyId) : null;
    await db.runTransaction(async (tx) => {
      const { invoice, notes } = await creditNotes.loadInvoiceNotes(tx, db, companyId, data.invoiceId);
      const restored = { id: snap.id, ...data, ...patch, deletedAt: null, deletedBy: null };
      const others = notes.filter((n) => n.id !== snap.id);
      if (shouldPost && restored.total > creditNotes.remainingOnInvoice(invoice, others) + 0.001) {
        throw httpError(409, "Restoring this credit note would exceed the invoice's remaining outstanding balance");
      }
      let posting = { commit() {}, ledger: data.ledger };
      if (shouldPost) {
        posting = await creditNotes.planCreditNoteLedger(tx, companyId, {
          creditNoteId: snap.id,
          doc: restored,
          event: "restore",
          createdBy: uid,
          currentLedger: data.ledger,
          postDate: data.issueDate,
          ctx,
        });
      }
      tx.set(ref, { ...patch, ledger: posting.ledger || data.ledger }, { merge: true });
      await creditNotes.writeInvoiceCredits(tx, db, companyId, invoice, [...others, restored]);
      posting.commit(tx);
    });
  } else if (kind === "expense") {
    const expenses = require("./expenses");
    const ctx = await expenses.loadLedgerCtx(companyId);
    await db.runTransaction(async (tx) => {
      const posting = await expenses.planExpenseLedger(tx, companyId, {
        expenseId: snap.id,
        doc: { id: snap.id, ...data, ...patch },
        event: "restore",
        createdBy: uid,
        currentLedger: data.ledger,
        reverseDate: data.date,
        ctx,
      });
      tx.set(ref, { ...patch, ledger: posting.ledger }, { merge: true });
      posting.commit(tx);
    });
  } else {
    await ref.set(patch, { merge: true });
    if (kind === "invoice") {
      const timeEntries = require("./timeEntries");
      if (timeEntries.entryIdsFromItems(data.items).length) {
        await timeEntries.runWithTx((tx, tdb) =>
          timeEntries.syncInvoiceTimeEntries(tx, tdb, companyId, snap.id, {
            items: data.items,
            billed: !data.draft && !data.voided,
            customerId: data.customerId,
          })
        );
      }
    }
  }
  if (kind === "bankAccount") await require("./ledger/accounts").ensureChart(companyId, { linkBanks: true });
  await logAudit({ companyId, uid, email, action: `${kind}.restore`, payload: { id: snap.id } });
  return { id: snap.id, restored: true };
}

module.exports = { restoreRecord, RESTORE_KINDS: Object.keys(KINDS) };
