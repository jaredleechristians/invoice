/**
 * Assistant write actions: propose → confirm → execute.
 *
 * The model never writes directly. A write tool call only *prepares* an action:
 * it resolves names to records, validates the input and stores a pending
 * proposal (companies/{id}/assistantActions/{actionId}) that the chat panel
 * shows as a confirmation card. Nothing is written to business data until the
 * same user confirms it, and then the regular service functions run with the
 * caller's current role (same validation, tenant and permission checks), with
 * audit entries tagged { via: "assistant", assistantActionId }.
 *
 * Deliberately absent: finalize, void, delete. Invoices and quotes are created
 * as drafts only.
 */
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { httpError } = require("./errors");
const { logAudit, withAuditContext } = require("./audit");
const { canWriteRecords } = require("./permissions");
const { SUPPORTED_CURRENCIES, roundMoney, parseAmount, formatMoney } = require("./money");
const { toIsoDate, todayIso } = require("./dates");
const customers = require("./customers");
const products = require("./products");
const expenses = require("./expenses");
const invoices = require("./invoices");
const quotes = require("./quotes");
const payments = require("./payments");
const timeEntries = require("./timeEntries");
const agreements = require("./agreements");

const ACTION_TTL_MS = 30 * 60 * 1000;

// ---------- tool schemas (OpenAI/OpenRouter function calling) ----------

const fn = (name, description, properties, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
});
const str = (description) => ({ type: "string", description });
const num = (description) => ({ type: "number", description });
const CURRENCY = { type: "string", enum: SUPPORTED_CURRENCIES, description: "Currency code. Only pass it when the user stated or clearly implied it (R = ZAR, $ = USD, € = EUR, £ = GBP)." };
const ISO = (what) => str(`${what} as YYYY-MM-DD`);
const LINES = {
  type: "array",
  description: "Line items",
  items: {
    type: "object",
    properties: { description: str("What is being billed"), qty: num("Quantity (default 1)"), unitPrice: num("Price per unit, excluding VAT") },
    required: ["description", "unitPrice"],
    additionalProperties: false,
  },
};

