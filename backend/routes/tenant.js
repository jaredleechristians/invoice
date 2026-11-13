const express = require("express");
const { firebaseConfigured } = require("../lib/firebase");
const { requireUser, requireUserOrKey, requireMember } = require("../lib/auth");
const { enforceApiKeyScope } = require("../lib/apiKeyScope");
const apiKeys = require("../lib/apiKeys");
const { httpError } = require("../lib/errors");
const companies = require("../lib/companies");
const customers = require("../lib/customers");
const invoices = require("../lib/invoices");
const payments = require("../lib/payments");
const products = require("../lib/products");
const quotes = require("../lib/quotes");
const expenses = require("../lib/expenses");
const reports = require("../lib/reports");
const { buildStatement } = require("../lib/statements");
const { listReceivables } = require("../lib/receivables");
const creditNotes = require("../lib/creditNotes");
const timeEntries = require("../lib/timeEntries");
const agreements = require("../lib/agreements");
const { importLocalInvoice } = require("../lib/importLocal");
const { renderStatementHtml } = require("../lib/statementHtml");
const { renderDocumentHtml } = require("../lib/documentHtml");
const { htmlToPdfBuffer } = require("../lib/pdf");
const { runTenantChat } = require("../lib/tenantChat");
const assistantActions = require("../lib/assistantActions");
const bankAccounts = require("../lib/bankAccounts");
const bank = require("../lib/bankTransactions");
const ledgerAccounts = require("../lib/ledger/accounts");
const ledgerJournals = require("../lib/ledger/journals");
const { catchUpCompany } = require("../lib/ledger/catchup");

const router = express.Router();

router.use((req, res, next) => {
  if (!firebaseConfigured()) {
    return res.status(503).json({ error: "Signed-in features are not configured (Firebase is missing)." });
  }
  next();
});

/** Wrap an async handler: JSON result, error → {error} with status. */
const h = (fn, status = 200) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (res.headersSent) return;
    res.status(status).json(out ?? { ok: true });
  } catch (err) {
    if (!err.status || err.status >= 500) console.error(`[tenant] ${req.method} ${req.path}:`, err);
    res.status(err.status || 500).json({ error: err.message });
  }
};

// Every /companies/:companyId/* route requires membership of that company.
// These are the only routes that accept API keys (scoped by enforceApiKeyScope).
const company = express.Router({ mergeParams: true });
router.use("/companies/:companyId", requireUserOrKey, requireMember, enforceApiKeyScope, company);

const actor = (req) => [req.companyId, req.user.uid, req.user.email, req.role];
const safeName = (s, fallback) => String(s || fallback).replace(/[^\w.-]+/g, "-").slice(0, 60);

async function sendPdf(res, html, filename) {
  const { buffer } = await htmlToPdfBuffer(html, { filename });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(buffer);
}

// ---------- session ----------

router.get("/me", requireUser, h(async (req) => ({ user: req.user, companies: await companies.listCompaniesForUser(req.user.uid) })));

router.post("/bootstrap", requireUser, h((req) =>
  companies.bootstrapUser({ uid: req.user.uid, email: req.user.email, displayName: req.user.name })
));

router.post("/companies", requireUser, h((req) =>
  companies.createCompany({ uid: req.user.uid, email: req.user.email, name: req.body?.name }), 201
));

router.get("/invites/:token", requireUser, h((req) => companies.previewInvite(req.params.token)));
router.post("/invites/:token/accept", requireUser, h((req) =>
  companies.acceptInvite(req.params.token, req.user.uid, req.user.email)
));

// ---------- company settings & members ----------

company.get("/", h(async (req) => ({ ...(await companies.getCompany(req.companyId)), role: req.role })));
company.patch("/", h(async (req) => ({ ...(await companies.updateCompanySettings(...actor(req), req.body || {})), role: req.role })));

