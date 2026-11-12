// Chart of accounts (Phase 1 ledger, slice 1.4.0). See docs/design/phase-1-ledger.md.
// Accounts live in companies/{id}/accounts. Template accounts get stable ids
// (system accounts use their system key, the rest "t<code>"), so seeding is
// idempotent and safe to re-run for new and existing companies. Each Settings
// bank account gets its own ledger account ("bank_<bankAccountId>").
// Nothing posts yet: journals arrive in 1.5.0.
const { getDb } = require("../firebase");
const { randomId } = require("../ids");
const { companyRef } = require("../refs");
const { httpError } = require("../errors");
const { canManageSettings, assertCan } = require("../permissions");
const { logAudit } = require("../audit");
const { fetchAll } = require("../db");

const CHART_VERSION = 1;
const TYPES = ["asset", "liability", "equity", "income", "expense"];
const TYPE_LABELS = { asset: "Assets", liability: "Liabilities", equity: "Equity", income: "Income", expense: "Expenses" };
const SUBTYPES = {
  asset: ["bank", "receivable", "clearing", "current_asset", "fixed_asset", "other_asset"],
  liability: ["payable", "clearing", "vat", "current_liability", "non_current_liability"],
  equity: ["equity", "retained_earnings", "opening_balance"],
  income: ["sales", "other_income", "fx"],
  expense: ["operating_expense", "cost_of_sales", "other_expense"],
};
const DEFAULT_SUBTYPE = { asset: "current_asset", liability: "current_liability", equity: "equity", income: "other_income", expense: "operating_expense" };
// Subtypes only system accounts may carry.
const RESERVED_SUBTYPES = ["bank", "receivable", "payable", "clearing", "vat", "retained_earnings", "opening_balance", "fx"];

const BANK_CODE_MIN = 1001;
const BANK_CODE_MAX = 1099;

const sys = (key, code, name, type, subtype) => ({ key, code, name, type, subtype });
const tpl = (code, name, type, subtype) => ({ key: null, code, name, type, subtype });

/** SA small-business template (design note section 4). */
const TEMPLATE = [
  sys("debtors", "1100", "Trade debtors", "asset", "receivable"),
  sys("undeposited_funds", "1150", "Undeposited funds", "asset", "clearing"),
  sys("transfers_in_transit", "1160", "Transfers in transit", "asset", "clearing"),
  tpl("1200", "Prepayments and deposits", "asset", "current_asset"),
  tpl("1300", "Computer equipment", "asset", "fixed_asset"),
  tpl("1310", "Accumulated depreciation", "asset", "fixed_asset"),
  sys("creditors", "2000", "Trade creditors", "liability", "payable"),
  sys("expense_clearing", "2050", "Expenses awaiting bank match", "liability", "clearing"),
  sys("vat", "2100", "VAT control", "liability", "vat"),
  tpl("2200", "Shareholder / director loan", "liability", "non_current_liability"),
  tpl("2300", "SARS income tax", "liability", "current_liability"),
  tpl("2400", "Accruals", "liability", "current_liability"),
  tpl("3000", "Share capital", "equity", "equity"),
  sys("retained_earnings", "3100", "Retained earnings", "equity", "retained_earnings"),
  sys("opening_balance_equity", "3200", "Opening balance equity", "equity", "opening_balance"),
  sys("default_income", "4000", "Sales: services", "income", "sales"),
  tpl("4100", "Sales: products", "income", "sales"),
  tpl("4200", "Interest received", "income", "other_income"),
  tpl("4800", "Other income", "income", "other_income"),
  sys("fx", "4900", "Exchange differences (realised)", "income", "fx"),
  tpl("5000", "Advertising & marketing", "expense", "operating_expense"),
  tpl("5050", "Bank charges", "expense", "operating_expense"),
  tpl("5100", "Contractors", "expense", "operating_expense"),
  tpl("5150", "Equipment (small items)", "expense", "operating_expense"),
  tpl("5200", "Hosting & domains", "expense", "operating_expense"),
  tpl("5250", "Office & supplies", "expense", "operating_expense"),
  tpl("5300", "Professional fees", "expense", "operating_expense"),
  tpl("5350", "Software & subscriptions", "expense", "operating_expense"),
  tpl("5400", "Telephone & internet", "expense", "operating_expense"),
  tpl("5450", "Travel", "expense", "operating_expense"),
  tpl("5500", "Salaries and wages", "expense", "operating_expense"),
  tpl("5600", "Rent", "expense", "operating_expense"),
  tpl("5700", "Depreciation", "expense", "operating_expense"),
  tpl("5800", "Interest paid", "expense", "other_expense"),
  sys("default_expense", "5900", "Other expenses", "expense", "operating_expense"),
];

