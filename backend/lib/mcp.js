/**
 * MCP server (Model Context Protocol) for one company, authenticated by an
 * API key. Built fresh per request (stateless Streamable HTTP).
 *
 * Read tools for every key; write tools only for read_write keys. Writes reuse
 * the normal service functions and their checks. No publish, void or delete.
 */
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { withAuditContext } = require("./audit");
const { httpError } = require("./errors");
const companies = require("./companies");
const customers = require("./customers");
const invoices = require("./invoices");
const payments = require("./payments");
const expenses = require("./expenses");
const reports = require("./reports");
const bankAccounts = require("./bankAccounts");
const bank = require("./bankTransactions");
const { buildStatement } = require("./statements");
const { listReceivables } = require("./receivables");
const { canWriteRecords } = require("./permissions");

const pkg = require("../package.json");

const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const ID = z.string().min(1).max(100);
const CURRENCY = z.string().regex(/^[A-Z]{3}$/, "3-letter currency code, e.g. ZAR");
const PAGE = {
  limit: z.number().int().min(1).max(100).optional().describe("Max rows (default 25, max 100)"),
  offset: z.number().int().min(0).optional().describe("Rows to skip (use nextOffset from the last page)"),
};

function page(rows, { limit = 25, offset = 0 } = {}) {
  const items = rows.slice(offset, offset + limit);
  return { total: rows.length, offset, items, nextOffset: offset + items.length < rows.length ? offset + items.length : null };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
const INVOICE_ROW = ["id", "invoiceNumber", "status", "draft", "voided", "customerId", "customerName", "currency", "issueDateIso", "dueDateIso", "total", "paidAmount", "outstanding"];
const ITEM = z.object({
  description: z.string().min(1).max(500),
  qty: z.number().positive().optional().describe("Default 1"),
  unitPrice: z.number().describe("Price per unit, excluding VAT"),
  note: z.string().max(1000).optional(),
});

const text = (data) => ({ content: [{ type: "text", text: JSON.stringify(data) }] });
const fail = (err) => ({ isError: true, content: [{ type: "text", text: err?.message || "Something went wrong" }] });

/**
 * ctx: { companyId, uid, email, role, apiKey: { id, scope } }
 */
function buildMcpServer(ctx) {
  const server = new McpServer({ name: "invoice", version: pkg.version });
  const who = [ctx.companyId, ctx.uid, ctx.email, ctx.role];
  const canWrite = ctx.apiKey?.scope === "read_write" && canWriteRecords(ctx.role);

  const read = (name, description, inputSchema, fn) =>
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: true } }, async (args) => {
      try {
        return text(await fn(args || {}));
      } catch (err) {
        return fail(err);
      }
    });

  const write = (name, description, inputSchema, fn) => {
    if (!canWrite) return;
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: false, destructiveHint: false } }, async (args) => {
      try {
        if (ctx.apiKey?.scope !== "read_write") throw httpError(403, "This API key is read only");
        return text(await withAuditContext({ via: "mcp", apiKeyId: ctx.apiKey.id }, () => fn(args || {})));
      } catch (err) {
        return fail(err);
      }
    });
  };

  // ---------- read ----------

  read("get_company", "Company basics: name, currencies, VAT, tax year end, payment terms.", {}, async () => {
    const c = await companies.getCompany(ctx.companyId);
    return pick(c, ["id", "name", "legalName", "defaultCurrency", "currencies", "vatRegistered", "vatRate", "taxYearEndMonth", "paymentTermsDays", "invoicePrefix", "quotePrefix"]);
  });

  read("list_customers", "Customers, optionally filtered by name or email.", { q: z.string().max(100).optional(), ...PAGE }, async (a) => {
    const rows = await customers.listCustomers(ctx.companyId, { q: a.q });
    return page(rows.map((c) => pick(c, ["id", "name", "email", "phone", "currency"])), a);
  });

  read("get_customer", "One customer's details.", { customerId: ID }, async (a) => {
    const c = await customers.getCustomer(ctx.companyId, a.customerId);
    if (!c) throw httpError(404, "Customer not found");
    return pick(c, ["id", "name", "email", "phone", "address", "taxNumber", "currency", "notes"]);
  });

  read("get_customer_statement", "Customer statement for a period: opening balance, invoices, payments, closing balance and ageing, per currency.", {
    customerId: ID, from: ISO.optional(), to: ISO.optional(),
  }, async (a) => {
    const st = await buildStatement(ctx.companyId, a.customerId, { from: a.from, to: a.to });
    return { customer: pick(st.customer, ["id", "name"]), period: st.period, ledger: st.ledger, aging: st.aging };
  });

  read("list_invoices", "Invoices, newest first. status: draft, unpaid, partial, paid, overdue, void, or 'open' for anything with a balance.", {
    status: z.string().max(40).optional(), customerId: ID.optional(), currency: CURRENCY.optional(), q: z.string().max(100).optional(), ...PAGE,
  }, async (a) => {
    const rows = await invoices.listInvoices(ctx.companyId, { status: a.status, customerId: a.customerId, currency: a.currency, q: a.q });
    return page(rows.map((i) => pick(i, INVOICE_ROW)), a);
  });

  read("get_invoice", "One invoice with its lines and totals.", { invoiceId: ID }, async (a) => {
    const i = await invoices.requireInvoice(ctx.companyId, a.invoiceId);
    return {
      ...pick(i, [...INVOICE_ROW, "billTo", "reference", "notes", "subtotal", "vatTotal", "vatRate", "exchangeRate"]),
      items: (i.items || []).map((it) => pick(it, ["description", "qty", "unitPrice", "note", "taxable"])),
    };
  });

  read("get_receivables", "Who owes money: outstanding per customer and currency, plus aged receivables buckets.", { asOf: ISO.optional() }, async (a) => {
    const [byCustomer, r] = await Promise.all([listReceivables(ctx.companyId), reports.companyReports(ctx.companyId, { asOf: a.asOf })]);
    return { byCustomer, aged: r.agedReceivables };
  });

  read("get_reports", "Income (payments received), expenses and profit for a period, by month, category and customer. Defaults to this calendar year.", {
    from: ISO.optional(), to: ISO.optional(),
  }, async (a) => {
    const r = await reports.companyReports(ctx.companyId, { from: a.from, to: a.to });
    return pick(r, ["range", "profitAndLoss", "incomeByMonth", "expensesByCategory", "incomeByCustomer", "invoicedByMonth"]);
  });

  read("list_expenses", "Expenses, newest first.", {
    from: ISO.optional(), to: ISO.optional(), categoryId: ID.optional(), currency: CURRENCY.optional(), q: z.string().max(100).optional(), ...PAGE,
  }, async (a) => {
    const rows = await expenses.listExpenses(ctx.companyId, a);
    return page(rows.map((e) => pick(e, ["id", "date", "vendor", "amount", "currency", "categoryId", "categoryName", "reference", "notes"])), a);
  });

  read("list_expense_categories", "Expense categories (ids for record_expense).", {}, async () => {
    const rows = await expenses.listCategories(ctx.companyId);
    return rows.map((c) => pick(c, ["id", "name"]));
  });

  read("list_payments", "Payments received, newest first.", { invoiceId: ID.optional(), ...PAGE }, async (a) => {
    const rows = await payments.listPayments(ctx.companyId, { invoiceId: a.invoiceId });
    return page(rows.map((p) => pick(p, ["id", "invoiceId", "invoiceNumber", "customerName", "amount", "currency", "paidAtIso", "method", "reference", "voided"])), a);
  });

  read("list_bank_accounts", "Bank accounts with balances (no full account numbers).", {}, async () => {
    const rows = await bankAccounts.listAccounts(ctx.companyId);
    return rows.map((x) => pick(x, ["id", "name", "bank", "currency", "accountLast4", "balance", "transactionCount", "unreconciledCount"]));
  });

  read("list_bank_transactions", "Imported bank lines, newest first. status: unreconciled, reconciled or ignored.", {
    accountId: ID.optional(), status: z.enum(["unreconciled", "reconciled", "ignored"]).optional(), from: ISO.optional(), to: ISO.optional(), q: z.string().max(100).optional(), ...PAGE,
  }, async (a) => {
    const rows = await bank.listTransactions(ctx.companyId, a);
    return page(rows.map((t) => pick(t, ["id", "accountId", "date", "amount", "currency", "description", "reference", "status", "matchLabel"])), a);
  });

  read("get_bank_transaction_suggestions", "Likely matches (invoices, payments, expenses, transfers) for one bank line.", { transactionId: ID }, (a) =>
    bank.suggestions(ctx.companyId, a.transactionId)
  );

  // ---------- write (read_write keys only) ----------

  write("create_customer", "Create a customer.", {
    name: z.string().min(1).max(200), email: z.string().max(200).optional(), phone: z.string().max(50).optional(),
    address: z.string().max(1000).optional(), taxNumber: z.string().max(50).optional(), currency: CURRENCY.optional(), notes: z.string().max(2000).optional(),
  }, async (a) => pick(await customers.createCustomer(...who, a), ["id", "name", "email", "currency"]));

  write("create_draft_invoice", "Create a DRAFT invoice (never published; publish it in the app).", {
    customerId: ID, items: z.array(ITEM).min(1).max(100), issueDate: ISO.optional(), dueDate: ISO.optional(),
    currency: CURRENCY.optional(), reference: z.string().max(120).optional(), notes: z.string().max(2000).optional(),
  }, async (a) => {
    const inv = await invoices.createInvoice(...who, { ...a, draft: true, finalize: false });
    return pick(inv, [...INVOICE_ROW, "total"]);
  });

  write("update_draft_invoice", "Change a DRAFT invoice. Published invoices can't be changed here.", {
    invoiceId: ID, customerId: ID.optional(), items: z.array(ITEM).min(1).max(100).optional(), issueDate: ISO.optional(), dueDate: ISO.optional(),
    reference: z.string().max(120).optional(), notes: z.string().max(2000).optional(),
  }, async (a) => {
    const existing = await invoices.requireInvoice(ctx.companyId, a.invoiceId);
    if (!existing.draft) throw httpError(409, "Only draft invoices can be changed with the API");
    const { invoiceId, ...changes } = a;
    const inv = await invoices.updateInvoice(...who, invoiceId, { ...changes, draft: true });
    return pick(inv, INVOICE_ROW);
  });

  write("record_expense", "Record an expense (money spent).", {
    date: ISO, amount: z.number().positive(), currency: CURRENCY, vendor: z.string().min(1).max(200),
    categoryId: ID.optional().describe("From list_expense_categories"), reference: z.string().max(120).optional(), notes: z.string().max(2000).optional(),
  }, async (a) => pick(await expenses.createExpense(...who, a), ["id", "date", "vendor", "amount", "currency", "categoryId"]));

  write("record_payment", "Record a payment received against a PUBLISHED invoice.", {
    invoiceId: ID, amount: z.number().positive(), paidAt: ISO.optional().describe("Default today"),
    method: z.enum(payments.PAYMENT_METHODS).optional(), reference: z.string().max(120).optional(), note: z.string().max(500).optional(),
  }, async (a) => {
    const r = await payments.recordPayment(...who, a);
    return pick(r.payment || r, ["id", "invoiceId", "amount", "currency", "paidAt", "paidAtIso", "paidAmount", "status"]);
  });

  write("reconcile_bank_transaction", "Match or categorise one bank line: match_invoice (records a payment), match_payment, create_expense (categorise money out), match_expense, transfer, or ignore.", {
    transactionId: ID,
    action: z.enum(["match_invoice", "match_payment", "create_expense", "match_expense", "transfer", "ignore"]),
    invoiceId: ID.optional(), paymentId: ID.optional(), expenseId: ID.optional(), pairTransactionId: ID.optional(),
    amount: z.number().positive().optional().describe("Invoice-currency amount when the bank line is in another currency"),
    invoiceRate: z.number().positive().optional(), categoryId: ID.optional(), vendor: z.string().max(200).optional(),
    notes: z.string().max(2000).optional(), note: z.string().max(300).optional(),
  }, async (a) => {
    const { transactionId, ...body } = a;
    const r = await bank.reconcile(...who, transactionId, body);
    return r?.transaction ? { transaction: pick(r.transaction, ["id", "status", "matchLabel"]) } : r;
  });

  return server;
}

module.exports = { buildMcpServer };
