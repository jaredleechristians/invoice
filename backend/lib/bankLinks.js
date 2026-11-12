// Shared helpers for links between bank transactions and payments/expenses.
// Kept free of payments/expenses imports so those modules can call it.
const { getDb } = require("./firebase");
const { companyRef } = require("./refs");
const { planReverse } = require("./ledger/post");

const txCol = (companyId) => companyRef(getDb(), companyId).collection("bankTransactions");

/** Fields cleared when a bank line goes back to unreconciled. */
const LINK_CLEAR = {
  status: "unreconciled",
  paymentId: "",
  invoiceId: "",
  invoiceNumber: "",
  expenseId: "",
  transferPairId: "",
  created: null,
  matchLabel: "",
  note: "",
  reconciledAt: "",
  reconciledBy: "",
};

/** Fields cleared on a payment when it is unlinked from a bank line. */
const PAYMENT_LINK_CLEAR = {
  transactionId: "",
  bankAccountId: "",
  receivedAmount: null,
  receivedCurrency: "",
  zarReceived: null,
  baseReceived: null,
  receivedRate: null,
  invoiceRate: null,
  zarAtInvoiceRate: null,
  baseAtInvoiceRate: null,
  forexGainZar: null,
  forexGainBase: null,
  forexFlag: "",
};

const EXPENSE_LINK_CLEAR = { transactionId: "", bankAccountId: "" };

function clearedLedger(existing) {
  return { entryId: null, version: Number(existing?.ledger?.version) || 0 };
}

/**
 * Put a bank line back to unreconciled and reverse its bank journal (and its
 * transfer pair, if any). No-op if the line no longer exists. Idempotent.
 */
async function releaseTransaction(companyId, transactionId, { createdBy } = {}) {
  if (!transactionId) return;
  const db = getDb();
  await db.runTransaction(async (tx) => {
    const ref = txCol(companyId).doc(String(transactionId));
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const data = snap.data();
    const pairId = data.transferPairId;
    let pairRef = null;
    let pairData = null;
    if (pairId) {
      pairRef = txCol(companyId).doc(pairId);
      const pairSnap = await tx.get(pairRef);
      if (pairSnap.exists && pairSnap.data().transferPairId === snap.id) {
        pairData = pairSnap.data();
      }
    }
    const reverses = [];
    const seen = new Set();
    const queue = [data.ledger?.entryId, pairData?.ledger?.entryId].filter(Boolean);
    for (const entryId of queue) {
      if (seen.has(entryId)) continue;
      seen.add(entryId);
      reverses.push(await planReverse(tx, companyId, {
        entryId,
        date: data.date,
        event: "undo",
        createdBy: createdBy || "",
      }));
    }
    const now = new Date().toISOString();
    for (const planned of reverses) planned.commit(tx);
    tx.set(ref, { ...LINK_CLEAR, ledger: clearedLedger(data), updatedAt: now }, { merge: true });
    if (pairRef && pairData) {
      tx.set(pairRef, { ...LINK_CLEAR, ledger: clearedLedger({ ledger: pairData.ledger }), updatedAt: now }, { merge: true });
    }
  });
}

module.exports = { LINK_CLEAR, PAYMENT_LINK_CLEAR, EXPENSE_LINK_CLEAR, releaseTransaction, txCol, clearedLedger };