const WRITE_TOOL_DEFS = [
  fn("propose_create_customer", "Propose adding a customer. Requires the user's confirmation before saving.", {
    name: str("Customer name"), email: str("Email"), phone: str("Phone"), address: str("Postal/physical address"),
    taxNumber: str("VAT/tax number"), currency: CURRENCY, notes: str("Internal notes"),
  }, ["name"]),
  fn("propose_update_customer", "Propose changing simple fields on an existing customer.", {
    customer: str("Customer name or id"),
    changes: { type: "object", properties: { name: str("New name"), email: str("Email"), phone: str("Phone"), address: str("Address"), taxNumber: str("Tax number"), currency: CURRENCY, notes: str("Notes") }, additionalProperties: false },
  }, ["customer", "changes"]),
  fn("propose_create_product", "Propose adding a product or service to the catalogue.", {
    name: str("Name"), unitPrice: num("Price per unit"), currency: CURRENCY, kind: { type: "string", enum: ["service", "product"] }, description: str("Description"),
  }, ["name", "unitPrice"]),
  fn("propose_update_product", "Propose changing simple fields on an existing product or service.", {
    product: str("Product name or id"),
    changes: { type: "object", properties: { name: str("Name"), unitPrice: num("Price"), currency: CURRENCY, description: str("Description"), active: { type: "boolean" } }, additionalProperties: false },
  }, ["product", "changes"]),
  fn("propose_create_expense", "Propose recording an expense (money out).", {
    amount: num("Amount paid"), currency: CURRENCY, date: ISO("Date paid"), vendor: str("Who was paid"),
    category: str("Expense category name (e.g. Fuel, Software)"), reference: str("Reference"), notes: str("Notes"),
  }, ["amount", "currency", "date"]),
  fn("propose_create_time_entry", "Propose logging internal, agreement, or ad hoc billable time. Does not invoice it.", {
    date: ISO("Date of the work"), hours: num("Hours worked (e.g. 1.5)"), minutes: num("Minutes worked, if not using hours"),
    description: str("What was done"), customer: str("Customer name or id, if this time is for a customer"),
    agreement: str("Agreement name or id, when this time is against a retainer"),
    billable: { type: "boolean", description: "True only for ad hoc billable hours that can later be invoiced. Ignored when an agreement is set." },
    rate: num("Optional hourly rate for billable time"), personName: str("Who did the work"), notes: str("Internal notes"),
  }, ["date", "description"]),
  fn("propose_create_agreement", "Propose a DRAFT agreement (retainer) for a customer and a catalogue service. Never activates it or generates invoices.", {
    name: str("Agreement name"), customer: str("Existing customer name or id"), service: str("Existing product/service name or id"),
    startDate: ISO("Start date"), endDate: ISO("Optional end date"), period: { type: "string", enum: ["month", "quarter"], description: "Calendar month or quarter" },
    hours: num("Included hours per period"), fee: num("Period fee"), rate: num("Standard hourly rate, used for overage if no overage rate is set"),
    overageRate: num("Optional overage hourly rate"), currency: CURRENCY,
    rollover: { type: "string", enum: ["expire", "rollover"], description: "What happens to unused hours at period close" },
    rolloverCap: num("Optional cap on hours that roll over; omit for no cap"),
    autoPublish: { type: "boolean", description: "If true, recurring invoices are published automatically (default false, drafts)" },
  }, ["customer", "service", "startDate", "hours", "fee"]),
  fn("propose_create_draft_invoice", "Propose a DRAFT invoice. Never publishes; the user publishes it in the app.", {
    customer: str("Existing customer name or id"), currency: CURRENCY, items: LINES,
    issueDate: ISO("Issue date"), dueDate: ISO("Due date"), reference: str("Reference / PO"), notes: str("Notes shown on the invoice"),
  }, ["customer", "currency", "items"]),
  fn("propose_update_draft_invoice", "Propose changing simple fields on a DRAFT invoice (not published ones).", {
    invoice: str("Invoice id, or the customer name for their draft"),
    changes: { type: "object", properties: { issueDate: ISO("Issue date"), dueDate: ISO("Due date"), reference: str("Reference"), notes: str("Notes") }, additionalProperties: false },
  }, ["invoice", "changes"]),
  fn("propose_create_draft_quote", "Propose a DRAFT quote (estimate).", {
    customer: str("Existing customer name or id"), currency: CURRENCY, items: LINES,
    issueDate: ISO("Quote date"), expiryDate: ISO("Valid until"), notes: str("Notes"),
  }, ["customer", "currency", "items"]),
  fn("propose_record_payment", "Propose recording a payment received against one published invoice.", {
    invoice: str("Invoice number (e.g. INV-0007) or id"), amount: num("Amount received, in the invoice currency"),
    payInFull: { type: "boolean", description: "True when the user said the invoice was paid in full" },
    date: ISO("Date received"), method: { type: "string", enum: payments.PAYMENT_METHODS }, reference: str("Payment reference"),
  }, ["invoice"]),
];

const WRITE_TOOL_NAMES = new Set(WRITE_TOOL_DEFS.map((t) => t.function.name));

// ---------- helpers ----------

/** "Ask the user" result: the model must turn this into a clarifying question. */
const ask = (question, extra = {}) => ({ needsClarification: true, question, ...extra });

function resolveOne(rows, query, { label, nameOf, extraKeys = [] }) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return { error: ask(`Which ${label}?`) };
  const byId = rows.find((r) => r.id === query);
  if (byId) return { row: byId };
  const exact = rows.filter((r) => [nameOf(r), ...extraKeys.map((k) => r[k])].some((v) => String(v || "").toLowerCase() === q));
  if (exact.length === 1) return { row: exact[0] };
  const partial = exact.length ? exact : rows.filter((r) => String(nameOf(r) || "").toLowerCase().includes(q));
  if (partial.length === 1) return { row: partial[0] };
  if (!partial.length) return { error: ask(`I couldn't find a ${label} matching "${query}". Which one did you mean?`, { notFound: true }) };
  return {
    error: ask(`Several ${label}s match "${query}". Which one?`, {
      candidates: partial.slice(0, 8).map((r) => ({ id: r.id, name: nameOf(r) })),
    }),
  };
}

/**
 * Currencies the user actually mentioned in the conversation. Used to stop a
 * model from silently filling in a currency the user never gave.
 */
function currencyHints(text) {
  const t = String(text || "");
  const found = new Set();
  if (/\bR\s?\d|\bZAR\b|\brands?\b/i.test(t)) found.add("ZAR");
  if (/\$\s?\d|\bUSD\b|\bUS\$|\bdollars?\b/i.test(t)) found.add("USD");
  if (/€|\bEUR\b|\beuros?\b/i.test(t)) found.add("EUR");
  if (/£|\bGBP\b|\bpounds?\b/i.test(t)) found.add("GBP");
  return found;
}

