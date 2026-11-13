/**
 * MCP server (Model Context Protocol) for one company, authenticated by an
 * API key. Built fresh per request (stateless Streamable HTTP).
 *
 * Read tools for every key; write tools only for read_write keys. Writes reuse
 * the normal service functions and their role checks (void and delete need an
 * owner or admin). Deletes are soft and can be undone with restore_record.
 */
const { z } = require("zod");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { withAuditContext } = require("./audit");
const { httpError } = require("./errors");
const companies = require("./companies");
const quotes = require("./quotes");
const products = require("./products");
const { restoreRecord, RESTORE_KINDS } = require("./restore");
const customers = require("./customers");
const invoices = require("./invoices");
const payments = require("./payments");
const expenses = require("./expenses");
const reports = require("./reports");
const bankAccounts = require("./bankAccounts");
const bank = require("./bankTransactions");
const ledgerAccounts = require("./ledger/accounts");
const ledgerJournals = require("./ledger/journals");
const { buildStatement } = require("./statements");
const { listReceivables } = require("./receivables");
const creditNotes = require("./creditNotes");
const timeEntries = require("./timeEntries");
const agreements = require("./agreements");
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
const INVOICE_ROW = ["id", "invoiceNumber", "status", "draft", "voided", "customerId", "customerName", "currency", "issueDateIso", "dueDateIso", "total", "paidAmount", "creditedAmount", "outstanding"];
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

  const write = (name, description, inputSchema, fn, { destructive = false } = {}) => {
    if (!canWrite) return;
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: false, destructiveHint: destructive } }, async (args) => {
      try {
        if (ctx.apiKey?.scope !== "read_write") throw httpError(403, "This API key is read only");
        return text(await withAuditContext({ via: "mcp", apiKeyId: ctx.apiKey.id }, () => fn(args || {})));
      } catch (err) {
        return fail(err);
      }
    });
  };

  // ---------- read ----------

  read("get_company", "Company basics: name, currencies (incl. ledger base currency), VAT, tax year end, payment terms.", {}, async () => {
    const c = await companies.getCompany(ctx.companyId);
    return pick(c, ["id", "name", "legalName", "defaultCurrency", "baseCurrency", "currencies", "vatRegistered", "vatRate", "taxYearEndMonth", "paymentTermsDays", "invoicePrefix", "quotePrefix"]);
  });

  read("list_accounts", "Chart of accounts (ledger): code, name, type (asset, liability, equity, income, expense), system and bank accounts.", {
    type: z.enum(["asset", "liability", "equity", "income", "expense"]).optional(), includeArchived: z.boolean().optional(), ...PAGE,
  }, async (a) => {
    let rows = await ledgerAccounts.listLedgerAccounts(ctx.companyId, { includeArchived: Boolean(a.includeArchived) });
    if (a.type) rows = rows.filter((r) => r.type === a.type);
    return page(rows.map((r) => pick(r, ["id", "code", "name", "type", "subtype", "systemKey", "bankAccountId", "currency", "active"])), { limit: 100, ...a });
  });


  read("list_journals", "Ledger journal entries, oldest first. Filter by account, date range, or source document (invoice, payment, expense).", {
    accountId: ID.optional(), from: ISO.optional(), to: ISO.optional(),
    sourceType: z.enum(["invoice", "payment", "expense"]).optional(), sourceId: ID.optional(), invoiceId: ID.optional(), ...PAGE,
  }, async (a) => {
    const rows = await ledgerJournals.listJournals(ctx.companyId, a);
    return page(rows.map((e) => ({
      id: e.id, number: e.number, date: e.date, kind: e.kind, memo: e.memo, source: e.source, sourceKey: e.sourceKey,
      totalCents: e.totalCents, baseCurrency: e.baseCurrency, reversed: e.reversed, reversesId: e.reversesId,
      lines: (e.lines || []).map((l) => pick(l, ["accountId", "debit", "credit", "currency", "foreignAmount", "rate", "description", "customerId"])),
    })), a);
  });

  read("get_trial_balance", "Minimal trial balance in the company base currency as at a date (inclusive). Phase 1 check/report; full financial reports are later.", {
    asOf: ISO.optional(),
  }, async (a) => ledgerJournals.trialBalance(ctx.companyId, { asOf: a.asOf }));

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

  read("list_quotes", "Quotes, newest first.", { status: z.string().max(40).optional(), customerId: ID.optional(), q: z.string().max(100).optional(), ...PAGE }, async (a) => {
    const rows = await quotes.listQuotes(ctx.companyId, { status: a.status, customerId: a.customerId, q: a.q });
    return page(rows.map((x) => pick(x, ["id", "quoteNumber", "status", "customerId", "customerName", "currency", "issueDate", "validUntil", "total"])), a);
  });

  read("list_products", "Products and services with prices.", { ...PAGE }, async (a) => {
    const rows = await products.listProducts(ctx.companyId);
    return page(rows.map((x) => pick(x, ["id", "name", "kind", "unitPrice", "currency", "active", "incomeAccountId"])), a);
  });

  read("get_invoice", "One invoice with its lines and totals.", { invoiceId: ID }, async (a) => {
    const i = await invoices.requireInvoice(ctx.companyId, a.invoiceId);
    return {
      ...pick(i, [...INVOICE_ROW, "billTo", "reference", "notes", "subtotal", "vatTotal", "vatRate", "exchangeRate"]),
      items: (i.items || []).map((it) => pick(it, ["description", "qty", "unitPrice", "note", "taxable"])),
    };
  });

  read("list_credit_notes", "Credit notes, newest first.", {
    invoiceId: ID.optional(), customerId: ID.optional(), status: z.string().max(40).optional(), q: z.string().max(100).optional(), ...PAGE,
  }, async (a) => {
    const rows = await creditNotes.listCreditNotes(ctx.companyId, a);
    return page(rows.map((n) => pick(n, ["id", "creditNoteNumber", "status", "invoiceId", "invoiceNumber", "customerId", "customerName", "currency", "issueDateIso", "total", "reason", "voided", "draft"])), a);
  });

  read("get_credit_note", "One credit note with its lines and totals.", { creditNoteId: ID }, async (a) => {
    const n = await creditNotes.requireCreditNote(ctx.companyId, a.creditNoteId);
    return {
      ...pick(n, ["id", "creditNoteNumber", "status", "invoiceId", "invoiceNumber", "customerId", "customerName", "billTo", "currency", "issueDate", "exchangeRate", "subtotal", "taxTotal", "vatRate", "total", "reason", "notes", "voided", "draft"]),
      items: (n.items || []).map((it) => pick(it, ["description", "qty", "unitPrice", "note", "taxable"])),
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

  read("list_time_entries", "Time entries, newest first. Use unbilled: true for ad hoc hours that are not yet on an invoice. Agreement-linked time counts toward a retainer period.", {
    customerId: ID.optional(), agreementId: ID.optional(), periodId: ID.optional(), billable: z.boolean().optional(), unbilled: z.boolean().optional(), billed: z.boolean().optional(),
    from: ISO.optional(), to: ISO.optional(), q: z.string().max(100).optional(), ...PAGE,
  }, async (a) => {
    const rows = await timeEntries.listTimeEntries(ctx.companyId, a);
    return page(rows.map((e) => pick(e, ["id", "date", "minutes", "hours", "description", "customerId", "customerName", "personName", "billable", "rate", "status", "invoiceId", "billedAt", "agreementId", "periodId", "source"])), a);
  });

  read("get_time_entry", "One time entry.", { timeEntryId: ID }, async (a) => {
    const e = await timeEntries.requireTimeEntry(ctx.companyId, a.timeEntryId);
    return pick(e, ["id", "date", "minutes", "hours", "description", "notes", "customerId", "customerName", "personUid", "personName", "billable", "rate", "currency", "status", "invoiceId", "billedAt", "agreementId", "periodId", "source"]);
  });


  read("list_agreements", "Agreements (retainers) with a customer, lines (billable services with qty × rate), monthly value (fee), included hours and rollover policy.", {
    customerId: ID.optional(), status: z.enum(["draft", "active", "paused", "ended"]).optional(), q: z.string().max(100).optional(), ...PAGE,
  }, async (a) => {
    const rows = await agreements.listAgreements(ctx.companyId, a);
    return page(rows.map((x) => pick(x, ["id", "name", "status", "customerId", "customerName", "startDate", "endDate", "period", "lines", "hours", "fee", "currency", "rate", "overageRate", "autoPublish"])), a);
  });

  read("get_agreement", "One agreement, including its calendar periods and hours used.", { agreementId: ID, asOf: ISO.optional() }, async (a) => {
    const { agreement, periods } = await agreements.listAgreementPeriods(ctx.companyId, a.agreementId, { asOf: a.asOf });
    return {
      ...pick(agreement, ["id", "name", "status", "customerId", "customerName", "serviceId", "lines", "startDate", "endDate", "period", "hours", "fee", "currency", "rate", "overageRate", "autoPublish", "rolloverPolicy"]),
      periods: periods.map((p) => pick(p, ["id", "startsOn", "endsOn", "prorated", "hoursAllowed", "hoursRolledIn", "hoursUsed", "hoursRemaining", "hoursExpired", "hoursOverage", "hoursBilled", "fee", "status", "recurringInvoiceId"])),
    };
  });

  read("list_agreement_periods", "Calendar periods for one agreement, with allowance, used, rollover and overage hours.", {
    agreementId: ID, asOf: ISO.optional(),
  }, async (a) => {
    const { periods } = await agreements.listAgreementPeriods(ctx.companyId, a.agreementId, { asOf: a.asOf });
    return periods.map((p) => pick(p, ["id", "startsOn", "endsOn", "prorated", "daysInPeriod", "daysInFullPeriod", "hoursAllowed", "hoursRolledIn", "hoursUsed", "hoursRemaining", "hoursExpired", "hoursOverage", "hoursBilled", "fee", "status", "recurringInvoiceId"]));
  });

  read("get_hours_report", "Hours report per agreement and period (allowed, used, remaining, rolled in, expired, overage, billed). Ad hoc billable hours are listed separately.", {
    agreementId: ID.optional(), customerId: ID.optional(), asOf: ISO.optional(),
  }, async (a) => agreements.hoursReport(ctx.companyId, a));

  read("list_expenses", "Expenses, newest first.", {
    from: ISO.optional(), to: ISO.optional(), categoryId: ID.optional(), currency: CURRENCY.optional(), q: z.string().max(100).optional(), ...PAGE,
  }, async (a) => {
    const rows = await expenses.listExpenses(ctx.companyId, a);
    return page(rows.map((e) => pick(e, ["id", "date", "vendor", "amount", "currency", "categoryId", "categoryName", "reference", "notes"])), a);
  });

  read("list_expense_categories", "Expense categories (ids for record_expense).", {}, async () => {
    const rows = await expenses.listCategories(ctx.companyId);
    return rows.map((c) => pick(c, ["id", "name", "accountId"]));
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
    paymentTermsDays: z.number().int().min(0).max(365).optional(), creditLimit: z.number().min(0).optional(),
  }, async (a) => pick(await customers.createCustomer(...who, a), ["id", "name", "email", "currency", "paymentTermsDays", "creditLimit"]));

  write("create_time_entry", "Log internal or ad hoc billable time. This does not invoice the time. Internal time is non-billable unless billable is true.", {
    date: ISO, hours: z.number().positive().optional(), minutes: z.number().int().positive().optional(),
    description: z.string().min(1).max(500), notes: z.string().max(2000).optional(),
    customerId: ID.optional(), personName: z.string().max(200).optional(),
    billable: z.boolean().optional(), rate: z.number().min(0).optional(), currency: CURRENCY.optional(),
    agreementId: ID.optional().describe("Log this time against an agreement period; it then cannot be invoiced as ad hoc hours"),
  }, async (a) => pick(await timeEntries.createTimeEntry(...who, a), ["id", "date", "minutes", "hours", "description", "customerId", "customerName", "billable", "rate", "status", "agreementId", "periodId", "source"]));

  const AGREEMENT_LINE = z.object({
    serviceId: ID.describe("Product/service id from the catalogue"),
    description: z.string().max(500).optional().describe("Defaults to the service name"),
    qty: z.number().min(0).optional().describe("Quantity per period (default 1)"),
    rate: z.number().min(0).optional().describe("Unit price (defaults to the service price)"),
    includedQty: z.number().min(0).optional().describe("Time-tracked line only: hours included per period (default qty)"),
    overageRate: z.number().min(0).optional().describe("Time-tracked line only: rate for hours beyond the included qty (default rate)"),
    tracksTime: z.boolean().optional().describe("Time logged against the agreement counts against this line. At most one line; defaults to the first line"),
  });

  write("create_agreement", "Create a DRAFT agreement (retainer) for a customer with one or more lines (billable service, qty, rate). The monthly value is the sum of qty × rate. It is not activated and does not generate invoices until you activate it in the app. The older single-service form (serviceId, hours, fee, rate, overageRate) is still accepted and becomes one line.", {
    name: z.string().min(1).max(200), customerId: ID,
    lines: z.array(AGREEMENT_LINE).min(1).max(50).optional(),
    serviceId: ID.optional().describe("Legacy: single service; use lines instead"),
    startDate: ISO, endDate: ISO.optional(), period: z.enum(["month", "quarter"]).optional(),
    hours: z.number().min(0).optional().describe("Legacy: included hours"), fee: z.number().min(0).optional().describe("Legacy: period fee"),
    rate: z.number().min(0).optional().describe("Legacy: standard rate"), overageRate: z.number().min(0).optional().describe("Legacy: overage rate"),
    currency: CURRENCY.optional(), autoPublish: z.boolean().optional(),
    rolloverPolicy: z.object({ mode: z.enum(["expire", "rollover"]), limitHours: z.number().min(0).nullable().optional() }).optional(),
  }, async (a) => pick(await agreements.createAgreement(...who, a), ["id", "name", "status", "customerId", "customerName", "serviceId", "lines", "startDate", "endDate", "period", "hours", "fee", "currency", "rate", "overageRate", "autoPublish", "rolloverPolicy", "draft"]));

  write("create_draft_credit_note", "Create a DRAFT credit note linked to one published invoice. It is not published or posted until you do that in the app.", {
    invoiceId: ID, items: z.array(ITEM).min(1).max(100).optional(), issueDate: ISO.optional(), reason: z.string().max(500).optional(), notes: z.string().max(2000).optional(),
  }, async (a) => {
    const note = await creditNotes.createCreditNote(...who, { ...a, draft: true, finalize: false });
    return pick(note, ["id", "creditNoteNumber", "status", "invoiceId", "invoiceNumber", "customerName", "currency", "issueDateIso", "total", "reason", "draft"]);
  });

  write("create_draft_invoice", "Create a DRAFT invoice. Use publish_invoice to give it a number and issue it.", {
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

  write("publish_invoice", "Publish a draft invoice: allocates the next invoice number and freezes company details. Can't be undone (void instead).", { invoiceId: ID }, async (a) =>
    pick(await invoices.finalizeInvoice(...who, a.invoiceId), INVOICE_ROW), { destructive: true });

  write("void_invoice", "Void a published invoice (keeps its number; owners and admins only).", { invoiceId: ID, reason: z.string().max(500).optional() }, async (a) =>
    pick(await invoices.voidInvoice(...who, a.invoiceId, { reason: a.reason }), INVOICE_ROW), { destructive: true });

  write("void_payment", "Void a payment (it stays on record; owners and admins only).", { paymentId: ID, reason: z.string().max(500).optional() }, async (a) => {
    const r = await payments.voidPayment(...who, a.paymentId, { reason: a.reason });
    return { payment: pick(r.payment, ["id", "invoiceId", "amount", "voided"]), invoice: pick(r.invoice, INVOICE_ROW) };
  }, { destructive: true });

  const DELETERS = {
    invoice: ["invoiceId", (id) => invoices.deleteInvoice(...who, id)],
    quote: ["quoteId", (id) => quotes.deleteQuote(...who, id)],
    customer: ["customerId", (id) => customers.deleteCustomer(...who, id)],
    product: ["productId", (id) => products.deleteProduct(...who, id)],
    expense: ["expenseId", (id) => expenses.deleteExpense(...who, id)],
    payment: ["paymentId", (id) => payments.deletePayment(...who, id)],
    bank_import: ["importId", (id) => bank.deleteImport(...who, id)],
  };
  for (const [kind, [field, del]] of Object.entries(DELETERS)) {
    write(`delete_${kind}`, `Delete a ${kind.replace("_", " ")} (soft delete: hidden everywhere, undo with restore_record; owners and admins only).`, { [field]: ID }, async (a) => {
      await del(a[field]);
      return { deleted: true, [field]: a[field] };
    }, { destructive: true });
  }

  write("restore_record", "Undo a soft delete.", { kind: z.enum(RESTORE_KINDS), id: ID }, (a) => restoreRecord(...who, a.kind, a.id));

  write("undo_bank_transaction", "Undo a bank line's reconciliation (keeps any payment or expense it created).", { transactionId: ID }, async (a) => {
    const r = await bank.undo(...who, a.transactionId, {});
    return { transaction: pick(r.transaction, ["id", "status"]) };
  });

  return server;
}

module.exports = { buildMcpServer };