company.get("/members", h(async (req) => ({ members: await companies.listMembers(req.companyId), me: req.user.uid, role: req.role })));
company.patch("/members/:memberUid", h((req) => companies.updateMemberRole(...actor(req), req.params.memberUid, req.body?.role)));
company.delete("/members/:memberUid", h((req) => companies.removeMember(...actor(req), req.params.memberUid)));

company.get("/invites", h(async (req) => ({ invites: await companies.listInvites(req.companyId, req.role) })));
company.post("/invites", h((req) => companies.createInvite(...actor(req), { email: req.body?.email, role: req.body?.role }), 201));
company.delete("/invites/:inviteId", h((req) => companies.revokeInvite(...actor(req), req.params.inviteId)));

// ---------- API keys (signed-in users only; keys can't manage keys) ----------

const noApiKey = (req) => {
  if (req.apiKey) throw httpError(403, "API keys can't manage API keys");
};
company.get("/api-keys", h(async (req) => {
  noApiKey(req);
  return { keys: await apiKeys.listKeys(req.companyId, req.user.uid, req.role) };
}));
company.post("/api-keys", h(async (req) => {
  noApiKey(req);
  return apiKeys.createKey(...actor(req), req.body || {});
}, 201));
company.post("/api-keys/:keyId/revoke", h(async (req) => {
  noApiKey(req);
  return apiKeys.revokeKey(...actor(req), req.params.keyId);
}));

// ---------- customers ----------

company.get("/customers", h(async (req) => ({ customers: await customers.listCustomers(req.companyId, { q: req.query.q }) })));
company.post("/customers", h((req) => customers.createCustomer(...actor(req), req.body || {}), 201));
company.patch("/customers/:customerId", h((req) => customers.updateCustomer(...actor(req), req.params.customerId, req.body || {})));
company.delete("/customers/:customerId", h((req) => customers.deleteCustomer(...actor(req), req.params.customerId)));

const statementRange = (q) => ({ from: q.from, to: q.to, asOf: q.asOf });
company.get("/customers/:customerId/statement", h((req) => buildStatement(req.companyId, req.params.customerId, statementRange(req.query))));
company.get("/customers/:customerId/statement.pdf", h(async (req, res) => {
  const statement = await buildStatement(req.companyId, req.params.customerId, statementRange(req.query));
  const c = await invoices.loadCompany(req.companyId);
  const html = renderStatementHtml(statement, { company: c });
  if (req.query.format === "html") return res.type("html").send(html);
  await sendPdf(res, html, `${safeName(statement.customer?.name, "statement")}-statement-${statement.period.to}.pdf`);
}));

company.get("/receivables", h(async (req) => ({ receivables: await listReceivables(req.companyId) })));
company.get("/customers/:customerId/credit", h((req) => customers.customerCreditSnapshot(req.companyId, req.params.customerId)));

// ---------- credit notes ----------

company.get("/credit-notes", h(async (req) => ({
  creditNotes: await creditNotes.listCreditNotes(req.companyId, {
    q: req.query.q,
    invoiceId: req.query.invoiceId,
    customerId: req.query.customerId,
    status: req.query.status,
  }),
})));
company.post("/credit-notes", h((req) => creditNotes.createCreditNote(...actor(req), req.body || {}), 201));
company.get("/credit-notes/:creditNoteId", h((req) => creditNotes.requireCreditNote(req.companyId, req.params.creditNoteId)));
company.patch("/credit-notes/:creditNoteId", h((req) => creditNotes.updateCreditNote(...actor(req), req.params.creditNoteId, req.body || {})));
company.delete("/credit-notes/:creditNoteId", h((req) => creditNotes.deleteCreditNote(...actor(req), req.params.creditNoteId)));
company.post("/credit-notes/:creditNoteId/finalize", h((req) => creditNotes.finalizeCreditNote(...actor(req), req.params.creditNoteId)));
company.post("/credit-notes/:creditNoteId/void", h((req) => creditNotes.voidCreditNote(...actor(req), req.params.creditNoteId, { reason: req.body?.reason })));
company.get("/credit-notes/:creditNoteId/pdf", h(async (req, res) => {
  const doc = await creditNotes.requireCreditNote(req.companyId, req.params.creditNoteId);
  const c = await invoices.loadCompany(req.companyId);
  const html = renderDocumentHtml({ kind: "credit_note", doc, company: c });
  if (req.query.format === "html") return res.type("html").send(html);
  await sendPdf(res, html, `${safeName(doc.creditNoteNumber, "draft-credit-note")}.pdf`);
}));