/** The currency must be stated by the user (or, for documents, be the customer's default). */
function checkCurrencyStated(currency, hints, { fallback } = {}) {
  if (!hints) return null; // direct/internal calls
  if (hints.has(currency)) return null;
  if (!hints.size && fallback && fallback === currency) return null;
  return ask(hints.size ? `You mentioned ${[...hints].join("/")}, not ${currency}. Which currency is it?` : "Which currency is this in?", { missing: ["currency"] });
}

function requireCurrency(currency) {
  const code = String(currency || "").trim().toUpperCase();
  if (!code) return { error: ask("Which currency is this in?", { missing: ["currency"] }) };
  if (!SUPPORTED_CURRENCIES.includes(code)) return { error: ask(`I can only use ${SUPPORTED_CURRENCIES.join(", ")}. Which currency?`) };
  return { currency: code };
}

function requireDate(value, what, { required = false } = {}) {
  if (value === undefined || value === null || value === "") {
    return required ? { error: ask(`What ${what} should I use?`, { missing: [what] }) } : { date: "" };
  }
  const iso = toIsoDate(value);
  if (!iso) return { error: ask(`I couldn't read the ${what} "${value}". Which date?`) };
  return { date: iso };
}

function cleanLines(items) {
  if (!Array.isArray(items) || !items.length) return { error: ask("What should the line items be (description, quantity and price)?", { missing: ["items"] }) };
  const lines = [];
  for (const it of items) {
    const description = String(it?.description || "").trim();
    const unitPrice = it?.unitPrice;
    if (!description) return { error: ask("One of the lines has no description. What is it for?") };
    if (unitPrice === undefined || unitPrice === null || unitPrice === "" || !Number.isFinite(parseAmount(unitPrice))) {
      return { error: ask(`What is the price for "${description}"?`, { missing: ["unitPrice"] }) };
    }
    const qty = it?.qty === undefined || it?.qty === null || it?.qty === "" ? 1 : parseAmount(it.qty);
    if (!(qty > 0)) return { error: ask(`What quantity for "${description}"?`) };
    lines.push({ description: description.slice(0, 500), qty, unitPrice: roundMoney(unitPrice) });
  }
  return { lines };
}

const fmtDate = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
};
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined && obj[k] !== null).map((k) => [k, obj[k]]));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const linesTotal = (lines) => roundMoney(lines.reduce((s, l) => s + roundMoney(l.qty * l.unitPrice), 0));

// ---------- prepare (validate + describe; no business writes) ----------

/**
 * Turn a write tool call into a proposal: { tool, input, title, details[] }
 * or a clarification { needsClarification, question, ... } for the model.
 */
