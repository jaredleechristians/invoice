// Bank statement import and reconciliation. Bank lines are for reconciling
// only: payments and expenses stay the source records for reports, so a
// transfer or ignored line never counts as income or expense.
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { canWriteRecords, canDeleteRecords, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { roundMoney } = require("./money");
const { fetchAll } = require("./db");
const { inRange, daysBetween } = require("./dates");
const { parseStatement, dedupeKeys } = require("./bankParse");
const { getAccount } = require("./bankAccounts");
const { LINK_CLEAR, PAYMENT_LINK_CLEAR, EXPENSE_LINK_CLEAR, txCol } = require("./bankLinks");
const invoices = require("./invoices");
const payments = require("./payments");
const expenses = require("./expenses");

const STATUSES = ["unreconciled", "matched", "categorised", "transfer", "ignored"];
const MAX_FILE_CHARS = 1_500_000;
const PREVIEW_ROWS = 200;

const importsCol = (companyId) => companyRef(getDb(), companyId).collection("bankImports");
const paymentsCol = (companyId) => companyRef(getDb(), companyId).collection("payments");
const expensesCol = (companyId) => companyRef(getDb(), companyId).collection("expenses");

async function loadTx(companyId, transactionId) {
  const snap = await txCol(companyId).doc(String(transactionId || "")).get();
  if (!snap.exists) throw httpError(404, "Bank transaction not found");
  return { id: snap.id, ...snap.data() };
}

// ---------- import ----------

async function existingIds(companyId, ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const snaps = await Promise.all(ids.slice(i, i + 50).map((id) => txCol(companyId).doc(id).get()));
    for (const s of snaps) if (s.exists) found.add(s.id);
  }
  return found;
}

async function analyseImport(companyId, body) {
  const account = await getAccount(companyId, body.accountId);
  const content = String(body.content || "");
  if (!content.trim()) throw httpError(400, "The file is empty");
  if (content.length > MAX_FILE_CHARS) throw httpError(400, "File is too large (max 1.5 MB). Export a shorter date range.");
  const parsed = parseStatement(content, { mapping: body.mapping });
  const keyed = dedupeKeys(account.id, parsed.transactions);
  const existing = await existingIds(companyId, keyed.map((t) => t.docId));
  const inFile = new Set();
  const rows = keyed.map((t) => {
    const duplicate = existing.has(t.docId) || inFile.has(t.docId);
    inFile.add(t.docId);
    return { ...t, duplicate };
  });
  const warnings = [];
  if (parsed.account?.currency && parsed.account.currency !== account.currency) {
    warnings.push(`The file is in ${parsed.account.currency} but this account is ${account.currency}.`);
  }
  if (parsed.account?.accountLast4 && account.accountLast4 && parsed.account.accountLast4 !== account.accountLast4) {
    warnings.push(`The file is for account ending ${parsed.account.accountLast4}, not ${account.accountLast4}.`);
  }
  const dates = rows.map((r) => r.date).sort();
  return {
    account,
    parsed,
    rows,
    summary: {
      format: parsed.format,
      headers: parsed.headers || [],
      sample: parsed.sample || [],
      mapping: parsed.mapping || null,
      fileAccount: parsed.account || null,
      skipped: parsed.skipped || 0,
      total: rows.length,
      newCount: rows.filter((r) => !r.duplicate).length,
      duplicateCount: rows.filter((r) => r.duplicate).length,
      from: dates[0] || "",
      to: dates[dates.length - 1] || "",
      warnings,
    },
  };
}

async function previewImport(companyId, uid, email, role, body = {}) {
  assertCan(canWriteRecords, role);
  const { rows, summary } = await analyseImport(companyId, body);
  return {
    ...summary,
    transactions: rows.slice(0, PREVIEW_ROWS).map(({ date, amount, description, reference, duplicate }) => ({ date, amount, description, reference, duplicate })),
  };
}

