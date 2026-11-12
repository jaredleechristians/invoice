const { deletion, deletedSnap } = require("./softDelete");
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { canWriteRecords, canDeleteRecords, canManageSettings, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { roundMoney, normalizeCurrency } = require("./money");
const { fetchAll } = require("./db");
const { toIsoDate, todayIso, inRange } = require("./dates");
const { releaseTransaction, txCol } = require("./bankLinks");
const { resolveExpenseAccount, defaultExpenseAccountId, ensureChart, bankLedgerId } = require("./ledger/accounts");
const { cleanExchangeRate } = require("./documents");
const { expenseLines, expenseBankLines } = require("./ledger/rules");
const { planPost, planReverse, sourceKey, nextVersion, ensureGoLiveDate, systemAccountsOf, baseCurrencyOf } = require("./ledger/post");
const { planBankEntry } = require("./ledger/bankPost");

// Receipts are stored in Firestore (separate doc) to avoid new infra; keep them small.
const MAX_RECEIPT_BYTES = 700 * 1024;
const RECEIPT_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/heic", "image/gif"];

const DEFAULT_CATEGORIES = [
  "Advertising & marketing",
  "Bank charges",
  "Contractors",
  "Equipment",
  "Hosting & domains",
  "Office & supplies",
  "Professional fees",
  "Software & subscriptions",
  "Telephone & internet",
  "Travel",
  "Other",
];

const expensesCol = (companyId) => companyRef(getDb(), companyId).collection("expenses");
const categoriesCol = (companyId) => companyRef(getDb(), companyId).collection("expenseCategories");
const receiptsCol = (companyId) => companyRef(getDb(), companyId).collection("expenseReceipts");

// ---------- categories ----------

async function listCategories(companyId, { seed = true } = {}) {
  let rows = await fetchAll(categoriesCol(companyId));
  if (!rows.length && seed) {
    const db = getDb();
    const batch = db.batch();
    const now = new Date().toISOString();
    rows = DEFAULT_CATEGORIES.map((name) => ({ id: randomId(8), name, accountId: defaultExpenseAccountId(name), createdAt: now }));
    for (const r of rows) batch.set(categoriesCol(companyId).doc(r.id), { name: r.name, accountId: r.accountId, createdAt: now });
    await batch.commit();
  }
  // Categories from before 1.4.0 have no account yet: show the template default.
  rows = rows.map((c) => ({ ...c, accountId: c.accountId || defaultExpenseAccountId(c.name) }));
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

function cleanCategoryName(name) {
  const n = String(name || "").trim().slice(0, 80);
  if (!n) throw httpError(400, "Category name is required");
  return n;
}

async function createCategory(companyId, uid, email, role, body = {}) {
  assertCan(canWriteRecords, role);
  const name = cleanCategoryName(body.name);
  const existing = await listCategories(companyId, { seed: false });
  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw httpError(409, "Category already exists");
  const id = randomId(8);
  const accountId = await resolveExpenseAccount(companyId, String(body.accountId || ""), name);
  const doc = { name, accountId, createdAt: new Date().toISOString() };
  await categoriesCol(companyId).doc(id).set(doc);
  await logAudit({ companyId, uid, email, action: "expenseCategory.create", payload: { id, name } });
  return { id, ...doc };
}

async function updateCategory(companyId, uid, email, role, categoryId, body = {}) {
  assertCan(canManageSettings, role);
  const ref = categoriesCol(companyId).doc(categoryId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Category not found");
  const prev = snap.data();
  const name = body.name !== undefined ? cleanCategoryName(body.name) : prev.name;
  const patch = { name, updatedAt: new Date().toISOString() };
  if (body.accountId !== undefined || !prev.accountId) {
    patch.accountId = await resolveExpenseAccount(companyId, String(body.accountId || prev.accountId || ""), name);
  }
  await ref.set(patch, { merge: true });
  await logAudit({ companyId, uid, email, action: "expenseCategory.update", payload: { id: categoryId, ...patch } });
  if (name === prev.name) return { id: categoryId, ...prev, ...patch };
  // Keep the denormalised name on expenses in sync.
  const used = await fetchAll(expensesCol(companyId).where("categoryId", "==", categoryId));
  const db = getDb();
  for (let i = 0; i < used.length; i += 400) {
    const batch = db.batch();
    for (const e of used.slice(i, i + 400)) batch.set(expensesCol(companyId).doc(e.id), { categoryName: name }, { merge: true });
    await batch.commit();
  }
  return { id: categoryId, ...prev, ...patch };
}

async function deleteCategory(companyId, uid, email, role, categoryId) {
  assertCan(canManageSettings, role);
  const used = await fetchAll(expensesCol(companyId).where("categoryId", "==", categoryId));
  if (used.length) throw httpError(409, "Category is used by expenses; rename it or move those expenses first");
  const ref = categoriesCol(companyId).doc(categoryId);
  if (deletedSnap(await ref.get())) throw httpError(404, "Category not found");
  await ref.set(deletion(uid), { merge: true });
  await logAudit({ companyId, uid, email, action: "expenseCategory.delete", payload: { id: categoryId } });
}

// ---------- expenses ----------

async function normalizeExpense(companyId, body, company) {
  const amount = roundMoney(body.amount);
  if (!(amount > 0)) throw httpError(400, "Amount must be greater than zero");
  const date = toIsoDate(body.date) || todayIso();
  let categoryId = String(body.categoryId || "");
  let categoryName = "";
  let accountId = "";
  if (categoryId) {
    const snap = await categoriesCol(companyId).doc(categoryId).get();
    if (deletedSnap(snap)) throw httpError(400, "Unknown expense category");
    categoryName = snap.data().name;
    accountId = snap.data().accountId || defaultExpenseAccountId(categoryName);
  } else {
    categoryName = "Uncategorised";
    accountId = defaultExpenseAccountId(categoryName);
  }
  const currency = normalizeCurrency(body.currency, company?.defaultCurrency || "ZAR");
  const base = company?.baseCurrency || "ZAR";
  const exchangeRate = currency === base ? null : cleanExchangeRate(body.exchangeRate);
  if (currency !== base && !exchangeRate) {
    throw httpError(400, "An exchange rate is required for a foreign-currency expense");
  }
  return {
    date,
    vendor: String(body.vendor || "").trim().slice(0, 200),
    categoryId,
    categoryName,
    accountId,
    amount,
    currency,
    exchangeRate,
    reference: String(body.reference || "").trim().slice(0, 120),
    notes: String(body.notes || "").trim().slice(0, 2000),
  };
}

async function loadLedgerCtx(companyId) {
  await ensureChart(companyId);
  const company = await loadCompanyData(companyId);
  return { company, baseCurrency: baseCurrencyOf(company), systemAccounts: systemAccountsOf(company) };
}

function expenseFingerprint(e) {
  return JSON.stringify({
    date: e.date,
    amount: e.amount,
    currency: e.currency,
    exchangeRate: e.exchangeRate || null,
    accountId: e.accountId || "",
    categoryId: e.categoryId || "",
  });
}

async function planExpenseLedger(tx, companyId, { expenseId, doc, event, createdBy, currentLedger, reverseDate, ctx }) {
  let reverse = { commit() {} };
  if (currentLedger?.entryId && event !== "post") {
    reverse = await planReverse(tx, companyId, {
      entryId: currentLedger.entryId,
      date: reverseDate || doc.date,
      event,
      createdBy,
    });
  }
  const shouldPost = event === "post" || event === "edit" || event === "restore";
  let post = { commit() {}, id: null, skipped: true };
  let ledger = currentLedger || null;
  if (shouldPost) {
    const lines = expenseLines(doc, ctx);
    const version = currentLedger?.entryId ? nextVersion(currentLedger) : 1;
    post = await planPost(tx, companyId, {
      sourceKey: sourceKey("expense", expenseId, version),
      date: doc.date,
      lines,
      source: { type: "expense", id: expenseId, number: doc.vendor || "", event, version },
      memo: doc.vendor || "Expense",
      createdBy,
      baseCurrency: ctx.baseCurrency,
    });
    ledger = { entryId: post.id, version };
  }
  return {
    ledger,
    commit(writeTx) {
      reverse.commit(writeTx);
      post.commit(writeTx);
    },
  };
}

async function loadCompanyData(companyId) {
  const snap = await companyRef(getDb(), companyId).get();
  return snap.exists ? snap.data() : {};
}

async function listExpenses(companyId, { from, to, categoryId, currency, q } = {}) {
  let rows = await fetchAll(expensesCol(companyId));
  rows = rows.filter((e) => inRange(e.date, from, to));
  if (categoryId) rows = rows.filter((e) => e.categoryId === categoryId);
  if (currency) rows = rows.filter((e) => e.currency === currency);
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((e) => e.vendor?.toLowerCase().includes(needle) || e.notes?.toLowerCase().includes(needle));
  }
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function getExpense(companyId, expenseId) {
  const snap = await expensesCol(companyId).doc(expenseId).get();
  if (deletedSnap(snap)) throw httpError(404, "Expense not found");
  return { id: snap.id, ...snap.data() };
}

function decodeReceipt(receipt) {
  if (!receipt) return null;
  const contentType = String(receipt.contentType || "");
  if (!RECEIPT_TYPES.includes(contentType)) throw httpError(400, "Receipt must be a PDF or image");
  const data = String(receipt.dataBase64 || "").replace(/^data:[^,]+,/, "");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(data)) throw httpError(400, "Receipt data must be base64");
  const size = Buffer.from(data, "base64").length;
  if (!size) throw httpError(400, "Receipt is empty");
  if (size > MAX_RECEIPT_BYTES) throw httpError(400, "Receipt must be 700 KB or smaller (compress or photograph at lower resolution)");
  return { dataBase64: data.replace(/\s+/g, ""), contentType, filename: String(receipt.filename || "receipt").slice(0, 120), size };
}

async function planExpenseBankPost(tx, companyId, { expenseId, expense, bankTx, bankAccount, event, createdBy, ctx, created }) {
  if (!bankTx || !bankAccount) return { commit() {}, ledger: expense.bankLedger || null, patch: null };
  const lines = expenseBankLines(expense, bankTx, {
    systemAccounts: ctx.systemAccounts,
    baseCurrency: ctx.baseCurrency,
    bankLedgerAccountId: bankLedgerId(bankAccount.id),
    bankAccountId: bankAccount.id,
    bankCurrency: bankAccount.currency || bankTx.currency,
  });
  const planned = await planBankEntry(tx, companyId, {
    type: "expense_bank",
    id: expenseId,
    date: bankTx.date || expense.date,
    lines,
    event,
    createdBy,
    memo: expense.vendor || "Expense",
    number: expense.vendor || "",
    currentLedger: expense.bankLedger,
    ctx,
  });
  const patch = {
    status: "categorised",
    expenseId,
    matchLabel: [expense.vendor, expense.categoryName].filter(Boolean).join(" - "),
    created: created || null,
    ledger: planned.ledger,
    reconciledAt: new Date().toISOString(),
    reconciledBy: createdBy,
    updatedAt: new Date().toISOString(),
  };
  return {
    ledger: planned.ledger,
    patch,
    commit(writeTx) {
      planned.commit(writeTx);
      writeTx.set(txCol(companyId).doc(bankTx.id), patch, { merge: true });
    },
  };
}

async function createExpense(companyId, uid, email, role, body = {}, extra = {}) {
  assertCan(canWriteRecords, role);
  const company = await loadCompanyData(companyId);
  const data = await normalizeExpense(companyId, body, company);
  const receipt = decodeReceipt(body.receipt);
  const id = randomId();
  const now = new Date().toISOString();
  const doc = {
    ...data,
    receipt: receipt ? { filename: receipt.filename, contentType: receipt.contentType, size: receipt.size } : null,
    createdAt: now,
    updatedAt: now,
    createdBy: uid,
    ...(extra.transactionId ? { transactionId: extra.transactionId, bankAccountId: extra.bankAccountId || "" } : {}),
  };
  const ctx = await loadLedgerCtx(companyId);
  const db = getDb();
  let transaction = null;
  await db.runTransaction(async (tx) => {
    const posting = await planExpenseLedger(tx, companyId, {
      expenseId: id,
      doc,
      event: "post",
      createdBy: uid,
      currentLedger: null,
      ctx,
    });
    doc.ledger = posting.ledger;
    let bankPost = { commit() {}, patch: null };
    if (extra.transactionId) {
      const bankSnap = await tx.get(txCol(companyId).doc(extra.transactionId));
      if (!bankSnap.exists) throw httpError(404, "Bank transaction not found");
      const bankAccountId = extra.bankAccountId || bankSnap.data().accountId;
      const accountSnap = await tx.get(companyRef(db, companyId).collection("bankAccounts").doc(bankAccountId));
      if (!accountSnap.exists) throw httpError(404, "Bank account not found");
      bankPost = await planExpenseBankPost(tx, companyId, {
        expenseId: id,
        expense: doc,
        bankTx: { id: bankSnap.id, ...bankSnap.data() },
        bankAccount: { id: accountSnap.id, ...accountSnap.data() },
        event: "post",
        createdBy: uid,
        ctx,
        created: { type: "expense", id },
      });
      doc.bankLedger = bankPost.ledger;
      transaction = { id: extra.transactionId, ...bankPost.patch };
    }
    tx.set(expensesCol(companyId).doc(id), doc);
    if (receipt) tx.set(receiptsCol(companyId).doc(id), { ...receipt, uploadedAt: now });
    posting.commit(tx);
    bankPost.commit(tx);
  });
  await ensureGoLiveDate(companyId);
  await logAudit({ companyId, uid, email, action: "expense.create", payload: { expenseId: id, amount: data.amount, currency: data.currency } });
  return { id, ...doc, transaction };
}

async function updateExpense(companyId, uid, email, role, expenseId, body = {}) {
  assertCan(canWriteRecords, role);
  const existing = await getExpense(companyId, expenseId);
  const company = await loadCompanyData(companyId);
  const data = await normalizeExpense(companyId, { ...existing, ...body }, company);
  const now = new Date().toISOString();
  const patch = { ...data, updatedAt: now };
  const receiptChange = body.receipt !== undefined ? decodeReceipt(body.receipt) : undefined;
  if (receiptChange !== undefined) {
    if (receiptChange) patch.receipt = { filename: receiptChange.filename, contentType: receiptChange.contentType, size: receiptChange.size };
    else patch.receipt = null;
  }
  const merged = { ...existing, ...patch };
  const shouldPost = expenseFingerprint(existing) !== expenseFingerprint(merged);
  const ctx = shouldPost ? await loadLedgerCtx(companyId) : null;
  const db = getDb();
  await db.runTransaction(async (tx) => {
    let posting = { ledger: existing.ledger, commit() {} };
    if (shouldPost) {
      posting = await planExpenseLedger(tx, companyId, {
        expenseId,
        doc: merged,
        event: "edit",
        createdBy: uid,
        currentLedger: existing.ledger,
        reverseDate: existing.date,
        ctx,
      });
      patch.ledger = posting.ledger;
      merged.ledger = posting.ledger;
    }
    if (receiptChange !== undefined) {
      if (receiptChange) tx.set(receiptsCol(companyId).doc(expenseId), { ...receiptChange, uploadedAt: now });
      else tx.delete(receiptsCol(companyId).doc(expenseId));
    }
    tx.set(expensesCol(companyId).doc(expenseId), patch, { merge: true });
    posting.commit(tx);
  });
  if (shouldPost) await ensureGoLiveDate(companyId);
  await logAudit({ companyId, uid, email, action: "expense.update", payload: { expenseId } });
  return { ...existing, ...patch };
}

async function deleteExpense(companyId, uid, email, role, expenseId) {
  assertCan(canDeleteRecords, role);
  const existing = await getExpense(companyId, expenseId);
  const db = getDb();
  const gone = { ...deletion(uid), transactionId: "", bankAccountId: "", bankLedger: { entryId: null, version: Number(existing.bankLedger?.version) || 0 } };
  if (existing.ledger?.entryId) {
    const ctx = await loadLedgerCtx(companyId);
    await db.runTransaction(async (tx) => {
      const posting = await planExpenseLedger(tx, companyId, {
        expenseId,
        doc: existing,
        event: "delete",
        createdBy: uid,
        currentLedger: existing.ledger,
        reverseDate: existing.date,
        ctx,
      });
      tx.set(expensesCol(companyId).doc(expenseId), { ...gone, ledger: posting.ledger }, { merge: true });
      posting.commit(tx);
    });
  } else {
    await expensesCol(companyId).doc(expenseId).set(gone, { merge: true });
  }
  if (existing.transactionId) await releaseTransaction(companyId, existing.transactionId, { createdBy: uid });
  await logAudit({ companyId, uid, email, action: "expense.delete", payload: { expenseId, amount: existing.amount, currency: existing.currency } });
}

async function getReceipt(companyId, expenseId) {
  await getExpense(companyId, expenseId);
  const snap = await receiptsCol(companyId).doc(expenseId).get();
  if (!snap.exists) throw httpError(404, "No receipt attached");
  const r = snap.data();
  return { buffer: Buffer.from(r.dataBase64, "base64"), contentType: r.contentType, filename: r.filename };
}

module.exports = {
  DEFAULT_CATEGORIES,
  MAX_RECEIPT_BYTES,
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  listExpenses,
  getExpense,
  createExpense,
  updateExpense,
  deleteExpense,
  planExpenseBankPost,
  getReceipt,
  decodeReceipt,
  planExpenseLedger,
  loadLedgerCtx,
};