async function prepareAction(companyId, tool, args = {}, { hints } = {}) {
  switch (tool) {
    case "propose_create_customer": {
      const name = String(args.name || "").trim();
      if (!name) return ask("What is the customer's name?", { missing: ["name"] });
      const existing = await customers.listCustomers(companyId);
      const dupe = existing.find((c) => c.name.toLowerCase() === name.toLowerCase());
      if (dupe) return ask(`A customer called "${dupe.name}" already exists. Update that one instead, or add another with a different name?`);
      const input = pick(args, ["name", "email", "phone", "address", "taxNumber", "currency", "notes"]);
      input.name = name;
      return {
        tool, input,
        title: `Add customer ${name}`,
        details: Object.entries(pick(input, ["email", "phone", "address", "taxNumber", "currency"])).map(([k, v]) => ({ label: LABELS[k] || k, value: String(v) })),
      };
    }
    case "propose_update_customer": {
      const r = resolveOne(await customers.listCustomers(companyId), args.customer, { label: "customer", nameOf: (c) => c.name, extraKeys: ["email"] });
      if (r.error) return r.error;
      const changes = pick(args.changes || {}, ["name", "email", "phone", "address", "taxNumber", "currency", "notes"]);
      if (!Object.keys(changes).length) return ask(`What should I change on ${r.row.name}?`);
      return {
        tool, input: { customerId: r.row.id, changes },
        title: `Update customer ${r.row.name}`,
        details: Object.entries(changes).map(([k, v]) => ({ label: LABELS[k] || k, value: `${r.row[k] || "—"} → ${v || "—"}` })),
      };
    }
    case "propose_create_product": {
      const name = String(args.name || "").trim();
      if (!name) return ask("What is the product or service called?", { missing: ["name"] });
      if (args.unitPrice === undefined || !Number.isFinite(parseAmount(args.unitPrice))) return ask(`What is the price for ${name}?`, { missing: ["unitPrice"] });
      if (args.currency) {
        const stated = checkCurrencyStated(String(args.currency).toUpperCase(), hints);
        if (stated) return stated;
      }
      const input = { name, unitPrice: roundMoney(args.unitPrice), kind: args.kind === "product" ? "product" : "service", ...pick(args, ["currency", "description"]) };
      return {
        tool, input,
        title: `Add ${input.kind} ${name}`,
        details: [
          { label: "Price", value: input.currency ? formatMoney(input.unitPrice, input.currency) : input.unitPrice.toFixed(2) },
          ...(input.description ? [{ label: "Description", value: input.description }] : []),
        ],
      };
    }
    case "propose_update_product": {
      const r = resolveOne(await products.listProducts(companyId, { includeInactive: true }), args.product, { label: "product", nameOf: (p) => p.name });
      if (r.error) return r.error;
      const changes = pick(args.changes || {}, ["name", "unitPrice", "currency", "description", "active"]);
      if (!Object.keys(changes).length) return ask(`What should I change on ${r.row.name}?`);
      return {
        tool, input: { productId: r.row.id, changes },
        title: `Update ${r.row.name}`,
        details: Object.entries(changes).map(([k, v]) => ({ label: LABELS[k] || k, value: `${r.row[k] ?? "—"} → ${v}` })),
      };
    }
    case "propose_create_expense": {
      const amount = roundMoney(args.amount);
      if (!(amount > 0)) return ask("How much was the expense?", { missing: ["amount"] });
      const c = requireCurrency(args.currency);
      if (c.error) return c.error;
      const stated = checkCurrencyStated(c.currency, hints);
      if (stated) return stated;
      const d = requireDate(args.date, "date", { required: true });
      if (d.error) return d.error;
      let categoryId = "";
      let categoryName = "Uncategorised";
      if (args.category) {
        const cats = await expenses.listCategories(companyId);
        const r = resolveOne(cats, args.category, { label: "expense category", nameOf: (x) => x.name });
        if (r.row) {
          categoryId = r.row.id;
          categoryName = r.row.name;
        } else if (r.error.candidates) {
          return r.error;
        } else {
          // Unknown category: keep it visible on the card rather than guessing another one.
          categoryName = `Uncategorised (no "${String(args.category).slice(0, 40)}" category)`;
        }
      }
      const input = { amount, currency: c.currency, date: d.date, categoryId, ...pick(args, ["vendor", "reference", "notes"]) };
      return {
        tool, input,
        title: `Add ${formatMoney(amount, c.currency)} ${categoryId ? categoryName.toLowerCase() : String(args.category || "").toLowerCase()} expense${input.vendor ? ` (${input.vendor})` : ""}, ${fmtDate(d.date)}`,
        details: [
          { label: "Amount", value: formatMoney(amount, c.currency) },
          { label: "Date", value: fmtDate(d.date) },
          { label: "Category", value: categoryName },
          ...(input.vendor ? [{ label: "Vendor", value: input.vendor }] : []),
          ...(input.reference ? [{ label: "Reference", value: input.reference }] : []),
        ],
      };
    }
    case "propose_create_time_entry": {
      const d = requireDate(args.date, "date", { required: true });
      if (d.error) return d.error;
      const description = String(args.description || "").trim();
      if (!description) return ask("What did you work on?", { missing: ["description"] });
      if ((args.hours === undefined || args.hours === null || args.hours === "") && (args.minutes === undefined || args.minutes === null || args.minutes === "")) {
        return ask("How many hours (or minutes) should I log?", { missing: ["hours"] });
      }
      let customerId = "";
      let customerName = "";
      if (args.customer) {
        const r = resolveOne(await customers.listCustomers(companyId), args.customer, { label: "customer", nameOf: (c) => c.name, extraKeys: ["email"] });
        if (r.error) return r.error;
        customerId = r.row.id;
        customerName = r.row.name;
      }
      let agreementId = "";
      let agreementName = "";
      if (args.agreement) {
        const r = resolveOne(await agreements.listAgreements(companyId), args.agreement, { label: "agreement", nameOf: (a) => a.name });
        if (r.error) return r.error;
        agreementId = r.row.id;
        agreementName = r.row.name;
        if (!customerId) {
          customerId = r.row.customerId;
          customerName = r.row.customerName || "";
        }
      }
      const billable = Boolean(args.billable) && !agreementId;
      const input = {
        date: d.date,
        description,
        billable,
        source: "assistant",
        ...(args.hours !== undefined && args.hours !== null && args.hours !== "" ? { hours: Number(args.hours) } : {}),
        ...(args.minutes !== undefined && args.minutes !== null && args.minutes !== "" ? { minutes: Number(args.minutes) } : {}),
        ...(customerId ? { customerId } : {}),
        ...(agreementId ? { agreementId } : {}),
        ...(args.rate !== undefined && args.rate !== null && args.rate !== "" ? { rate: Number(args.rate) } : {}),
        ...pick(args, ["personName", "notes"]),
      };
      const duration = input.hours != null ? `${input.hours}h` : `${input.minutes} min`;
      return {
        tool, input,
        title: `Log ${duration} ${agreementName ? "agreement " : billable ? "billable " : ""}time${customerName ? ` for ${customerName}` : ""} on ${fmtDate(d.date)}`,
        details: [
          { label: "Date", value: fmtDate(d.date) },
          { label: "Duration", value: duration },
          { label: "Work", value: description },
          { label: "Billable", value: agreementId ? "No (counts toward the agreement)" : billable ? "Yes (ad hoc, not invoiced yet)" : "No (internal)" },
          ...(agreementName ? [{ label: "Agreement", value: agreementName }] : []),
          ...(customerName ? [{ label: "Customer", value: customerName }] : []),
          ...(input.personName ? [{ label: "Person", value: input.personName }] : []),
        ],
      };
    }
    case "propose_create_agreement": {
      const r = resolveOne(await customers.listCustomers(companyId), args.customer, { label: "customer", nameOf: (c) => c.name, extraKeys: ["email"] });
      if (r.error) return r.error;
      const s = resolveOne(await products.listProducts(companyId, { includeInactive: true }), args.service, { label: "service", nameOf: (p) => p.name });
      if (s.error) return s.error;
      const start = requireDate(args.startDate, "start date", { required: true });
      if (start.error) return start.error;
      const end = requireDate(args.endDate, "end date");
      if (end.error) return end.error;
      if (args.hours === undefined || args.hours === null || args.hours === "") return ask("How many hours are included in each period?", { missing: ["hours"] });
      if (args.fee === undefined || args.fee === null || args.fee === "") return ask("What is the fee for each period?", { missing: ["fee"] });
      const name = String(args.name || "").trim() || `${s.row.name} — ${r.row.name}`;
      const mode = args.rollover === "rollover" ? "rollover" : "expire";
      const input = {
        name,
        customerId: r.row.id,
        serviceId: s.row.id,
        startDate: start.date,
        hours: Number(args.hours),
        fee: Number(args.fee),
        period: args.period === "quarter" ? "quarter" : "month",
        autoPublish: Boolean(args.autoPublish),
        rolloverPolicy: {
          mode,
          limitHours: args.rolloverCap !== undefined && args.rolloverCap !== null && args.rolloverCap !== "" ? Number(args.rolloverCap) : null,
        },
        ...(end.date ? { endDate: end.date } : {}),
        ...(args.rate !== undefined && args.rate !== null && args.rate !== "" ? { rate: Number(args.rate) } : {}),
        ...(args.overageRate !== undefined && args.overageRate !== null && args.overageRate !== "" ? { overageRate: Number(args.overageRate) } : {}),
        ...(args.currency ? { currency: args.currency } : {}),
      };
      return {
        tool, input,
        title: `Create draft agreement ${name} for ${r.row.name}`,
        details: [
          { label: "Customer", value: r.row.name },
          { label: "Service", value: s.row.name },
          { label: "Start", value: fmtDate(start.date) },
          ...(end.date ? [{ label: "End", value: fmtDate(end.date) }] : []),
          { label: "Period", value: input.period === "quarter" ? "Calendar quarter" : "Calendar month" },
          { label: "Hours", value: String(input.hours) },
          { label: "Fee", value: formatMoney(input.fee, input.currency || r.row.currency || "ZAR") },
          { label: "Unused hours", value: mode === "rollover" ? (input.rolloverPolicy.limitHours != null ? `Roll over, cap ${input.rolloverPolicy.limitHours}h` : "Roll over, no cap") : "Expire" },
          { label: "Recurring invoices", value: input.autoPublish ? "Publish automatically" : "Create as drafts" },
        ],
      };
    }
    case "propose_create_draft_invoice":
    case "propose_create_draft_quote": {
      const isInvoice = tool === "propose_create_draft_invoice";
      const r = resolveOne(await customers.listCustomers(companyId), args.customer, { label: "customer", nameOf: (c) => c.name, extraKeys: ["email"] });
      if (r.error) {
        if (r.error.notFound) r.error.question += " (I can add them as a new customer first.)";
        return r.error;
      }
      const c = requireCurrency(args.currency);
      if (c.error) return c.error;
      const stated = checkCurrencyStated(c.currency, hints, { fallback: r.row.currency });
      if (stated) return stated;
      const l = cleanLines(args.items);
      if (l.error) return l.error;
      const issue = requireDate(args.issueDate, isInvoice ? "issue date" : "quote date");
      if (issue.error) return issue.error;
      const end = requireDate(isInvoice ? args.dueDate : args.expiryDate, isInvoice ? "due date" : "expiry date");
      if (end.error) return end.error;
      const total = linesTotal(l.lines);
      const input = {
        customerId: r.row.id,
        currency: c.currency,
        items: l.lines,
        ...(issue.date ? { issueDate: issue.date } : {}),
        ...(end.date ? { [isInvoice ? "dueDate" : "expiryDate"]: end.date } : {}),
        ...pick(args, isInvoice ? ["reference", "notes"] : ["notes"]),
      };
      const kind = isInvoice ? "invoice" : "quote";
      return {
        tool, input,
        title: `Create draft ${kind} for ${r.row.name}, ${plural(l.lines.length, "line")}, ${formatMoney(total, c.currency)}${end.date ? `, ${isInvoice ? "due" : "valid until"} ${fmtDate(end.date)}` : ""}`,
        details: [
          ...l.lines.map((x) => ({ label: x.description, value: `${x.qty} × ${formatMoney(x.unitPrice, c.currency)}` })),
          { label: "Total (excl. VAT)", value: formatMoney(total, c.currency) },
          { label: isInvoice ? "Issue date" : "Quote date", value: issue.date ? fmtDate(issue.date) : "Today" },
          { label: isInvoice ? "Due date" : "Valid until", value: end.date ? fmtDate(end.date) : "Company default terms" },
          ...(r.row.currency && r.row.currency !== c.currency ? [{ label: "Note", value: `${r.row.name} usually pays in ${r.row.currency}` }] : []),
          { label: "Status", value: "Draft (you publish it in the app)" },
        ],
      };
    }
    case "propose_update_draft_invoice": {
      const all = await invoices.listInvoices(companyId);
      const drafts = all.filter((i) => i.draft && !i.voided);
      const byId = all.find((i) => i.id === args.invoice || (i.invoiceNumber && i.invoiceNumber.toLowerCase() === String(args.invoice || "").toLowerCase()));
      if (byId && !byId.draft) return ask(`${byId.invoiceNumber} is already published, so I can't change it. Edit it in the app if you need to.`);
      const r = byId ? { row: byId } : resolveOne(drafts, args.invoice, { label: "draft invoice", nameOf: (i) => i.customerName });
      if (r.error) return r.error;
      const changes = pick(args.changes || {}, ["issueDate", "dueDate", "reference", "notes"]);
      for (const k of ["issueDate", "dueDate"]) {
        if (changes[k] !== undefined) {
          const d = requireDate(changes[k], k === "dueDate" ? "due date" : "issue date", { required: true });
          if (d.error) return d.error;
          changes[k] = d.date;
        }
      }
      if (!Object.keys(changes).length) return ask("What should I change on that draft?");
      return {
        tool, input: { invoiceId: r.row.id, changes },
        title: `Update draft invoice for ${r.row.customerName || "customer"}`,
        details: Object.entries(changes).map(([k, v]) => ({ label: LABELS[k] || k, value: /Date$/.test(k) ? fmtDate(v) : String(v) })),
      };
    }
    case "propose_record_payment": {
      const all = await invoices.listInvoices(companyId);
      const q = String(args.invoice || "").trim();
      if (!q) return ask("Which invoice is the payment for?", { missing: ["invoice"] });
      let inv = all.find((i) => i.id === q || (i.invoiceNumber && i.invoiceNumber.toLowerCase() === q.toLowerCase()));
      if (!inv) {
        const open = all.filter((i) => !i.draft && !i.voided && i.outstanding > 0 && String(i.customerName || "").toLowerCase().includes(q.toLowerCase()));
        if (open.length === 1) inv = open[0];
        else if (open.length > 1) {
          return ask(`${open[0].customerName} has several unpaid invoices. Which one is this payment for?`, {
            candidates: open.map((i) => ({ id: i.id, name: `${i.invoiceNumber} · ${formatMoney(i.outstanding, i.currency)} outstanding` })),
          });
        } else return ask(`I couldn't find an unpaid invoice matching "${q}". Which invoice is it?`);
      }
      if (inv.voided) return ask(`${inv.invoiceNumber} is void, so it can't take payments.`);
      if (inv.draft) return ask("That invoice is still a draft. Publish it in the app before recording payments.");
      if (!(inv.outstanding > 0)) return ask(`${inv.invoiceNumber} is already paid in full.`);
      let amount = args.payInFull ? inv.outstanding : roundMoney(args.amount);
      if (!(amount > 0)) return ask(`How much was received for ${inv.invoiceNumber}? (${formatMoney(inv.outstanding, inv.currency)} is outstanding.)`, { missing: ["amount"] });
      if (amount > inv.outstanding + 0.001) return ask(`That's more than the ${formatMoney(inv.outstanding, inv.currency)} outstanding on ${inv.invoiceNumber}. What amount should I record?`);
      const d = requireDate(args.date, "payment date");
      if (d.error) return d.error;
      const method = payments.PAYMENT_METHODS.includes(args.method) ? args.method : "bank_transfer";
      const input = { invoiceId: inv.id, amount, paidAt: d.date || todayIso(), method, ...pick(args, ["reference"]) };
      return {
        tool, input,
        title: `Record ${formatMoney(amount, inv.currency)} payment on ${inv.invoiceNumber} (${inv.customerName})`,
        details: [
          { label: "Invoice", value: `${inv.invoiceNumber} · ${inv.customerName}` },
          { label: "Amount", value: formatMoney(amount, inv.currency) },
          { label: "Outstanding after", value: formatMoney(roundMoney(inv.outstanding - amount), inv.currency) },
          { label: "Date", value: fmtDate(input.paidAt) },
          { label: "Method", value: method.replace(/_/g, " ") },
        ],
      };
    }
    default:
      return { error: `Unknown or unsupported action: ${tool}` };
  }
}

