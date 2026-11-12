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
const { releaseTransaction } = require("./bankLinks");
const { resolveExpenseAccount, defaultExpenseAccountId } = require("./ledger/accounts");

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
  if (categoryId) {
    const snap = await categoriesCol(companyId).doc(categoryId).get();
    if (deletedSnap(snap)) throw httpError(400, "Unknown expense category");
    categoryName = snap.data().name;
  } else {
    categoryName = "Uncategorised";
  }
  return {
    date,
    vendor: String(body.vendor || "").trim().slice(0, 200),
    categoryId,
    categoryName,
    amount,
    currency: normalizeCurrency(body.currency, company?.defaultCurrency || "ZAR"),
    reference: String(body.reference || "").trim().slice(0, 120),
    notes: String(body.notes || "").trim().slice(0, 2000),
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

async function createExpense(companyId, uid, email, role, body = {}) {
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
  };
  const db = getDb();
  const batch = db.batch();
  batch.set(expensesCol(companyId).doc(id), doc);
  if (receipt) batch.set(receiptsCol(companyId).doc(id), { ...receipt, uploadedAt: now });
  await batch.commit();
  await logAudit({ companyId, uid, email, action: "expense.create", payload: { expenseId: id, amount: data.amount, currency: data.currency } });
  return { id, ...doc };
}

async function updateExpense(companyId, uid, email, role, expenseId, body = {}) {
  assertCan(canWriteRecords, role);
  const existing = await getExpense(companyId, expenseId);
  const company = await loadCompanyData(companyId);
  const data = await normalizeExpense(companyId, { ...existing, ...body }, company);
  const now = new Date().toISOString();
  const patch = { ...data, updatedAt: now };
  const db = getDb();
  const batch = db.batch();
  if (body.receipt !== undefined) {
    const receipt = decodeReceipt(body.receipt);
    if (receipt) {
      patch.receipt = { filename: receipt.filename, contentType: receipt.contentType, size: receipt.size };
      batch.set(receiptsCol(companyId).doc(expenseId), { ...receipt, uploadedAt: now });
    } else {
      patch.receipt = null;
      batch.delete(receiptsCol(companyId).doc(expenseId));
    }
  }
  batch.set(expensesCol(companyId).doc(expenseId), patch, { merge: true });
  await batch.commit();
  await logAudit({ companyId, uid, email, action: "expense.update", payload: { expenseId } });
  return { ...existing, ...patch };
}

async function deleteExpense(companyId, uid, email, role, expenseId) {
  assertCan(canDeleteRecords, role);
  const existing = await getExpense(companyId, expenseId);
  const db = getDb();
  const batch = db.batch();
  // Soft delete; the receipt is kept with it (and hidden, since the expense 404s).
  batch.set(expensesCol(companyId).doc(expenseId), { ...deletion(uid), transactionId: "", bankAccountId: "" }, { merge: true });
  await batch.commit();
  if (existing.transactionId) await releaseTransaction(companyId, existing.transactionId);
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
  getReceipt,
  decodeReceipt,
};