// ---------- time entries ----------

company.get("/time-entries", h(async (req) => ({
  timeEntries: await timeEntries.listTimeEntries(req.companyId, {
    q: req.query.q,
    customerId: req.query.customerId,
    billable: req.query.billable,
    unbilled: req.query.unbilled,
    billed: req.query.billed,
    from: req.query.from,
    to: req.query.to,
    invoiceId: req.query.invoiceId,
    agreementId: req.query.agreementId,
    periodId: req.query.periodId,
  }),
})));
company.post("/time-entries", h((req) => timeEntries.createTimeEntry(...actor(req), req.body || {}), 201));
company.post("/time-entries/invoice", h((req) => timeEntries.createInvoiceFromTime(...actor(req), req.body || {}), 201));
company.get("/time-entries/:entryId", h((req) => timeEntries.requireTimeEntry(req.companyId, req.params.entryId)));
company.patch("/time-entries/:entryId", h((req) => timeEntries.updateTimeEntry(...actor(req), req.params.entryId, req.body || {})));
company.delete("/time-entries/:entryId", h((req) => timeEntries.deleteTimeEntry(...actor(req), req.params.entryId)));


// ---------- agreements ----------

company.get("/agreements", h(async (req) => ({
  agreements: await agreements.listAgreements(req.companyId, {
    q: req.query.q,
    customerId: req.query.customerId,
    status: req.query.status,
  }),
})));
company.get("/agreements/hours-report", h((req) =>
  agreements.hoursReport(req.companyId, { agreementId: req.query.agreementId, customerId: req.query.customerId, asOf: req.query.asOf })
));
company.post("/agreements/run", h((req) =>
  agreements.generateDueInvoices(...actor(req), { asOf: req.body?.asOf, agreementId: req.body?.agreementId })
));
company.post("/agreements", h((req) => agreements.createAgreement(...actor(req), req.body || {}), 201));
company.get("/agreements/:agreementId", h(async (req) => {
  const agreement = await agreements.requireAgreement(req.companyId, req.params.agreementId);
  const { periods } = await agreements.listAgreementPeriods(req.companyId, req.params.agreementId, { asOf: req.query.asOf });
  return { ...agreement, periods };
}));
company.patch("/agreements/:agreementId", h((req) => agreements.updateAgreement(...actor(req), req.params.agreementId, req.body || {})));
company.delete("/agreements/:agreementId", h((req) => agreements.deleteAgreement(...actor(req), req.params.agreementId)));
company.post("/agreements/:agreementId/activate", h((req) =>
  agreements.setAgreementStatus(...actor(req), req.params.agreementId, "active", { asOf: req.body?.asOf })
));
company.post("/agreements/:agreementId/pause", h((req) =>
  agreements.setAgreementStatus(...actor(req), req.params.agreementId, "paused")
));
company.post("/agreements/:agreementId/resume", h((req) =>
  agreements.setAgreementStatus(...actor(req), req.params.agreementId, "active", { asOf: req.body?.asOf })
));
company.post("/agreements/:agreementId/end", h((req) =>
  agreements.setAgreementStatus(...actor(req), req.params.agreementId, "ended", { endDate: req.body?.endDate, asOf: req.body?.asOf })
));
company.post("/agreements/:agreementId/run", h((req) =>
  agreements.generateDueInvoices(...actor(req), { asOf: req.body?.asOf, agreementId: req.params.agreementId })
));
company.get("/agreements/:agreementId/periods", h((req) =>
  agreements.listAgreementPeriods(req.companyId, req.params.agreementId, { asOf: req.query.asOf })
));
company.get("/agreements/:agreementId/hours-report", h((req) =>
  agreements.hoursReport(req.companyId, { agreementId: req.params.agreementId, asOf: req.query.asOf })
));