async function commitImport(companyId, uid, email, role, body = {}) {
  assertCan(canWriteRecords, role);
  const { account, rows, summary } = await analyseImport(companyId, body);
  const fresh = rows.filter((r) => !r.duplicate);
  const importId = randomId();
  const now = new Date().toISOString();
  const db = getDb();
  for (let i = 0; i < fresh.length; i += 400) {
    const batch = db.batch();
    for (const t of fresh.slice(i, i + 400)) {
      batch.set(txCol(companyId).doc(t.docId), {
        accountId: account.id,
        currency: account.currency,
        importId,
        date: t.date,
        amount: roundMoney(t.amount),
        description: t.description,
        reference: t.reference,
        fitId: t.fitId || "",
        dedupeKey: t.dedupeKey,
        ...LINK_CLEAR,
        createdAt: now,
        updatedAt: now,
        createdBy: uid,
      });
    }
    await batch.commit();
  }
  const record = {
    accountId: account.id,
    filename: String(body.filename || "").slice(0, 160),
    format: summary.format,
    mapping: summary.mapping,
    importedCount: fresh.length,
    duplicateCount: summary.duplicateCount,
    skippedCount: summary.skipped,
    from: summary.from,
    to: summary.to,
    createdAt: now,
    createdBy: uid,
    createdByEmail: email || "",
  };
  await importsCol(companyId).doc(importId).set(record);
  await logAudit({ companyId, uid, email, action: "bankImport.create", payload: { importId, accountId: account.id, imported: fresh.length, duplicates: summary.duplicateCount } });
  return { import: { id: importId, ...record } };
}

async function listImports(companyId, { accountId } = {}) {
  let q = importsCol(companyId);
  if (accountId) q = q.where("accountId", "==", accountId);
  const rows = await fetchAll(q);
  return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Delete an import's lines. Refused when any of them is reconciled. */
async function deleteImport(companyId, uid, email, role, importId) {
  assertCan(canDeleteRecords, role);
  const snap = await importsCol(companyId).doc(importId).get();
  if (!snap.exists) throw httpError(404, "Import not found");
  const lines = await fetchAll(txCol(companyId).where("importId", "==", importId));
  if (lines.some((t) => t.status !== "unreconciled")) throw httpError(409, "Undo the reconciled lines in this import first");
  const db = getDb();
  for (let i = 0; i < lines.length; i += 400) {
    const batch = db.batch();
    for (const t of lines.slice(i, i + 400)) batch.delete(txCol(companyId).doc(t.id));
    await batch.commit();
  }
  await importsCol(companyId).doc(importId).delete();
  await logAudit({ companyId, uid, email, action: "bankImport.delete", payload: { importId, deleted: lines.length } });
  return { deleted: lines.length };
}

// ---------- list ----------

async function listTransactions(companyId, { accountId, status, from, to, q } = {}) {
  let query = txCol(companyId);
  if (accountId) query = query.where("accountId", "==", accountId);
  let rows = await fetchAll(query);
  if (status) rows = rows.filter((t) => (status === "unreconciled" ? ["unreconciled", "processing"].includes(t.status) : t.status === status));
  if (from || to) rows = rows.filter((t) => inRange(t.date, from, to));
  if (q) {
    const needle = String(q).toLowerCase();
    rows = rows.filter((t) =>
      [t.description, t.reference, t.matchLabel, String(Math.abs(t.amount))].some((v) => String(v || "").toLowerCase().includes(needle))
    );
  }
  return rows.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.id).localeCompare(String(b.id)));
}

// ---------- suggestions ----------

const norm = (s) => String(s || "").toLowerCase();
const near = (a, b) => Math.abs(roundMoney(a) - roundMoney(b)) < 0.005;

function invoiceScore(tx, inv) {
  let score = 0;
  const text = norm(`${tx.description} ${tx.reference}`);
  const amt = Math.abs(tx.amount);
  if (inv.currency === tx.currency) {
    if (near(inv.outstanding, amt)) score += 50;
    else if (near(inv.total, amt)) score += 30;
  }
  const num = norm(inv.invoiceNumber);
  if (num && text.includes(num)) score += 40;
  else {
    const digits = num.replace(/\D/g, "").replace(/^0+/, "");
    if (digits.length >= 2 && new RegExp(`(^|\\D)0*${digits}(\\D|$)`).test(text)) score += 20;
  }
  const words = norm(inv.customerName).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !["pty", "ltd", "the", "and", "inc", "llc", "cc"].includes(w));
  if (words.some((w) => text.includes(w))) score += 20;
  return score;
}

