const { listCustomers } = require("./customers");
const { listInvoices } = require("./invoices");
const { listReceivables } = require("./receivables");
const { buildStatement } = require("./statements");
const { logAudit } = require("./audit");

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
        total: inv.total,
        outstanding: inv.outstanding,
        dueDate: inv.dueDate,
      })),
    };
  }
  if (name === "who_owes_money") {
    return { receivables: await listReceivables(companyId) };
  }
  if (name === "customer_statement") {
    return await buildStatement(companyId, args.customerId);
  }
  return { error: `Unknown tool: ${name}` };
}

function buildTenantSystemPrompt(companyName) {
  return `You are the signed-in invoice assistant for company "${companyName}".
Use tools to read customers, invoices, who owes money, and statements. All amounts are ZAR (no VAT).
Do not invent financial data — call tools first.
For create/update/payment actions, explain what the user should do in the app (this chat is read-only for writes).
Reply concisely in plain language.`;
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