// ---------- products ----------

company.get("/products", h(async (req) => ({ products: await products.listProducts(req.companyId, { includeInactive: req.query.all === "1" }) })));
company.post("/products", h((req) => products.createProduct(...actor(req), req.body || {}), 201));
company.patch("/products/:productId", h((req) => products.updateProduct(...actor(req), req.params.productId, req.body || {})));
company.delete("/products/:productId", h((req) => products.deleteProduct(...actor(req), req.params.productId)));

// ---------- invoices ----------

company.get("/invoices", h(async (req) => ({
  invoices: await invoices.listInvoices(req.companyId, {
    q: req.query.q,
    status: req.query.status,
    customerId: req.query.customerId,
    currency: req.query.currency,
  }),
})));
company.post("/invoices", h((req) => invoices.createInvoice(...actor(req), req.body || {}), 201));
company.post("/invoices/import-local", h((req) => importLocalInvoice(...actor(req), req.body?.invoice || req.body), 201));
company.get("/invoices/:invoiceId", h((req) => invoices.requireInvoice(req.companyId, req.params.invoiceId)));
company.patch("/invoices/:invoiceId", h((req) => invoices.updateInvoice(...actor(req), req.params.invoiceId, req.body || {})));
company.delete("/invoices/:invoiceId", h((req) => invoices.deleteInvoice(...actor(req), req.params.invoiceId)));
company.post("/invoices/:invoiceId/finalize", h((req) => invoices.finalizeInvoice(...actor(req), req.params.invoiceId)));
company.post("/invoices/:invoiceId/void", h((req) => invoices.voidInvoice(...actor(req), req.params.invoiceId, { reason: req.body?.reason })));
company.post("/invoices/:invoiceId/duplicate", h((req) => invoices.duplicateInvoice(...actor(req), req.params.invoiceId), 201));
company.get("/invoices/:invoiceId/pdf", h(async (req, res) => {
  const doc = await invoices.requireInvoice(req.companyId, req.params.invoiceId);
  const c = await invoices.loadCompany(req.companyId);
  const html = renderDocumentHtml({ kind: "invoice", doc, company: c });
  if (req.query.format === "html") return res.type("html").send(html);
  await sendPdf(res, html, `${safeName(doc.invoiceNumber, "draft-invoice")}.pdf`);
}));

// ---------- quotes ----------

company.get("/quotes", h(async (req) => ({ quotes: await quotes.listQuotes(req.companyId, { q: req.query.q, status: req.query.status, customerId: req.query.customerId }) })));
company.post("/quotes", h((req) => quotes.createQuote(...actor(req), req.body || {}), 201));
company.get("/quotes/:quoteId", h((req) => quotes.requireQuote(req.companyId, req.params.quoteId)));
company.patch("/quotes/:quoteId", h((req) => quotes.updateQuote(...actor(req), req.params.quoteId, req.body || {})));
company.delete("/quotes/:quoteId", h((req) => quotes.deleteQuote(...actor(req), req.params.quoteId)));
company.post("/quotes/:quoteId/convert", h((req) => quotes.convertQuote(...actor(req), req.params.quoteId), 201));
company.post("/quotes/:quoteId/duplicate", h((req) => quotes.duplicateQuote(...actor(req), req.params.quoteId), 201));
company.get("/quotes/:quoteId/pdf", h(async (req, res) => {
  const doc = await quotes.requireQuote(req.companyId, req.params.quoteId);
  const c = await invoices.loadCompany(req.companyId);
  const html = renderDocumentHtml({ kind: "quote", doc, company: c });
  if (req.query.format === "html") return res.type("html").send(html);
  await sendPdf(res, html, `${safeName(doc.quoteNumber, "quote")}.pdf`);
}));

// ---------- payments ----------

