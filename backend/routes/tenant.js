const express = require("express");
const { firebaseConfigured } = require("../lib/firebase");
const { requireUser, requireMember } = require("../lib/auth");
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
const { importLocalInvoice } = require("../lib/importLocal");
const { renderStatementHtml } = require("../lib/statementHtml");
const { renderDocumentHtml } = require("../lib/documentHtml");
const { htmlToPdfBuffer } = require("../lib/pdf");
const { runTenantChat } = require("../lib/tenantChat");

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
const company = express.Router({ mergeParams: true });
router.use("/companies/:companyId", requireUser, requireMember, company);

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

// ---------- customers ----------

company.get("/customers", h(async (req) => ({ customers: await customers.listCustomers(req.companyId, { q: req.query.q }) })));
company.post("/customers", h((req) => customers.createCustomer(...actor(req), req.body || {}), 201));
company.patch("/customers/:customerId", h((req) => customers.updateCustomer(...actor(req), req.params.customerId, req.body || {})));
company.delete("/customers/:customerId", h((req) => customers.deleteCustomer(...actor(req), req.params.customerId)));

company.get("/customers/:customerId/statement", h((req) => buildStatement(req.companyId, req.params.customerId, { asOf: req.query.asOf })));
company.get("/customers/:customerId/statement.pdf", h(async (req, res) => {
  const statement = await buildStatement(req.companyId, req.params.customerId, { asOf: req.query.asOf });
  const c = await invoices.loadCompany(req.companyId);
  const html = renderStatementHtml(statement, { companyName: c.name || "" });
  await sendPdf(res, html, `${safeName(statement.customer?.name, "statement")}-statement.pdf`);
}));

company.get("/receivables", h(async (req) => ({ receivables: await listReceivables(req.companyId) })));

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

// ---------- reports ----------

company.get("/summary", h((req) => reports.companySummary(req.companyId)));
company.get("/reports", h((req) => reports.companyReports(req.companyId, { from: req.query.from, to: req.query.to, asOf: req.query.asOf })));

// ---------- read-only assistant ----------

company.post("/assistant", h(async (req) => {
  const messages = req.body?.messages;
  if (!Array.isArray(messages) || !messages.length) throw httpError(400, "messages array is required");
  return runTenantChat({ companyId: req.companyId, uid: req.user.uid, email: req.user.email, messages });
}));

module.exports = router;
