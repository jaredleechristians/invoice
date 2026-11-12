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
const { LINK_CLEAR, PAYMENT_LINK_CLEAR, EXPENSE_LINK_CLEAR, txCol, releaseTransaction } = require("./bankLinks");
const invoices = require("./invoices");
const payments = require("./payments");
const expenses = require("./expenses");
const { computeForex, baseReceivedOf, forexGainBaseOf } = require("./ledger/forex");
const { transferPairLines, transferInTransitLines } = require("./ledger/rules");
const { planBankEntry, planBankReverse, averageCostRate, bankLedgerId } = require("./ledger/bankPost");
const { baseCurrencyOf, systemAccountsOf, ensureGoLiveDate } = require("./ledger/post");

const STATUSES = ["unreconciled", "matched", "categorised", "transfer", "ignored"];
const MAX_FILE_CHARS = 1_500_000;
const PREVIEW_ROWS = 200;

const importsCol = (companyId) => companyRef(getDb(), companyId).collection("bankImports");
const paymentsCol = (companyId) => companyRef(getDb(), companyId).collection("payments");
const expensesCol = (companyId) => companyRef(getDb(), companyId).collection("expenses");

async function loadTx(companyId, transactionId) {
  const snap = await txCol(companyId).doc(String(transactionId || "")).get();
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Bank transaction not found");
  return { id: snap.id, ...snap.data() };
}

// ---------- import ----------