company.get("/payments", h(async (req) => ({ payments: await payments.listPayments(req.companyId, { invoiceId: req.query.invoiceId }), methods: payments.PAYMENT_METHODS })));
company.post("/payments", h((req) => payments.recordPayment(...actor(req), req.body || {}), 201));
company.post("/payments/:paymentId/void", h((req) => payments.voidPayment(...actor(req), req.params.paymentId, { reason: req.body?.reason })));
company.delete("/payments/:paymentId", h((req) => payments.deletePayment(...actor(req), req.params.paymentId)));

// ---------- expenses ----------

company.get("/expense-categories", h(async (req) => ({ categories: await expenses.listCategories(req.companyId) })));
company.post("/expense-categories", h((req) => expenses.createCategory(...actor(req), req.body || {}), 201));
company.patch("/expense-categories/:categoryId", h((req) => expenses.updateCategory(...actor(req), req.params.categoryId, req.body || {})));
company.delete("/expense-categories/:categoryId", h((req) => expenses.deleteCategory(...actor(req), req.params.categoryId)));

company.get("/expenses", h(async (req) => ({
  expenses: await expenses.listExpenses(req.companyId, {
    from: req.query.from,
    to: req.query.to,
    categoryId: req.query.categoryId,
    currency: req.query.currency,
    q: req.query.q,
  }),
})));
company.post("/expenses", h((req) => expenses.createExpense(...actor(req), req.body || {}), 201));
company.get("/expenses/:expenseId", h((req) => expenses.getExpense(req.companyId, req.params.expenseId)));
company.patch("/expenses/:expenseId", h((req) => expenses.updateExpense(...actor(req), req.params.expenseId, req.body || {})));
company.delete("/expenses/:expenseId", h((req) => expenses.deleteExpense(...actor(req), req.params.expenseId)));
company.get("/expenses/:expenseId/receipt", h(async (req, res) => {
  const r = await expenses.getReceipt(req.companyId, req.params.expenseId);
  res.setHeader("Content-Type", r.contentType);
  res.setHeader("Content-Disposition", `inline; filename="${safeName(r.filename, "receipt")}"`);
  res.send(r.buffer);
}));

// ---------- bank accounts, imports and reconciliation ----------

company.get("/bank-accounts", h(async (req) => ({ accounts: await bankAccounts.listAccounts(req.companyId), banks: bankAccounts.BANK_OPTIONS })));
// Copy the old settings payment details into bank accounts (safe to repeat).
company.post("/bank-accounts/migrate", h(async (req) => {
  if (!["owner", "admin"].includes(req.role)) throw httpError(403, "Only owners and admins can do this");
  return { created: await bankAccounts.migrateLegacyAccounts(req.companyId) };
}));
company.post("/bank-accounts", h((req) => bankAccounts.createAccount(...actor(req), req.body || {}), 201));
company.patch("/bank-accounts/:accountId", h((req) => bankAccounts.updateAccount(...actor(req), req.params.accountId, req.body || {})));
company.delete("/bank-accounts/:accountId", h((req) => bankAccounts.deleteAccount(...actor(req), req.params.accountId)));

// ---------- chart of accounts (ledger) ----------

company.get("/accounts", h(async (req) => ({
  accounts: await ledgerAccounts.listLedgerAccounts(req.companyId, { includeArchived: req.query.active !== "1" }),
  types: ledgerAccounts.TYPES.map((t) => ({ value: t, label: ledgerAccounts.TYPE_LABELS[t], subtypes: ledgerAccounts.SUBTYPES[t].filter((s) => !ledgerAccounts.RESERVED_SUBTYPES.includes(s)) })),
})));
company.get("/accounts/:accountId", h((req) => ledgerAccounts.getLedgerAccount(req.companyId, req.params.accountId)));
company.post("/accounts", h((req) => ledgerAccounts.createLedgerAccount(...actor(req), req.body || {}), 201));
company.patch("/accounts/:accountId", h((req) => ledgerAccounts.updateLedgerAccount(...actor(req), req.params.accountId, req.body || {})));
company.post("/accounts/:accountId/archive", h((req) => ledgerAccounts.archiveLedgerAccount(...actor(req), req.params.accountId)));
company.post("/accounts/:accountId/unarchive", h((req) => ledgerAccounts.unarchiveLedgerAccount(...actor(req), req.params.accountId)));


