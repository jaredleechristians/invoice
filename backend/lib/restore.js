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
    const { applyPaymentChange } = require("./payments");
    const inv = await companyRef(db, companyId).collection("invoices").doc(data.invoiceId).get();
    if (!inv.exists || inv.data().deletedAt) throw httpError(409, "Restore the invoice first");
    await applyPaymentChange(db, companyId, data.invoiceId, ({ payments, tx }) => {
      tx.set(ref, patch, { merge: true });
      return { payments: payments.map((p) => (p.id === snap.id ? { ...p, ...patch } : p)) };
    });
  } else {
    await ref.set(patch, { merge: true });
  }
  if (kind === "bankAccount") await require("./ledger/accounts").ensureChart(companyId, { linkBanks: true });
  await logAudit({ companyId, uid, email, action: `${kind}.restore`, payload: { id: snap.id } });
  return { id: snap.id, restored: true };
}

module.exports = { restoreRecord, RESTORE_KINDS: Object.keys(KINDS) };
