const { listCustomers } = require("./customers");
const { listInvoices } = require("./invoices");
const { listReceivables } = require("./receivables");
const { buildStatement } = require("./statements");
const { logAudit } = require("./audit");
const { companySummary } = require("./reports");
const { todayIso } = require("./dates");

const TOOL_DEFS = [
  {
    type: "function",
    function: {
      name: "list_customers",
      description: "List customers for the active company",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "list_invoices",
      description: "List invoices, optionally filtered by status or search query",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string" },
          q: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "who_owes_money",
      description: "Summarize outstanding balances per customer",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "financial_summary",
      description: "Outstanding, overdue, and this month's income and expenses, per currency",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "customer_statement",
      description: "Open invoice statement for a customer id",
      parameters: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
        additionalProperties: false,
      },
    },
  },
];

async function runTool(companyId, name, args) {
  if (name === "list_customers") {
    const customers = await listCustomers(companyId);
    return { customers: customers.slice(0, 50) };
  }
  if (name === "list_invoices") {
    const invoices = await listInvoices(companyId, {
      status: args.status,
      q: args.q,
      limit: 50,
    });
    return {
      invoices: invoices.map((inv) => ({
        id: inv.id,
        invoiceNumber: inv.invoiceNumber,
        customerName: inv.customerName,
        status: inv.status,
        currency: inv.currency,
        total: inv.total,
        outstanding: inv.outstanding,
        dueDate: inv.dueDate,
      })),
    };
  }
  if (name === "who_owes_money") {
    return { receivables: await listReceivables(companyId) };
  }
  if (name === "financial_summary") {
    const { recentInvoices, topOverdue, ...summary } = await companySummary(companyId);
    return { ...summary, topOverdue };
  }
  if (name === "customer_statement") {
    // Summary only: the ledger lines would be too long for the model.
    const st = await buildStatement(companyId, args.customerId);
    const ledger = Object.fromEntries(Object.entries(st.ledger).map(([c, s]) => [c, { opening: s.opening, invoiced: s.invoiced, paid: s.paid, closing: s.closing }]));
    return { customer: st.customer, period: st.period, ledger, lines: st.lines, aging: st.aging, totals: st.totals };
  }
  return { error: `Unknown tool: ${name}` };
}

function buildTenantSystemPrompt(companyName, { today = todayIso(), canWrite = true } = {}) {
  return `You are the invoice assistant for the company "${companyName}". Today is ${today}.

READING
- Use the read tools for customers, invoices, who owes money, financial summaries and statements.
- Never invent financial data: call a tool first.
- Every amount has a currency (ZAR, USD, EUR or GBP). Never add amounts in different currencies together and never convert between them.

ENTERING DATA
${canWrite ? `- You can PROPOSE new records with the propose_* tools: customers, products/services, expenses, draft invoices, draft quotes, payments received, and simple field updates.
- A propose_* call does NOT save anything. It shows the user a confirmation card with Confirm and Cancel buttons; it is saved only if they press Confirm. After proposing, briefly say what you prepared and ask them to confirm on the card. Never claim something was saved.
- Ask a clarifying question instead of guessing whenever anything is ambiguous or missing, for example:
  * which customer, product or invoice, when several could match or none matches;
  * the currency, when the user did not state or clearly imply it ("R" means ZAR, "$" means USD, "€" EUR, "£" GBP);
  * an amount, quantity or price that was not given;
  * the date, when it is not clear ("today" and "yesterday" are clear: use today's date above);
  * which invoice a payment is for, when the customer has more than one unpaid invoice.
  Ask one short question at a time. Look things up with the read tools before asking, when that settles it.
- If a propose_* tool returns needsClarification, ask the user that question (offer the candidates if listed). Do not retry with guessed values.
- Invoices and quotes are created as DRAFTS only. You cannot publish, send, void or delete anything, or delete payments; tell the user to do that in the app.` : `- This user does not have permission to add or change records. If they ask, explain that an owner or admin can do it.`}

TOOLS
- Use native tool calls when available. If you cannot, reply with ONLY a JSON object on its own, no other text:
  {"tool": "<tool name>", "arguments": { ... }}
- Reply concisely in plain language.`;
}

async function auditTools({ companyId, uid, email, toolName, args }) {
  await logAudit({
    companyId,
    uid,
    email,
    action: "assistant.tool",
    payload: { tool: toolName, args },
  });
}

module.exports = {
  TOOL_DEFS,
  runTool,
  buildTenantSystemPrompt,
  auditTools,
};