async function existingIds(companyId, ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += 50) {
    const snaps = await Promise.all(ids.slice(i, i + 50).map((id) => txCol(companyId).doc(id).get()));
    // Lines from a deleted import don't count, so the statement can be imported again.
    for (const s of snaps) if (s.exists && !s.data().deletedAt) found.add(s.id);
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
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Import not found");
  const lines = await fetchAll(txCol(companyId).where("importId", "==", importId));
  if (lines.some((t) => t.status !== "unreconciled")) throw httpError(409, "Undo the reconciled lines in this import first");
  const db = getDb();
  const gone = { deletedAt: new Date().toISOString(), deletedBy: uid };
  for (let i = 0; i < lines.length; i += 400) {
    const batch = db.batch();
    for (const t of lines.slice(i, i + 400)) batch.set(txCol(companyId).doc(t.id), gone, { merge: true });
    await batch.commit();
  }
  await importsCol(companyId).doc(importId).set(gone, { merge: true });
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

async function loadBaseCurrency(companyId) {
  const snap = await companyRef(getDb(), companyId).get();
  return baseCurrencyOf(snap.exists ? snap.data() : {});
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

async function invoiceRateFor(companyId, uid, email, role, invoice, body, baseCurrency) {
  const supplied = body.invoiceRate !== undefined && body.invoiceRate !== "" && body.invoiceRate !== null ? invoices.cleanExchangeRate(body.invoiceRate) : null;
  const base = baseCurrency || "ZAR";
  if (supplied && !(invoice.exchangeRate > 0) && invoice.currency !== base) {
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
  const baseCurrency = await loadBaseCurrency(companyId);
  const rate = await invoiceRateFor(companyId, uid, email, role, invoice, body, baseCurrency);
  const fx = computeForex({
    invoiceCurrency: invoice.currency,
    amount,
    receivedCurrency: tx.currency,
    receivedAmount: sameCurrency ? amount : tx.amount,
    invoiceRate: rate,
    baseCurrency,
  });
  const method = account.bank === "wise" ? "wise" : account.bank === "paypal" ? "paypal" : "bank_transfer";
  const res = await payments.recordPayment(
    companyId, uid, email, role,
    { invoiceId: invoice.id, amount, paidAt: tx.date, method, reference: tx.reference || tx.description, note: "From bank import" },
    { transactionId: tx.id, bankAccountId: tx.accountId, ...fx }
  );
  await ensureGoLiveDate(companyId, tx.date);
  const transaction = res.transaction ? { id: tx.id, ...tx, ...res.transaction } : { ...tx, status: "matched", paymentId: res.payment.id };
  return { transaction, payment: res.payment, forex: fx };
}

async function matchPayment(ctx, tx, body) {
  const { companyId, uid, email, role } = ctx;
  if (!(tx.amount > 0)) throw httpError(400, "Only money in can be matched to a payment");
  const ref = paymentsCol(companyId).doc(String(body.paymentId || ""));
  const snap = await ref.get();
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Payment not found");
  const payment = { id: snap.id, ...snap.data() };
  if (payment.voided) throw httpError(409, "That payment is void");
  if (payment.transactionId) throw httpError(409, "That payment is already linked to a bank line");
  const invoice = payment.invoiceId ? await invoices.getInvoice(companyId, payment.invoiceId) : null;
  const currency = payment.currency || "ZAR";
  if (currency === tx.currency && !near(payment.amount, tx.amount)) throw httpError(400, "Payment amount does not match the bank line");
  const baseCurrency = await loadBaseCurrency(companyId);
  const rate = invoice ? await invoiceRateFor(companyId, uid, email, role, invoice, body, baseCurrency) : null;
  const fx = computeForex({
    invoiceCurrency: currency,
    amount: payment.amount,
    receivedCurrency: tx.currency,
    receivedAmount: tx.amount,
    invoiceRate: rate,
    baseCurrency,
  });
  const ctxLedger = await invoices.loadLedgerCtx(companyId);
  const account = await getAccount(companyId, tx.accountId);
  const db = getDb();
  let patch;
  await db.runTransaction(async (t) => {
    const inv = invoice || (payment.invoiceId ? (await t.get(companyRef(db, companyId).collection("invoices").doc(payment.invoiceId))).data() : {});
    const linked = { ...payment, transactionId: tx.id, bankAccountId: tx.accountId, ...fx };
    const bankPost = await payments.planPaymentBankPost(t, companyId, {
      paymentId: payment.id,
      payment: { ...linked, created: null },
      invoice: inv || { currency, exchangeRate: rate, invoiceNumber: payment.invoiceNumber, customerName: payment.customerName },
      bankTx: tx,
      bankAccount: account,
      event: "post",
      createdBy: uid,
      ctx: ctxLedger,
    });
    t.set(ref, { ...fx, transactionId: tx.id, bankAccountId: tx.accountId, bankLedger: bankPost.ledger }, { merge: true });
    bankPost.commit(t);
    patch = { ...bankPost.patch, created: null };
  });
  await ensureGoLiveDate(companyId, tx.date);
  return { transaction: { ...tx, ...patch }, forex: fx };
}

async function createExpenseFor(ctx, tx, body) {
  const { companyId, uid, email, role } = ctx;
  if (!(tx.amount < 0)) throw httpError(400, "Only money out can become an expense");
  const baseCurrency = await loadBaseCurrency(companyId);
  const payload = {
    date: tx.date,
    vendor: body.vendor !== undefined ? body.vendor : tx.description,
    categoryId: body.categoryId || "",
    amount: -tx.amount,
    currency: tx.currency,
    reference: tx.reference,
    notes: body.notes !== undefined ? body.notes : tx.description,
  };
  if (tx.currency !== baseCurrency && body.exchangeRate) payload.exchangeRate = body.exchangeRate;
  const exp = await expenses.createExpense(companyId, uid, email, role, payload, {
    transactionId: tx.id,
    bankAccountId: tx.accountId,
  });
  await ensureGoLiveDate(companyId, tx.date);
  const transaction = exp.transaction ? { id: tx.id, ...tx, ...exp.transaction } : { ...tx, status: "categorised", expenseId: exp.id };
  const { transaction: _ignored, ...expense } = exp;
  return { transaction, expense: { ...expense, transactionId: tx.id, bankAccountId: tx.accountId } };
}

async function matchExpense(ctx, tx, body) {
  const { companyId, uid } = ctx;
  if (!(tx.amount < 0)) throw httpError(400, "Only money out can be matched to an expense");
  const exp = await expenses.getExpense(companyId, String(body.expenseId || ""));
  if (exp.transactionId) throw httpError(409, "That expense is already linked to a bank line");
  const account = await getAccount(companyId, tx.accountId);
  const ctxLedger = await invoices.loadLedgerCtx(companyId);
  const base = ctxLedger.baseCurrency;
  const patchExpense = { transactionId: tx.id, bankAccountId: tx.accountId };
  // Foreign expense paid from a base-currency account: stamp the settlement rate if it has none.
  if (exp.currency && exp.currency !== base && account.currency === base && !(Number(exp.exchangeRate) > 0) && exp.amount) {
    patchExpense.exchangeRate = roundMoney(Math.abs(tx.amount) / exp.amount);
  }
  const merged = { ...exp, ...patchExpense };
  const db = getDb();
  let patch;
  await db.runTransaction(async (t) => {
    const bankPost = await expenses.planExpenseBankPost(t, companyId, {
      expenseId: exp.id,
      expense: merged,
      bankTx: tx,
      bankAccount: account,
      event: "post",
      createdBy: uid,
      ctx: ctxLedger,
      created: null,
    });
    t.set(expensesCol(companyId).doc(exp.id), { ...patchExpense, bankLedger: bankPost.ledger }, { merge: true });
    bankPost.commit(t);
    patch = { ...bankPost.patch, created: null };
  });
  await ensureGoLiveDate(companyId, tx.date);
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
  const ctxLedger = await invoices.loadLedgerCtx(companyId);
  const account = await getAccount(companyId, tx.accountId);
  const pairAccount = pair ? await getAccount(companyId, pair.accountId) : null;
  const db = getDb();
  let patch;
  let pairPatch = null;
  await db.runTransaction(async (t) => {
    const finishPatch = (line, extra) => ({
      status: "transfer",
      matchLabel: "Transfer",
      created: null,
      reconciledAt: new Date().toISOString(),
      reconciledBy: uid,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
    if (pair && pairAccount) {
      const outbound = tx.amount < 0 ? tx : pair;
      const inbound = tx.amount < 0 ? pair : tx;
      const sendAccount = outbound.id === tx.id ? account : pairAccount;
      const receiveAccount = inbound.id === tx.id ? account : pairAccount;
      let sendRate = 1;
      if (sendAccount.currency !== ctxLedger.baseCurrency) {
        sendRate = await averageCostRate(t, companyId, bankLedgerId(sendAccount.id), { asOf: outbound.date });
      }
      const lines = transferPairLines({
        sendLedgerAccountId: bankLedgerId(sendAccount.id),
        sendBankAccountId: sendAccount.id,
        sendCurrency: sendAccount.currency || outbound.currency,
        sendAmount: outbound.amount,
        sendRate,
        receiveLedgerAccountId: bankLedgerId(receiveAccount.id),
        receiveBankAccountId: receiveAccount.id,
        receiveCurrency: receiveAccount.currency || inbound.currency,
        receiveAmount: inbound.amount,
        systemAccounts: ctxLedger.systemAccounts,
        baseCurrency: ctxLedger.baseCurrency,
      });
      const ids = [tx.id, pair.id].sort();
      const planned = await planBankEntry(t, companyId, {
        type: "transfer",
        id: `${ids[0]}_${ids[1]}`,
        date: tx.date,
        lines,
        event: "post",
        createdBy: uid,
        memo: "Transfer",
        currentLedger: tx.ledger || pair.ledger,
        ctx: ctxLedger,
      });
      patch = finishPatch(tx, { transferPairId: pair.id, ledger: planned.ledger });
      pairPatch = finishPatch(pair, { transferPairId: tx.id, ledger: planned.ledger });
      planned.commit(t);
      t.set(txCol(companyId).doc(tx.id), patch, { merge: true });
      t.set(txCol(companyId).doc(pair.id), pairPatch, { merge: true });
    } else {
      let rate = 1;
      if (account.currency !== ctxLedger.baseCurrency) {
        rate = await averageCostRate(t, companyId, bankLedgerId(account.id), { asOf: tx.date });
      }
      const lines = transferInTransitLines({
        bankLedgerAccountId: bankLedgerId(account.id),
        bankAccountId: account.id,
        currency: account.currency || tx.currency,
        amount: tx.amount,
        rate,
        systemAccounts: ctxLedger.systemAccounts,
        baseCurrency: ctxLedger.baseCurrency,
      });
      const planned = await planBankEntry(t, companyId, {
        type: "transfer",
        id: tx.id,
        date: tx.date,
        lines,
        event: "post",
        createdBy: uid,
        memo: "Transfer",
        currentLedger: tx.ledger,
        ctx: ctxLedger,
      });
      patch = finishPatch(tx, { transferPairId: "", ledger: planned.ledger });
      planned.commit(t);
      t.set(txCol(companyId).doc(tx.id), patch, { merge: true });
    }
  });
  await ensureGoLiveDate(companyId, tx.date);
  return { transaction: { ...tx, ...patch }, pair: pair ? { ...pair, ...pairPatch } : null };
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
      const snap = await ref.get();
      if (snap.exists) {
        const current = snap.data();
        await ref.set({
          ...PAYMENT_LINK_CLEAR,
          bankLedger: { entryId: null, version: Number(current.bankLedger?.version) || 0 },
        }, { merge: true });
      }
    }
  }
  if (tx.expenseId) {
    if (created?.type === "expense" && body.deleteCreated) {
      await expenses.deleteExpense(companyId, uid, email, role, tx.expenseId).catch((e) => { if (e.status !== 404) throw e; });
      deleted = { type: "expense", id: tx.expenseId };
    } else {
      const ref = expensesCol(companyId).doc(tx.expenseId);
      const snap = await ref.get();
      if (snap.exists) {
        const current = snap.data();
        await ref.set({
          ...EXPENSE_LINK_CLEAR,
          bankLedger: { entryId: null, version: Number(current.bankLedger?.version) || 0 },
        }, { merge: true });
      }
    }
  }
  await releaseTransaction(companyId, tx.id, { createdBy: uid });
  const updated = await txCol(companyId).doc(tx.id).get();
  const cleared = updated.exists ? { id: updated.id, ...updated.data() } : { ...tx, ...LINK_CLEAR };
  await logAudit({ companyId, uid, email, action: "bankTransaction.undo", payload: { transactionId: tx.id, previous: tx.status, deleted } });
  return { transaction: cleared, deleted };
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