const LABELS = {
  name: "Name", email: "Email", phone: "Phone", address: "Address", taxNumber: "Tax number", currency: "Currency",
  notes: "Notes", unitPrice: "Price", description: "Description", active: "Active", issueDate: "Issue date",
  dueDate: "Due date", reference: "Reference",
};

// ---------- storage ----------

const actionsCol = (companyId) => getDb().collection("companies").doc(companyId).collection("assistantActions");

/** Validate and store a pending proposal for this user. Returns the tool result for the model. */
async function proposeAction({ companyId, uid, role, tool, args, userText }) {
  if (!canWriteRecords(role)) {
    return { error: "This user does not have permission to add or change records, so nothing can be proposed. Tell them to ask an owner or admin." };
  }
  const prepared = await prepareAction(companyId, tool, args, { hints: userText === undefined ? undefined : currencyHints(userText) });
  if (prepared.needsClarification || prepared.error) return prepared;
  const id = randomId();
  const now = Date.now();
  const action = {
    id,
    uid,
    tool,
    input: prepared.input,
    title: String(prepared.title).replace(/\s+/g, " ").trim(),
    details: prepared.details || [],
    status: "pending",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ACTION_TTL_MS).toISOString(),
  };
  await actionsCol(companyId).doc(id).set(action);
  return { action: publicAction(action) };
}