// ---------- journals and trial balance (1.5.0) ----------
company.get("/journals", h(async (req) => ({
  journals: await ledgerJournals.listJournals(req.companyId, {
    accountId: req.query.accountId,
    from: req.query.from,
    to: req.query.to,
    sourceType: req.query.sourceType,
    sourceId: req.query.sourceId,
    invoiceId: req.query.invoiceId,
  }),
})));
company.get("/journals/:entryId", h((req) => ledgerJournals.getJournal(req.companyId, req.params.entryId)));
company.post("/journals", h((req) => ledgerJournals.createManualJournal(...actor(req), req.body || {}), 201));
company.post("/journals/:entryId/reverse", h((req) => ledgerJournals.reverseManualJournal(...actor(req), req.params.entryId, req.body || {})));
company.get("/ledger/trial-balance", h((req) => ledgerJournals.trialBalance(req.companyId, { asOf: req.query.asOf })));
company.get("/ledger/opening-balances", h((req) => ledgerJournals.getOpeningBalances(req.companyId)));
company.put("/ledger/opening-balances", h((req) => ledgerJournals.setOpeningBalances(...actor(req), req.body || {})));
company.post("/ledger/catch-up", h((req) => catchUpCompany(...actor(req))));


company.get("/bank-imports", h(async (req) => ({ imports: await bank.listImports(req.companyId, { accountId: req.query.accountId }) })));
company.post("/bank-imports/preview", h((req) => bank.previewImport(...actor(req), req.body || {})));
company.post("/bank-imports", h((req) => bank.commitImport(...actor(req), req.body || {}), 201));
company.delete("/bank-imports/:importId", h((req) => bank.deleteImport(...actor(req), req.params.importId)));

company.get("/bank-transactions", h(async (req) => ({
  transactions: await bank.listTransactions(req.companyId, {
    accountId: req.query.accountId,
    status: req.query.status,
    from: req.query.from,
    to: req.query.to,
    q: req.query.q,
  }),
})));
company.get("/bank-transactions/:transactionId/suggestions", h((req) => bank.suggestions(req.companyId, req.params.transactionId)));
company.post("/bank-transactions/:transactionId/reconcile", h((req) => bank.reconcile(...actor(req), req.params.transactionId, req.body || {})));
company.post("/bank-transactions/:transactionId/undo", h((req) => bank.undo(...actor(req), req.params.transactionId, req.body || {})));

// ---------- restore (undo a soft delete) ----------

company.post("/restore/:kind/:id", h((req) => require("../lib/restore").restoreRecord(...actor(req), req.params.kind, req.params.id)));

// ---------- reports ----------

company.get("/summary", h((req) => reports.companySummary(req.companyId)));
company.get("/reports", h((req) => reports.companyReports(req.companyId, { from: req.query.from, to: req.query.to, asOf: req.query.asOf })));

// ---------- assistant (reads; writes only via confirmed proposals) ----------

company.post("/assistant", h(async (req) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length) throw httpError(400, "messages array is required");
  return runTenantChat({ companyId: req.companyId, uid: req.user.uid, email: req.user.email, role: req.role, messages });
}));
company.post("/assistant/actions/:actionId/confirm", h((req) =>
  assistantActions.confirmAction({ companyId: req.companyId, uid: req.user.uid, email: req.user.email, role: req.role, actionId: req.params.actionId })
));
company.post("/assistant/actions/:actionId/cancel", h((req) =>
  assistantActions.cancelAction({ companyId: req.companyId, uid: req.user.uid, email: req.user.email, actionId: req.params.actionId })
));

module.exports = router;