const SYSTEM_KEYS = TEMPLATE.filter((t) => t.key).map((t) => t.key);
const templateId = (t) => t.key || `t${t.code}`;
const bankLedgerId = (bankAccountId) => `bank_${bankAccountId}`;

// Default expense category name -> template account id.
const CATEGORY_ACCOUNTS = {
  "advertising & marketing": "t5000",
  "bank charges": "t5050",
  contractors: "t5100",
  equipment: "t5150",
  "hosting & domains": "t5200",
  "office & supplies": "t5250",
  "professional fees": "t5300",
  "software & subscriptions": "t5350",
  "telephone & internet": "t5400",
  travel: "t5450",
  other: "default_expense",
  uncategorised: "default_expense",
};

/** Template default for an expense category (by name); falls back to Other expenses. */
function defaultExpenseAccountId(categoryName) {
  return CATEGORY_ACCOUNTS[String(categoryName || "").trim().toLowerCase()] || "default_expense";
}

/** Template default income account for a product kind. */
function defaultIncomeAccountId(kind) {
  return kind === "product" ? "t4100" : "default_income";
}

const accountsCol = (companyId) => companyRef(getDb(), companyId).collection("accounts");
const journalsCol = (companyId) => companyRef(getDb(), companyId).collection("journals");

function templateDoc(t, now) {
  return {
    code: t.code,
    name: t.name,
    type: t.type,
    subtype: t.subtype,
    systemKey: t.key || null,
    bankAccountId: null,
    currency: "",
    description: "",
    active: true,
    createdAt: now,
    updatedAt: now,
    createdBy: "system",
  };
}

function nextBankCode(used) {
  for (let n = BANK_CODE_MIN; n <= BANK_CODE_MAX; n++) {
    if (!used.has(String(n))) return String(n);
  }
  throw httpError(409, "No free bank account codes left (1001-1099)");
}

/**
 * Seed the template and link Settings bank accounts. Idempotent: only missing
 * accounts are created and edits (names, codes) are never overwritten.
 * Fast path (one read) once the template is in place, unless linkBanks is set.
 */
async function ensureChart(companyId, { linkBanks = false } = {}) {
  const db = getDb();
  const cref = companyRef(db, companyId);
  const head = await cref.get();
  if (!head.exists) throw httpError(404, "Company not found");
  if (!linkBanks && Number(head.data().ledger?.chartVersion) >= CHART_VERSION) return { seeded: false };

  return db.runTransaction(async (tx) => {
    const [companySnap, accSnap, bankSnap] = await Promise.all([
      tx.get(cref),
      tx.get(cref.collection("accounts")),
      tx.get(cref.collection("bankAccounts")),
    ]);
    const existing = new Map(accSnap.docs.map((d) => [d.id, d.data()]));
    const usedCodes = new Set([...existing.values()].map((a) => String(a.code)));
    const now = new Date().toISOString();
    let created = 0;

    for (const t of TEMPLATE) {
      const id = templateId(t);
      if (existing.has(id)) continue;
      // Don't clash with a code someone already used for their own account.
      const doc = templateDoc(t, now);
      if (usedCodes.has(doc.code)) doc.code = "";
      if (doc.code) usedCodes.add(doc.code);
      tx.set(cref.collection("accounts").doc(id), doc);
      existing.set(id, doc);
      created++;
    }

    for (const b of bankSnap.docs) {
      const bank = b.data();
      const id = bankLedgerId(b.id);
      const prev = existing.get(id);
      const active = !bank.deletedAt;
      const name = String(bank.name || "Bank account");
      const currency = bank.currency || "ZAR";
      if (!prev) {
        if (!active) continue;
        const code = nextBankCode(usedCodes);
        usedCodes.add(code);
        tx.set(cref.collection("accounts").doc(id), {
          code, name, type: "asset", subtype: "bank", systemKey: null, bankAccountId: b.id, currency,
          description: "", active: true, createdAt: now, updatedAt: now, createdBy: "system",
        });
        created++;
      } else if (prev.name !== name || prev.currency !== currency || prev.active !== active) {
        tx.set(cref.collection("accounts").doc(id), { name, currency, active, updatedAt: now }, { merge: true });
      }
    }

    const systemAccounts = Object.fromEntries(SYSTEM_KEYS.map((k) => [k, k]));
    const ledger = { ...(companySnap.data().ledger || {}), chartVersion: CHART_VERSION, systemAccounts };
    tx.set(cref, { ledger }, { merge: true });
    return { seeded: true, created };
  });
}

function decorate(a) {
  const system = Boolean(a.systemKey);
  const bank = Boolean(a.bankAccountId);
  return { ...a, system, bank, locked: system || bank, active: a.active !== false };
}

