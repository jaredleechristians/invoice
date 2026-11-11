// Bank accounts used for importing statements and reconciling (per company).
// Not the same as company.bankAccounts, which are the payment details printed on invoices.
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { canManageSettings, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { roundMoney, normalizeCurrency } = require("./money");
const { fetchAll } = require("./db");
const { toIsoDate } = require("./dates");

// Stable keys, stored on the account. South African banks (SARB register of
// locally controlled, foreign controlled and mutual banks, plus common
// business brands) alphabetically, then payment platforms, then Other.
const BANK_OPTIONS = [
  { value: "absa", label: "Absa" },
  { value: "access_bank", label: "Access Bank SA" },
  { value: "african_bank", label: "African Bank" },
  { value: "albaraka", label: "Albaraka Bank" },
  { value: "bank_zero", label: "Bank Zero" },
  { value: "bidvest_bank", label: "Bidvest Bank" },
  { value: "capitec", label: "Capitec Bank" },
  { value: "capitec_business", label: "Capitec Business (formerly Mercantile)" },
  { value: "discovery_bank", label: "Discovery Bank" },
  { value: "enl", label: "eNL Mutual Bank" },
  { value: "finbond", label: "Finbond Mutual Bank" },
  { value: "fnb", label: "FNB (First National Bank)" },
  { value: "gbs", label: "GBS Mutual Bank" },
  { value: "grindrod_bank", label: "Grindrod Bank" },
  { value: "habib", label: "Habib Overseas Bank" },
  { value: "hbz", label: "HBZ Bank" },
  { value: "investec", label: "Investec" },
  { value: "nedbank", label: "Nedbank" },
  { value: "old_mutual_bank", label: "Old Mutual Bank" },
  { value: "rmb", label: "RMB (Rand Merchant Bank)" },
  { value: "sasfin_bank", label: "Sasfin Bank" },
  { value: "standard_bank", label: "Standard Bank" },
  { value: "tymebank", label: "TymeBank" },
  { value: "ubank", label: "Ubank" },
  { value: "wise", label: "Wise" },
  { value: "paypal", label: "PayPal" },
  { value: "other", label: "Other" },
];
const BANKS = BANK_OPTIONS.map((b) => b.value);

// Older or hand-typed values mapped to a stable key.
const BANK_ALIASES = {
  "standard-bank": "standard_bank",
  standardbank: "standard_bank",
  "first-national-bank": "fnb",
  first_national_bank: "fnb",
  mercantile: "capitec_business",
  mercantile_bank: "capitec_business",
  gotyme: "tymebank",
  tyme_bank: "tymebank",
  om_bank: "old_mutual_bank",
};

/** Map a stored or submitted bank value to a known key ("other" if unknown). */
function normalizeBank(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (BANKS.includes(raw)) return raw;
  const key = raw.replace(/[\s-]+/g, "_");
  if (BANKS.includes(key)) return key;
  return BANK_ALIASES[raw] || BANK_ALIASES[key] || "other";
}

const accountsCol = (companyId) => companyRef(getDb(), companyId).collection("bankAccounts");
const txCol = (companyId) => companyRef(getDb(), companyId).collection("bankTransactions");

async function loadCompanyData(companyId) {
  const snap = await companyRef(getDb(), companyId).get();
  return snap.exists ? snap.data() : {};
}

function normalizeAccount(body, company, existing = {}) {
  const merged = { ...existing, ...body };
  const name = String(merged.name || "").trim().slice(0, 80);
  if (!name) throw httpError(400, "Account name is required");
  const last4 = String(merged.accountLast4 || "").replace(/\D/g, "").slice(-4);
  return {
    name,
    bank: normalizeBank(merged.bank),
    currency: normalizeCurrency(merged.currency, company?.defaultCurrency || "ZAR"),
    accountLast4: last4,
    openingBalance: roundMoney(merged.openingBalance || 0),
    openingDate: toIsoDate(merged.openingDate) || "",
  };
}

/** Balance = opening balance + lines dated on/after the opening date. Exported for tests. */
function accountBalance(account, transactions) {
  let bal = roundMoney(account.openingBalance || 0);
  let unreconciled = 0;
  let count = 0;
  let lastDate = "";
  for (const t of transactions) {
    if (t.accountId !== account.id) continue;
    count++;
    if (t.status === "unreconciled" || t.status === "processing") unreconciled++;
    if (t.date > lastDate) lastDate = t.date;
    if (account.openingDate && t.date < account.openingDate) continue;
    bal = roundMoney(bal + roundMoney(t.amount));
  }
  return { balance: bal, transactionCount: count, unreconciledCount: unreconciled, lastTransactionDate: lastDate };
}

async function listAccounts(companyId) {
  const [rows, txs] = await Promise.all([fetchAll(accountsCol(companyId)), fetchAll(txCol(companyId))]);
  return rows
    .map((a) => ({ ...a, bank: normalizeBank(a.bank), ...accountBalance(a, txs) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function getAccount(companyId, accountId) {
  if (!accountId) throw httpError(400, "Pick a bank account");
  const snap = await accountsCol(companyId).doc(String(accountId)).get();
  if (!snap.exists) throw httpError(404, "Bank account not found");
  const data = snap.data();
  return { id: snap.id, ...data, bank: normalizeBank(data.bank) };
}

async function createAccount(companyId, uid, email, role, body = {}) {
  assertCan(canManageSettings, role);
  const company = await loadCompanyData(companyId);
  const data = normalizeAccount(body, company);
  const id = randomId(8);
  const now = new Date().toISOString();
  const doc = { ...data, createdAt: now, updatedAt: now, createdBy: uid };
  await accountsCol(companyId).doc(id).set(doc);
  await logAudit({ companyId, uid, email, action: "bankAccount.create", payload: { id, name: data.name, currency: data.currency } });
  return { id, ...doc };
}

async function updateAccount(companyId, uid, email, role, accountId, body = {}) {
  assertCan(canManageSettings, role);
  const existing = await getAccount(companyId, accountId);
  const company = await loadCompanyData(companyId);
  const data = normalizeAccount(body, company, existing);
  if (data.currency !== existing.currency) {
    const used = await txCol(companyId).where("accountId", "==", accountId).limit(1).get();
    if (!used.empty) throw httpError(409, "Cannot change the currency after importing transactions");
  }
  const patch = { ...data, updatedAt: new Date().toISOString() };
  await accountsCol(companyId).doc(accountId).set(patch, { merge: true });
  await logAudit({ companyId, uid, email, action: "bankAccount.update", payload: { id: accountId } });
  return { ...existing, ...patch };
}

async function deleteAccount(companyId, uid, email, role, accountId) {
  assertCan(canManageSettings, role);
  const existing = await getAccount(companyId, accountId);
  const used = await txCol(companyId).where("accountId", "==", accountId).limit(1).get();
  if (!used.empty) throw httpError(409, "This account has transactions. Delete its imports first.");
  await accountsCol(companyId).doc(accountId).delete();
  await logAudit({ companyId, uid, email, action: "bankAccount.delete", payload: { id: accountId, name: existing.name } });
}

module.exports = { BANKS, BANK_OPTIONS, normalizeBank, listAccounts, getAccount, createAccount, updateAccount, deleteAccount, accountBalance };