/** Rank open invoices for a money-in line. Exported for tests. */
function rankInvoices(tx, invoiceList) {
  return invoiceList
    .filter((i) => !i.draft && !i.voided && roundMoney(i.outstanding) > 0)
    .map((i) => ({ ...i, score: invoiceScore(tx, i) }))
    .sort((a, b) => b.score - a.score || String(b.issueDateIso).localeCompare(String(a.issueDateIso)));
}

async function suggestions(companyId, transactionId) {
  const tx = await loadTx(companyId, transactionId);
  const out = { transaction: tx, invoices: [], payments: [], expenses: [], transfers: [], categories: [] };
  const dateScore = (d) => Math.max(0, 20 - Math.abs(daysBetween(tx.date, d)) * 2);
  if (tx.amount > 0) {
    const list = await invoices.listInvoices(companyId);
    out.invoices = rankInvoices(tx, list).slice(0, 100).map((i) => ({
      id: i.id,
      invoiceNumber: i.invoiceNumber,
      customerName: i.customerName,
      currency: i.currency,
      total: i.total,
      outstanding: i.outstanding,
      issueDate: i.issueDateIso,
      exchangeRate: i.exchangeRate ?? null,
      score: i.score,
    }));
    const pays = (await payments.listPayments(companyId)).filter((p) => !p.voided && !p.transactionId);
    out.payments = pays
      .map((p) => ({ ...p, score: (p.currency === tx.currency && near(p.amount, tx.amount) ? 50 : 0) + dateScore(p.paidAtIso) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(({ id, invoiceId, invoiceNumber, customerName, amount, currency, paidAtIso, method, reference, score }) => ({ id, invoiceId, invoiceNumber, customerName, amount, currency, paidAt: paidAtIso, method, reference, score }));
  } else {
    const exps = (await expenses.listExpenses(companyId)).filter((e) => !e.transactionId);
    const text = norm(tx.description);
    out.expenses = exps
      .map((e) => ({
        ...e,
        score: (e.currency === tx.currency && near(e.amount, -tx.amount) ? 50 : 0) + dateScore(e.date) + (e.vendor && text.includes(norm(e.vendor)) ? 20 : 0),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 50)
      .map(({ id, date, vendor, categoryName, amount, currency, score }) => ({ id, date, vendor, categoryName, amount, currency, score }));
    out.categories = await expenses.listCategories(companyId);
  }
  const others = (await fetchAll(txCol(companyId))).filter(
    (t) => t.accountId !== tx.accountId && t.status === "unreconciled" && Math.sign(t.amount) === -Math.sign(tx.amount) && Math.abs(daysBetween(tx.date, t.date)) <= 7
  );
  out.transfers = others
    .map((t) => ({ ...t, score: (t.currency === tx.currency && near(t.amount, -tx.amount) ? 50 : 0) + dateScore(t.date) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20)
    .map(({ id, accountId, date, amount, currency, description, score }) => ({ id, accountId, date, amount, currency, description, score }));
  return out;
}

// ---------- forex ----------

const round6 = (n) => Math.round(n * 1e6) / 1e6;

/**
 * Realised forex on a foreign-currency invoice paid into a ZAR account.
 * amount is in the invoice currency; receivedAmount in the account currency;
 * invoiceRate is ZAR per unit on the invoice date (s25D spot rate).
 */
function computeForex({ invoiceCurrency, amount, receivedCurrency, receivedAmount, invoiceRate }) {
  const base = {
    receivedAmount: roundMoney(receivedAmount),
    receivedCurrency,
    zarReceived: receivedCurrency === "ZAR" ? roundMoney(receivedAmount) : null,
    receivedRate: null,
    invoiceRate: null,
    zarAtInvoiceRate: null,
    forexGainZar: null,
    forexFlag: "",
  };
  if (invoiceCurrency === receivedCurrency) return base;
  if (receivedCurrency !== "ZAR") return { ...base, forexFlag: "non_zar_account" };
  const out = { ...base, receivedRate: amount > 0 ? round6(receivedAmount / amount) : null };
  if (!(invoiceRate > 0)) return { ...out, forexFlag: "missing_invoice_rate" };
  const zarAtInvoiceRate = roundMoney(amount * invoiceRate);
  return { ...out, invoiceRate: round6(invoiceRate), zarAtInvoiceRate, forexGainZar: roundMoney(roundMoney(receivedAmount) - zarAtInvoiceRate) };
}

// ---------- reconcile ----------

/** Lock a line for reconciling (guards against double clicks creating two payments). */
async function claim(companyId, transactionId) {
  const db = getDb();
  const ref = txCol(companyId).doc(String(transactionId || ""));
  return db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw httpError(404, "Bank transaction not found");
    const data = snap.data();
    if (data.status !== "unreconciled") throw httpError(409, "This line is already reconciled. Undo it first.");
    t.set(ref, { status: "processing" }, { merge: true });
    return { id: snap.id, ...data };
  });
}

async function finish(companyId, uid, txId, patch) {
  const full = { ...patch, reconciledAt: new Date().toISOString(), reconciledBy: uid, updatedAt: new Date().toISOString() };
  await txCol(companyId).doc(txId).set(full, { merge: true });
  return full;
}

async function invoiceRateFor(companyId, uid, email, role, invoice, body) {
  const supplied = body.invoiceRate !== undefined && body.invoiceRate !== "" && body.invoiceRate !== null ? invoices.cleanExchangeRate(body.invoiceRate) : null;
  if (supplied && !(invoice.exchangeRate > 0) && invoice.currency !== "ZAR") {
    // Keep the invoice-date rate on the invoice for next time.
    await invoices.updateInvoice(companyId, uid, email, role, invoice.id, { exchangeRate: supplied });
  }
  return supplied || invoice.exchangeRate || null;
}

async function matchInvoice(ctx, tx, body) {
  const { companyId, uid, email, role } = ctx;
  if (!(tx.amount > 0)) throw httpError(400, "Only money in can be matched to an invoice");
  const invoice = await invoices.requireInvoice(companyId, body.invoiceId);
  const account = await getAccount(companyId, tx.accountId);
  const sameCurrency = invoice.currency === tx.currency;
  const amount = sameCurrency ? roundMoney(body.amount || tx.amount) : roundMoney(body.amount);
  if (!(amount > 0)) throw httpError(400, `Enter the ${invoice.currency} amount this payment settles`);
  if (sameCurrency && amount > tx.amount + 0.001) throw httpError(400, "Amount is more than the bank line");
  const rate = await invoiceRateFor(companyId, uid, email, role, invoice, body);
  const fx = computeForex({ invoiceCurrency: invoice.currency, amount, receivedCurrency: tx.currency, receivedAmount: sameCurrency ? amount : tx.amount, invoiceRate: rate });
  const method = account.bank === "wise" ? "wise" : account.bank === "paypal" ? "paypal" : "bank_transfer";
  const res = await payments.recordPayment(
    companyId, uid, email, role,
    { invoiceId: invoice.id, amount, paidAt: tx.date, method, reference: tx.reference || tx.description, note: "From bank import" },
    { transactionId: tx.id, bankAccountId: tx.accountId, ...fx }
  );
  const patch = await finish(companyId, uid, tx.id, {
    status: "matched",
    paymentId: res.payment.id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber || "",
    matchLabel: `${invoice.invoiceNumber || "Invoice"} ${invoice.customerName || ""}`.trim(),
    created: { type: "payment", id: res.payment.id },
  });
  return { transaction: { ...tx, ...patch }, payment: res.payment, forex: fx };
}

async function matchPayment(ctx, tx, body) {
  const { companyId } = ctx;
  if (!(tx.amount > 0)) throw httpError(400, "Only money in can be matched to a payment");
  const ref = paymentsCol(companyId).doc(String(body.paymentId || ""));
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "Payment not found");
  const payment = { id: snap.id, ...snap.data() };
  if (payment.voided) throw httpError(409, "That payment is void");
  if (payment.transactionId) throw httpError(409, "That payment is already linked to a bank line");
  const invoice = payment.invoiceId ? await invoices.getInvoice(companyId, payment.invoiceId) : null;
  const currency = payment.currency || "ZAR";
  if (currency === tx.currency && !near(payment.amount, tx.amount)) throw httpError(400, "Payment amount does not match the bank line");
  const rate = invoice ? await invoiceRateFor(companyId, ctx.uid, ctx.email, ctx.role, invoice, body) : null;
  const fx = computeForex({ invoiceCurrency: currency, amount: payment.amount, receivedCurrency: tx.currency, receivedAmount: tx.amount, invoiceRate: rate });
  await ref.set({ transactionId: tx.id, bankAccountId: tx.accountId, ...fx }, { merge: true });
  const patch = await finish(companyId, ctx.uid, tx.id, {
    status: "matched",
    paymentId: payment.id,
    invoiceId: payment.invoiceId || "",
    invoiceNumber: payment.invoiceNumber || "",
    matchLabel: `${payment.invoiceNumber || "Payment"} ${payment.customerName || ""}`.trim(),
    created: null,
  });
  return { transaction: { ...tx, ...patch }, forex: fx };
}

async function createExpenseFor(ctx, tx, body) {
  const { companyId, uid, email, role } = ctx;
  if (!(tx.amount < 0)) throw httpError(400, "Only money out can become an expense");
  const exp = await expenses.createExpense(companyId, uid, email, role, {
    date: tx.date,
    vendor: body.vendor !== undefined ? body.vendor : tx.description,
    categoryId: body.categoryId || "",
    amount: -tx.amount,
    currency: tx.currency,
    reference: tx.reference,
    notes: body.notes !== undefined ? body.notes : tx.description,
  });
  await expensesCol(companyId).doc(exp.id).set({ transactionId: tx.id, bankAccountId: tx.accountId }, { merge: true });
  const patch = await finish(companyId, uid, tx.id, {
    status: "categorised",
    expenseId: exp.id,
    matchLabel: [exp.vendor, exp.categoryName].filter(Boolean).join(" - "),
    created: { type: "expense", id: exp.id },
  });
  return { transaction: { ...tx, ...patch }, expense: { ...exp, transactionId: tx.id } };
}

async function matchExpense(ctx, tx, body) {
  const { companyId } = ctx;
  if (!(tx.amount < 0)) throw httpError(400, "Only money out can be matched to an expense");
  const exp = await expenses.getExpense(companyId, String(body.expenseId || ""));
  if (exp.transactionId) throw httpError(409, "That expense is already linked to a bank line");
  await expensesCol(companyId).doc(exp.id).set({ transactionId: tx.id, bankAccountId: tx.accountId }, { merge: true });
  const patch = await finish(companyId, ctx.uid, tx.id, {
    status: "categorised",
    expenseId: exp.id,
    matchLabel: [exp.vendor, exp.categoryName].filter(Boolean).join(" - "),
    created: null,
  });
  return { transaction: { ...tx, ...patch } };
}

async function markTransfer(ctx, tx, body) {
  const { companyId, uid } = ctx;
  let pair = null;
  if (body.pairTransactionId) {
    if (body.pairTransactionId === tx.id) throw httpError(400, "Pick a line in another account");
    const candidate = await loadTx(companyId, body.pairTransactionId);
    if (candidate.accountId === tx.accountId) throw httpError(400, "Pick a line in another account");
    if (Math.sign(candidate.amount) !== -Math.sign(tx.amount)) throw httpError(400, "The other side of a transfer must go the opposite way");
    pair = await claim(companyId, candidate.id);
  }
  const patch = await finish(companyId, uid, tx.id, {
    status: "transfer",
    transferPairId: pair ? pair.id : "",
    matchLabel: "Transfer",
    created: null,
  });
  if (pair) await finish(companyId, uid, pair.id, { status: "transfer", transferPairId: tx.id, matchLabel: "Transfer", created: null });
  return { transaction: { ...tx, ...patch }, pair: pair ? { ...pair, status: "transfer", transferPairId: tx.id } : null };
}

async function ignore(ctx, tx, body) {
  const patch = await finish(ctx.companyId, ctx.uid, tx.id, { status: "ignored", note: String(body.note || "").slice(0, 300), matchLabel: "Ignored", created: null });
  return { transaction: { ...tx, ...patch } };
}

const ACTIONS = {
  match_invoice: matchInvoice,
  match_payment: matchPayment,
  create_expense: createExpenseFor,
  match_expense: matchExpense,
  transfer: markTransfer,
  ignore,
};

async function reconcile(companyId, uid, email, role, transactionId, body = {}) {
  assertCan(canWriteRecords, role);
  const fn = ACTIONS[body.action];
  if (!fn) throw httpError(400, `action must be one of ${Object.keys(ACTIONS).join(", ")}`);
  const tx = await claim(companyId, transactionId);
  try {
    const out = await fn({ companyId, uid, email, role }, tx, body);
    await logAudit({ companyId, uid, email, action: "bankTransaction.reconcile", payload: { transactionId: tx.id, action: body.action, amount: tx.amount } });
    return out;
  } catch (err) {
    await txCol(companyId).doc(tx.id).set({ status: "unreconciled" }, { merge: true });
    throw err;
  }
}

/**
 * Undo a reconciliation. When the reconcile created the payment/expense,
 * the caller must say whether to delete it (deleteCreated true/false).
 */
async function undo(companyId, uid, email, role, transactionId, body = {}) {
  assertCan(canWriteRecords, role);
  const tx = await loadTx(companyId, transactionId);
  if (tx.status === "unreconciled") throw httpError(409, "This line is not reconciled");
  const created = tx.created && tx.created.id ? tx.created : null;
  if (created && typeof body.deleteCreated !== "boolean") {
    throw httpError(400, `Say whether to delete the ${created.type} this created (deleteCreated true or false)`);
  }
  if (created && body.deleteCreated && !canDeleteRecords(role)) throw httpError(403, `Only admins can delete the ${created.type}. Undo and keep it instead.`);

  let deleted = null;
  if (tx.paymentId) {
    if (created?.type === "payment" && body.deleteCreated) {
      await payments.deletePayment(companyId, uid, email, role, tx.paymentId).catch((e) => { if (e.status !== 404) throw e; });
      deleted = { type: "payment", id: tx.paymentId };
    } else {
      const ref = paymentsCol(companyId).doc(tx.paymentId);
      if ((await ref.get()).exists) await ref.set(PAYMENT_LINK_CLEAR, { merge: true });
    }
  }
  if (tx.expenseId) {
    if (created?.type === "expense" && body.deleteCreated) {
      await expenses.deleteExpense(companyId, uid, email, role, tx.expenseId).catch((e) => { if (e.status !== 404) throw e; });
      deleted = { type: "expense", id: tx.expenseId };
    } else {
      const ref = expensesCol(companyId).doc(tx.expenseId);
      if ((await ref.get()).exists) await ref.set(EXPENSE_LINK_CLEAR, { merge: true });
    }
  }
  const now = new Date().toISOString();
  await txCol(companyId).doc(tx.id).set({ ...LINK_CLEAR, updatedAt: now }, { merge: true });
  if (tx.transferPairId) {
    const pairRef = txCol(companyId).doc(tx.transferPairId);
    const pair = await pairRef.get();
    if (pair.exists && pair.data().transferPairId === tx.id) await pairRef.set({ ...LINK_CLEAR, updatedAt: now }, { merge: true });
  }
  await logAudit({ companyId, uid, email, action: "bankTransaction.undo", payload: { transactionId: tx.id, previous: tx.status, deleted } });
  return { transaction: { ...tx, ...LINK_CLEAR }, deleted };
}

module.exports = {
  STATUSES,
  previewImport,
  commitImport,
  listImports,
  deleteImport,
  listTransactions,
  suggestions,
  reconcile,
  undo,
  computeForex,
  rankInvoices,
};