function publicAction(a) {
  return pick(a, ["id", "tool", "title", "details", "status", "result", "error", "expiresAt"]);
}

// ---------- confirm / cancel ----------

async function claimAction(companyId, uid, actionId, nextStatus) {
  const db = getDb();
  const ref = actionsCol(companyId).doc(actionId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw httpError(404, "Action not found");
    const a = snap.data();
    if (a.uid !== uid) throw httpError(403, "Only the person who asked can confirm this action");
    if (a.status !== "pending") throw httpError(409, `This action was already ${a.status}`);
    if (Date.parse(a.expiresAt) < Date.now()) {
      tx.update(ref, { status: "expired" });
      throw httpError(410, "This proposal expired. Ask the assistant again.");
    }
    tx.update(ref, { status: nextStatus, [`${nextStatus}At`]: new Date().toISOString() });
    return { id: snap.id, ...a };
  });
}

async function cancelAction({ companyId, uid, email, actionId }) {
  const a = await claimAction(companyId, uid, actionId, "cancelled");
  await logAudit({ companyId, uid, email, action: "assistant.action.cancel", payload: { actionId, tool: a.tool } });
  return { action: publicAction({ ...a, status: "cancelled" }) };
}

/** The only place assistant proposals reach the service layer. */
async function executeAction(companyId, uid, email, role, tool, input) {
  const who = [companyId, uid, email, role];
  switch (tool) {
    case "propose_create_customer": {
      const c = await customers.createCustomer(...who, input);
      return { kind: "customer", id: c.id, label: c.name, link: "/dashboard/customers" };
    }
    case "propose_update_customer": {
      const c = await customers.updateCustomer(...who, input.customerId, input.changes);
      return { kind: "customer", id: input.customerId, label: c.name, link: "/dashboard/customers" };
    }
    case "propose_create_product": {
      const p = await products.createProduct(...who, input);
      return { kind: "product", id: p.id, label: p.name, link: "/dashboard/products" };
    }
    case "propose_update_product": {
      const p = await products.updateProduct(...who, input.productId, input.changes);
      return { kind: "product", id: input.productId, label: p.name, link: "/dashboard/products" };
    }
    case "propose_create_expense": {
      const e = await expenses.createExpense(...who, input);
      return { kind: "expense", id: e.id, label: formatMoney(e.amount, e.currency), link: "/dashboard/expenses" };
    }
    case "propose_create_time_entry": {
      const e = await timeEntries.createTimeEntry(...who, { ...input, source: "assistant" });
      return { kind: "timeEntry", id: e.id, label: `${e.hours}h ${e.description}`, link: "/dashboard/time" };
    }
    case "propose_create_agreement": {
      const a = await agreements.createAgreement(...who, input);
      return { kind: "agreement", id: a.id, label: a.name, link: `/dashboard/agreements/${a.id}` };
    }
    case "propose_create_draft_invoice": {
      // Drafts only: never pass finalize.
      const inv = await invoices.createInvoice(...who, { ...input, draft: true, finalize: false });
      return { kind: "invoice", id: inv.id, label: "Draft invoice", link: `/dashboard/invoices/${inv.id}` };
    }
    case "propose_update_draft_invoice": {
      const existing = await invoices.requireInvoice(companyId, input.invoiceId);
      if (!existing.draft) throw httpError(409, "That invoice is no longer a draft");
      const changes = pick(input.changes, ["issueDate", "dueDate", "reference", "notes"]);
      await invoices.updateInvoice(...who, input.invoiceId, changes);
      return { kind: "invoice", id: input.invoiceId, label: "Draft invoice", link: `/dashboard/invoices/${input.invoiceId}` };
    }
    case "propose_create_draft_quote": {
      const q = await quotes.createQuote(...who, input);
      return { kind: "quote", id: q.id, label: q.quoteNumber, link: `/dashboard/quotes/${q.id}` };
    }
    case "propose_record_payment": {
      const r = await payments.recordPayment(...who, input);
      return { kind: "payment", id: r.payment.id, label: formatMoney(r.payment.amount, r.payment.currency), link: `/dashboard/invoices/${input.invoiceId}` };
    }
    default:
      throw httpError(400, "Unsupported action");
  }
}

async function confirmAction({ companyId, uid, email, role, actionId }) {
  // Check permission before claiming, so a read-only user can't burn the proposal.
  if (!canWriteRecords(role)) throw httpError(403, "Forbidden");
  const a = await claimAction(companyId, uid, actionId, "confirmed");
  const ref = actionsCol(companyId).doc(actionId);
  try {
    const result = await withAuditContext({ via: "assistant", assistantActionId: actionId }, () =>
      executeAction(companyId, uid, email, role, a.tool, a.input)
    );
    await ref.set({ status: "done", result }, { merge: true });
    await logAudit({ companyId, uid, email, action: "assistant.action.confirm", payload: { actionId, tool: a.tool, result } });
    return { action: publicAction({ ...a, status: "done", result }) };
  } catch (err) {
    await ref.set({ status: "failed", error: String(err.message || err).slice(0, 300) }, { merge: true });
    throw err;
  }
}

module.exports = {
  WRITE_TOOL_DEFS,
  WRITE_TOOL_NAMES,
  ACTION_TTL_MS,
  prepareAction,
  currencyHints,
  proposeAction,
  confirmAction,
  cancelAction,
  executeAction,
};