const byCode = (a, b) => String(a.code || "9999").localeCompare(String(b.code || "9999")) || String(a.name).localeCompare(String(b.name));

async function listLedgerAccounts(companyId, { includeArchived = true } = {}) {
  await ensureChart(companyId);
  const rows = (await fetchAll(accountsCol(companyId))).map(decorate);
  return rows.filter((a) => includeArchived || a.active).sort((a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || byCode(a, b));
}

async function getLedgerAccount(companyId, accountId) {
  const snap = await accountsCol(companyId).doc(String(accountId || "")).get();
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Account not found");
  return decorate({ id: snap.id, ...snap.data() });
}

/** Whether any journal entry exists (locks the base currency). */
async function ledgerHasEntries(companyId) {
  const snap = await journalsCol(companyId).limit(1).get();
  return !snap.empty;
}

/** Whether an account has posted lines (blocks retyping/archiving). Journals arrive in 1.5.0. */
async function accountHasEntries(companyId, accountId) {
  const snap = await journalsCol(companyId).where("accountIds", "array-contains", accountId).limit(1).get();
  return !snap.empty;
}

function cleanCode(value) {
  const code = String(value ?? "").trim();
  if (!/^\d{4}$/.test(code)) throw httpError(400, "Account code must be 4 digits, e.g. 5150");
  const n = Number(code);
  if (n >= 1000 && n <= 1099) throw httpError(400, "Codes 1000-1099 are reserved for bank accounts");
  return code;
}

function cleanType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (!TYPES.includes(type)) throw httpError(400, `Type must be one of ${TYPES.join(", ")}`);
  return type;
}

function cleanSubtype(type, value) {
  const subtype = String(value || "").trim().toLowerCase() || DEFAULT_SUBTYPE[type];
  if (!SUBTYPES[type].includes(subtype) || RESERVED_SUBTYPES.includes(subtype)) {
    throw httpError(400, `Subtype for ${type} accounts must be one of ${SUBTYPES[type].filter((s) => !RESERVED_SUBTYPES.includes(s)).join(", ")}`);
  }
  return subtype;
}

function cleanName(value) {
  const name = String(value || "").trim().slice(0, 120);
  if (!name) throw httpError(400, "Account name is required");
  return name;
}

async function assertCodeFree(companyId, code, exceptId) {
  const clash = (await fetchAll(accountsCol(companyId).where("code", "==", code), { includeDeleted: true })).find((a) => a.id !== exceptId);
  if (clash) throw httpError(409, `Code ${code} is already used by ${clash.name}`);
}

async function createLedgerAccount(companyId, uid, email, role, body = {}) {
  assertCan(canManageSettings, role);
  await ensureChart(companyId);
  const type = cleanType(body.type);
  const doc = {
    code: cleanCode(body.code),
    name: cleanName(body.name),
    type,
    subtype: cleanSubtype(type, body.subtype),
    systemKey: null,
    bankAccountId: null,
    currency: "",
    description: String(body.description || "").trim().slice(0, 500),
    active: true,
  };
  await assertCodeFree(companyId, doc.code);
  const id = randomId(10);
  const now = new Date().toISOString();
  const full = { ...doc, createdAt: now, updatedAt: now, createdBy: uid };
  await accountsCol(companyId).doc(id).set(full);
  await logAudit({ companyId, uid, email, action: "account.create", payload: { accountId: id, code: doc.code, name: doc.name, type } });
  return decorate({ id, ...full });
}

async function updateLedgerAccount(companyId, uid, email, role, accountId, body = {}) {
  assertCan(canManageSettings, role);
  const existing = await getLedgerAccount(companyId, accountId);
  const patch = {};
  if (body.code !== undefined) {
    if (existing.bank) {
      const code = String(body.code ?? "").trim();
      const n = Number(code);
      if (!/^\d{4}$/.test(code) || n < BANK_CODE_MIN || n > BANK_CODE_MAX) throw httpError(400, "Bank account codes must be between 1001 and 1099");
      patch.code = code;
    } else {
      patch.code = cleanCode(body.code);
    }
    if (patch.code !== existing.code) await assertCodeFree(companyId, patch.code, accountId);
  }
  if (body.name !== undefined) {
    if (existing.bank && cleanName(body.name) !== existing.name) throw httpError(409, "Rename bank accounts in Settings > Bank accounts");
    patch.name = cleanName(body.name);
  }
  if (body.description !== undefined) patch.description = String(body.description || "").trim().slice(0, 500);
  const typeChange = body.type !== undefined && String(body.type).toLowerCase() !== existing.type;
  const subtypeChange = body.subtype !== undefined && String(body.subtype || "").toLowerCase() !== existing.subtype;
  if (typeChange || subtypeChange) {
    if (existing.locked) throw httpError(409, "System and bank accounts can't change type");
    const type = cleanType(body.type !== undefined ? body.type : existing.type);
    if (typeChange && (await accountHasEntries(companyId, accountId))) throw httpError(409, "This account has entries; its type can't change");
    if (typeChange) await assertNotMapped(companyId, accountId, "change its type");
    patch.type = type;
    patch.subtype = cleanSubtype(type, body.subtype !== undefined ? body.subtype : typeChange ? "" : existing.subtype);
  }
  patch.updatedAt = new Date().toISOString();
  await accountsCol(companyId).doc(accountId).set(patch, { merge: true });
  await logAudit({ companyId, uid, email, action: "account.update", payload: { accountId, ...patch } });
  return decorate({ ...existing, ...patch });
}

