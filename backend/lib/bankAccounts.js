// Bank accounts (per company): the single source for statement imports and
// reconciling, and for the payment details printed on invoices, quotes and
// statements (accounts with showOnInvoices). The old company.bankAccounts
// text field is migrated into this collection once and then left untouched.
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { canManageSettings, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { roundMoney, normalizeCurrency } = require("./money");
const { fetchAll } = require("./db");
const { toIsoDate } = require("./dates");
const crypto = require("crypto");
const { ensureChart } = require("./ledger/accounts");

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

const clip = (v, max) => String(v ?? "").trim().slice(0, max);

function normalizeAccount(body, company, existing = {}) {
  const merged = { ...existing, ...body };
  const name = clip(merged.name, 80);
  if (!name) throw httpError(400, "Account name is required");
  const accountNumber = clip(merged.accountNumber, 40);
  const last4 = (accountNumber || String(merged.accountLast4 || "")).replace(/\D/g, "").slice(-4);
  return {
    name,
    bank: normalizeBank(merged.bank),
    currency: normalizeCurrency(merged.currency, company?.defaultCurrency || "ZAR"),
    accountHolder: clip(merged.accountHolder, 120),
    accountNumber,
    accountLast4: last4,
    branchCode: clip(merged.branchCode, 20),
    swift: clip(merged.swift, 20).toUpperCase(),
    iban: clip(merged.iban, 40).toUpperCase(),
    details: clip(merged.details, 1000),
    showOnInvoices: merged.showOnInvoices === undefined ? true : Boolean(merged.showOnInvoices),
    openingBalance: roundMoney(merged.openingBalance || 0),
    openingDate: toIsoDate(merged.openingDate) || "",
  };
}

const bankLabel = (key) => (BANK_OPTIONS.find((b) => b.value === key) || {}).label || "";

/** Plain-text payment details printed on documents. */
function paymentDetailsText(a) {
  return [
    a.bank && a.bank !== "other" ? `Bank: ${bankLabel(a.bank)}` : "",
    a.accountHolder ? `Account name: ${a.accountHolder}` : "",
    a.accountNumber ? `Account number: ${a.accountNumber}` : "",
    a.branchCode ? `Branch code: ${a.branchCode}` : "",
    a.swift ? `SWIFT: ${a.swift}` : "",
    a.iban ? `IBAN: ${a.iban}` : "",
    a.details || "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------- migration from company.bankAccounts ----------

const LEGACY_FIELDS = [
  [/^bank(\s*name)?$/i, "bankName"],
  [/^account\s*(name|holder)$/i, "accountHolder"],
  [/^(account\s*(no\.?|number|#)|acc(ount)?\s*no\.?)$/i, "accountNumber"],
  [/^(branch(\s*code)?|universal branch code)$/i, "branchCode"],
  [/^(swift|bic|swift\s*\/\s*bic|swift code)$/i, "swift"],
  [/^iban$/i, "iban"],
];

/** Turn one old { label, currency, details } entry into account fields. Exported for tests. */
function legacyToAccount(legacy, company = {}) {
  const fields = {};
  const rest = [];
  for (const line of String(legacy.details || "").split(/\r?\n/)) {
    const m = /^\s*([^:]{2,30}):\s*(.+?)\s*$/.exec(line);
    const hit = m && LEGACY_FIELDS.find(([re]) => re.test(m[1].trim()));
    if (hit && !fields[hit[1]]) fields[hit[1]] = m[2];
    else if (line.trim()) rest.push(line.trimEnd());
  }
  const guessText = `${fields.bankName || ""} ${legacy.label || ""} ${legacy.details || ""}`.toLowerCase();
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const word = (t) => new RegExp(`(^|[^a-z0-9])${esc(t)}([^a-z0-9]|$)`);
  const guess = BANK_OPTIONS.find((b) => b.value !== "other" && (word(b.label.toLowerCase()).test(guessText) || word(b.value.replace(/_/g, " ")).test(guessText)));
  const bank = fields.bankName ? normalizeBank(fields.bankName) : "other";
  const resolved = bank !== "other" ? bank : guess ? guess.value : "other";
  if (resolved === "other" && fields.bankName) rest.unshift(`Bank: ${fields.bankName}`);
  return normalizeAccount(
    {
      name: legacy.label || fields.bankName || "Bank account",
      bank: resolved,
      currency: legacy.currency || company.defaultCurrency || "ZAR",
      accountHolder: fields.accountHolder,
      accountNumber: fields.accountNumber,
      branchCode: fields.branchCode,
      swift: fields.swift,
      iban: fields.iban,
      details: rest.join("\n"),
      showOnInvoices: true,
    },
    company
  );
}

const legacyDocId = (legacy, index) => {
  const key = String(legacy.id || "").replace(/[^\w-]/g, "").slice(0, 40) ||
    crypto.createHash("sha256").update(`${index}|${legacy.label}|${legacy.details}`).digest("hex").slice(0, 16);
  return `legacy-${key}`;
};

/**
 * Copy company.bankAccounts into the collection once (idempotent: fixed doc
 * ids, existing docs are never overwritten). The old field is left as is.
 * Returns the number of accounts created.
 */
async function migrateLegacyAccounts(companyId, companyData) {
  const company = companyData || (await loadCompanyData(companyId));
  const legacy = Array.isArray(company.bankAccounts) ? company.bankAccounts : [];
  if (company.bankAccountsMigratedAt || !legacy.length) return 0;
  let created = 0;
  const now = new Date().toISOString();
  for (let i = 0; i < legacy.length; i++) {
    const item = legacy[i] || {};
    if (!String(item.label || "").trim() && !String(item.details || "").trim()) continue;
    const ref = accountsCol(companyId).doc(legacyDocId(item, i));
    if ((await ref.get()).exists) continue;
    await ref.set({ ...legacyToAccount(item, company), legacyId: String(item.id || ""), migratedFrom: "company.bankAccounts", createdAt: now, updatedAt: now, createdBy: "migration" });
    created++;
  }
  await companyRef(getDb(), companyId).set({ bankAccountsMigratedAt: now }, { merge: true });
  if (created) await logAudit({ companyId, uid: "system", email: "", action: "bankAccount.migrate", payload: { created } });
  if (created) await ensureChart(companyId, { linkBanks: true });
  return created;
}

/**
 * Payment details for documents, in the issuer snapshot shape
 * ({ id, label, currency, details }). Runs the migration first if needed.
 */
async function paymentAccounts(companyId, companyData) {
  await migrateLegacyAccounts(companyId, companyData);
  const rows = await fetchAll(accountsCol(companyId));
  return rows
    .filter((a) => a.showOnInvoices !== false)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((a) => ({ id: a.id, label: a.name, currency: a.currency || "", details: paymentDetailsText(a) }));
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
  await migrateLegacyAccounts(companyId);
  const [rows, txs] = await Promise.all([fetchAll(accountsCol(companyId)), fetchAll(txCol(companyId))]);
  return rows
    .map((a) => ({ showOnInvoices: true, ...a, bank: normalizeBank(a.bank), ...accountBalance(a, txs) }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function getAccount(companyId, accountId) {
  if (!accountId) throw httpError(400, "Pick a bank account");
  const snap = await accountsCol(companyId).doc(String(accountId)).get();
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Bank account not found");
  const data = snap.data();
  return { id: snap.id, showOnInvoices: true, ...data, bank: normalizeBank(data.bank) };
}

async function createAccount(companyId, uid, email, role, body = {}) {
  assertCan(canManageSettings, role);
  const company = await loadCompanyData(companyId);
  const data = normalizeAccount(body, company);
  const id = randomId(8);
  const now = new Date().toISOString();
  const doc = { ...data, createdAt: now, updatedAt: now, createdBy: uid };
  await accountsCol(companyId).doc(id).set(doc);
  await ensureChart(companyId, { linkBanks: true });
  await logAudit({ companyId, uid, email, action: "bankAccount.create", payload: { id, name: data.name, currency: data.currency } });
  return { id, ...doc };
}

async function updateAccount(companyId, uid, email, role, accountId, body = {}) {
  assertCan(canManageSettings, role);
  const existing = await getAccount(companyId, accountId);
  const company = await loadCompanyData(companyId);
  const data = normalizeAccount(body, company, existing);
  if (data.currency !== existing.currency) {
    const used = await fetchAll(txCol(companyId).where("accountId", "==", accountId));
    if (used.length) throw httpError(409, "Cannot change the currency after importing transactions");
  }
  const patch = { ...data, updatedAt: new Date().toISOString() };
  await accountsCol(companyId).doc(accountId).set(patch, { merge: true });
  await ensureChart(companyId, { linkBanks: true });
  await logAudit({ companyId, uid, email, action: "bankAccount.update", payload: { id: accountId } });
  return { ...existing, ...patch };
}

async function deleteAccount(companyId, uid, email, role, accountId) {
  assertCan(canManageSettings, role);
  const existing = await getAccount(companyId, accountId);
  const used = await fetchAll(txCol(companyId).where("accountId", "==", accountId));
  if (used.length) throw httpError(409, "This account has transactions. Delete its imports first.");
  await accountsCol(companyId).doc(accountId).set({ deletedAt: new Date().toISOString(), deletedBy: uid }, { merge: true });
  // Archives its ledger account (kept: ledger history never disappears).
  await ensureChart(companyId, { linkBanks: true });
  await logAudit({ companyId, uid, email, action: "bankAccount.delete", payload: { id: accountId, name: existing.name } });
}

module.exports = {
  BANKS,
  BANK_OPTIONS,
  normalizeBank,
  paymentDetailsText,
  legacyToAccount,
  migrateLegacyAccounts,
  paymentAccounts,
  listAccounts, getAccount, createAccount, updateAccount, deleteAccount, accountBalance };
