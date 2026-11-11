// Shared helpers for links between bank transactions and payments/expenses.
// Kept free of payments/expenses imports so those modules can call it.
const { getDb } = require("./firebase");
const { companyRef } = require("./refs");

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
  receivedRate: null,
  invoiceRate: null,
  zarAtInvoiceRate: null,
  forexGainZar: null,
  forexFlag: "",
};

const EXPENSE_LINK_CLEAR = { transactionId: "", bankAccountId: "" };

/** Put a bank line back to unreconciled (no-op if it no longer exists). */
async function releaseTransaction(companyId, transactionId) {
  if (!transactionId) return;
  const ref = txCol(companyId).doc(transactionId);
  const snap = await ref.get();
  if (!snap.exists) return;
  const tx = snap.data();
  await ref.set({ ...LINK_CLEAR, updatedAt: new Date().toISOString() }, { merge: true });
  if (tx.transferPairId) {
    const pairRef = txCol(companyId).doc(tx.transferPairId);
    const pair = await pairRef.get();
    if (pair.exists && pair.data().transferPairId === transactionId) {
      await pairRef.set({ ...LINK_CLEAR, updatedAt: new Date().toISOString() }, { merge: true });
    }
  }
}

module.exports = { LINK_CLEAR, PAYMENT_LINK_CLEAR, EXPENSE_LINK_CLEAR, releaseTransaction, txCol };