/** Products and expense categories mapped to an account. */
async function mappedUsers(companyId, accountId) {
  const cref = companyRef(getDb(), companyId);
  const [products, categories] = await Promise.all([
    fetchAll(cref.collection("products").where("incomeAccountId", "==", accountId)),
    fetchAll(cref.collection("expenseCategories").where("accountId", "==", accountId)),
  ]);
  return { products, categories };
}

async function assertNotMapped(companyId, accountId, verb) {
  const { products, categories } = await mappedUsers(companyId, accountId);
  if (products.length || categories.length) {
    const parts = [];
    if (products.length) parts.push(`${products.length} product${products.length === 1 ? "" : "s"}`);
    if (categories.length) parts.push(`${categories.length} expense categor${categories.length === 1 ? "y" : "ies"}`);
    throw httpError(409, `Used by ${parts.join(" and ")}. Map them to another account before you ${verb}.`);
  }
}

async function setArchived(companyId, uid, email, role, accountId, archived) {
  assertCan(canManageSettings, role);
  const existing = await getLedgerAccount(companyId, accountId);
  if (existing.system) throw httpError(409, "System accounts can't be archived");
  if (existing.bank) throw httpError(409, "Delete the bank account in Settings > Bank accounts instead");
  if (archived) await assertNotMapped(companyId, accountId, "archive it");
  const patch = { active: !archived, updatedAt: new Date().toISOString() };
  await accountsCol(companyId).doc(accountId).set(patch, { merge: true });
  await logAudit({ companyId, uid, email, action: archived ? "account.archive" : "account.unarchive", payload: { accountId, code: existing.code } });
  return decorate({ ...existing, ...patch });
}

const archiveLedgerAccount = (companyId, uid, email, role, accountId) => setArchived(companyId, uid, email, role, accountId, true);
const unarchiveLedgerAccount = (companyId, uid, email, role, accountId) => setArchived(companyId, uid, email, role, accountId, false);

/**
 * Resolve the account a product or expense category maps to. Empty means the
 * template default; an explicit id must be an active account of the right type.
 */
async function resolveMapping(companyId, accountId, { type, fallbackId }) {
  await ensureChart(companyId);
  const pick = async (id) => {
    const snap = await accountsCol(companyId).doc(String(id)).get();
    return snap.exists && !snap.data().deletedAt ? { id: snap.id, ...snap.data() } : null;
  };
  if (accountId) {
    const a = await pick(accountId);
    if (!a) throw httpError(400, "Account not found");
    if (a.type !== type) throw httpError(400, `Pick an ${type} account`);
    if (a.active === false) throw httpError(400, `${a.name} is archived`);
    return a.id;
  }
  const fallback = await pick(fallbackId);
  if (fallback && fallback.active !== false && fallback.type === type) return fallback.id;
  return type === "income" ? "default_income" : "default_expense";
}

const resolveIncomeAccount = (companyId, accountId, kind) =>
  resolveMapping(companyId, accountId, { type: "income", fallbackId: defaultIncomeAccountId(kind) });
const resolveExpenseAccount = (companyId, accountId, categoryName) =>
  resolveMapping(companyId, accountId, { type: "expense", fallbackId: defaultExpenseAccountId(categoryName) });

module.exports = {
  CHART_VERSION,
  TYPES,
  TYPE_LABELS,
  SUBTYPES,
  RESERVED_SUBTYPES,
  TEMPLATE,
  SYSTEM_KEYS,
  bankLedgerId,
  defaultExpenseAccountId,
  defaultIncomeAccountId,
  ensureChart,
  listLedgerAccounts,
  getLedgerAccount,
  createLedgerAccount,
  updateLedgerAccount,
  archiveLedgerAccount,
  unarchiveLedgerAccount,
  ledgerHasEntries,
  accountHasEntries,
  resolveIncomeAccount,
  resolveExpenseAccount,
};
