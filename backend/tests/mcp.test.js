const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
process.env.API_KEY_PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
const { setupFake } = require("./helpers/setup");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");

let db;
let server;
let base;
let co;
let readKey;
let rwKey;
let rwKeyId;
let customerId;
let publishedId;

const USER = "mo:mo@example.com";
async function call(token, method, path, body) {
  const res = await fetch(`${base}/api/tenant${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function httpClient(key) {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${key}` } } });
  await client.connect(transport);
  return client;
}
const json = (r) => JSON.parse(r.content[0].text);

test.before(async () => {
  db = setupFake();
  const app = express();
  app.use(express.json());
  app.use("/api/tenant", require("../routes/tenant"));
  app.use("/mcp", require("../routes/mcp"));
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
  co = (await call(USER, "POST", "/bootstrap")).data.companies[0].id;
  customerId = (await call(USER, "POST", `/companies/${co}/customers`, { name: "Acme Pty Ltd", currency: "ZAR" })).data.id;
  publishedId = (await call(USER, "POST", `/companies/${co}/invoices`, { finalize: true, customerId, items: [{ description: "Dev", qty: 2, unitPrice: 500 }] })).data.id;
  readKey = (await call(USER, "POST", `/companies/${co}/api-keys`, { name: "Claude read", scope: "read" })).data.key;
  const rw = (await call(USER, "POST", `/companies/${co}/api-keys`, { name: "Claude rw", scope: "read_write" })).data;
  rwKey = rw.key;
  rwKeyId = rw.id;
});
test.after(() => server?.close());

test("MCP needs a valid API key", async () => {
  const noKey = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(noKey.status, 401);
  const firebaseToken = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${USER}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(firebaseToken.status, 401, "only API keys, not sign-in tokens");
  const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer inv_live_${"x".repeat(43)}`, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(bad.status, 401);
  assert.equal((await fetch(`${base}/mcp`, { method: "GET", headers: { Authorization: `Bearer ${readKey}` } })).status, 405);
});

test("read key: read tools only, real data", async () => {
  const client = await httpClient(readKey);
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("list_invoices") && names.includes("get_receivables") && names.includes("get_reports"));
  assert.ok(!names.some((n) => /^(create|update|record|reconcile|publish|void|delete|restore|undo)_/.test(n)), "no write tools for read keys");
  assert.ok(!names.some((n) => /publish|void|delete|finalize/.test(n)));

  const inv = json(await client.callTool({ name: "list_invoices", arguments: { limit: 1 } }));
  assert.equal(inv.total, 1);
  assert.equal(inv.items[0].outstanding, 1000);
  assert.equal(inv.nextOffset, null);
  const owed = json(await client.callTool({ name: "get_receivables", arguments: {} }));
  assert.deepEqual(owed.byCustomer.map((r) => [r.customerName, r.outstanding]), [["Acme Pty Ltd", 1000]]);
  const company = json(await client.callTool({ name: "get_company", arguments: {} }));
  assert.equal(company.id, co);
  assert.equal(company.bankAccounts, undefined);
  for (const [name, args] of [
    ["get_reports", { from: "2026-01-01", to: "2026-12-31" }], ["list_expenses", {}], ["list_expense_categories", {}], ["list_payments", {}],
    ["list_bank_accounts", {}], ["list_quotes", {}], ["list_products", {}], ["list_bank_transactions", { status: "unreconciled" }], ["list_customers", {}],
    ["get_customer", { customerId }], ["get_invoice", { invoiceId: publishedId }], ["get_customer_statement", { customerId, from: "2026-01-01", to: "2026-12-31" }],
  ]) {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name}: ${r.content[0].text}`);
    assert.ok(r.content[0].text.length < 20000, `${name} stays concise`);
  }
  assert.equal(json(await client.callTool({ name: "get_invoice", arguments: { invoiceId: publishedId } })).items.length, 1);
  const denied = await client.callTool({ name: "create_customer", arguments: { name: "X" } });
  assert.equal(denied.isError, true);
  await client.close();
});

test("read-write key: drafts, publish, payments, soft delete and restore, audit with key id", async () => {
  const client = await httpClient(rwKey);
  const tools = (await client.listTools()).tools;
  const names = tools.map((t) => t.name);
  assert.ok(["create_customer", "create_draft_invoice", "update_draft_invoice", "record_expense", "record_payment", "reconcile_bank_transaction",
    "publish_invoice", "void_invoice", "void_payment", "delete_invoice", "delete_customer", "restore_record"].every((n) => names.includes(n)));
  assert.equal(tools.find((t) => t.name === "delete_invoice").annotations.destructiveHint, true);
  assert.ok(!names.some((n) => /api_key|member|setting|company_delete/.test(n)));

  const draft = json(await client.callTool({ name: "create_draft_invoice", arguments: { customerId, items: [{ description: "Design", qty: 3, unitPrice: 100 }] } }));
  assert.equal(draft.draft, true);
  assert.ok(!draft.invoiceNumber, "drafts have no number");
  const upd = json(await client.callTool({ name: "update_draft_invoice", arguments: { invoiceId: draft.id, notes: "Thanks" } }));
  assert.equal(upd.draft, true);
  const notDraft = await client.callTool({ name: "update_draft_invoice", arguments: { invoiceId: publishedId, notes: "x" } });
  assert.equal(notDraft.isError, true);
  assert.match(notDraft.content[0].text, /draft/);

  const pay = await client.callTool({ name: "record_payment", arguments: { invoiceId: publishedId, amount: 400, paidAt: "2026-11-01" } });
  assert.ok(!pay.isError, pay.content[0].text);
  const draftPay = await client.callTool({ name: "record_payment", arguments: { invoiceId: draft.id, amount: 1 } });
  assert.equal(draftPay.isError, true, "no payments on drafts");
  const badInput = await client.callTool({ name: "record_expense", arguments: { date: "yesterday", amount: -1, currency: "zar", vendor: "" } });
  assert.equal(badInput.isError, true, "zod rejects bad input");

  const owed = json(await client.callTool({ name: "get_receivables", arguments: {} }));
  assert.equal(owed.byCustomer[0].outstanding, 600);

  const published = json(await client.callTool({ name: "publish_invoice", arguments: { invoiceId: draft.id } }));
  assert.equal(published.draft, false);
  assert.ok(published.invoiceNumber);
  assert.equal(json(await client.callTool({ name: "get_receivables", arguments: {} })).byCustomer[0].outstanding, 900);

  const temp = json(await client.callTool({ name: "create_customer", arguments: { name: "Temp" } }));
  assert.deepEqual(json(await client.callTool({ name: "delete_customer", arguments: { customerId: temp.id } })), { deleted: true, customerId: temp.id });
  assert.ok(!json(await client.callTool({ name: "list_customers", arguments: {} })).items.some((c) => c.id === temp.id));
  assert.equal((await client.callTool({ name: "get_customer", arguments: { customerId: temp.id } })).isError, true);
  assert.ok(!json(await client.callTool({ name: "restore_record", arguments: { kind: "customer", id: temp.id } })).isError);
  assert.ok(json(await client.callTool({ name: "list_customers", arguments: {} })).items.some((c) => c.id === temp.id));

  const logs = (await db.collection("companies").doc(co).collection("auditLog").get()).docs.map((d) => d.data());
  const viaMcp = logs.filter((l) => l.via === "mcp");
  assert.ok(viaMcp.length >= 3);
  assert.ok(viaMcp.some((l) => l.action === "invoice.finalize") && viaMcp.some((l) => l.action === "customer.delete"));
  assert.ok(viaMcp.every((l) => l.apiKeyId === rwKeyId));
  await client.close();
});

test("revoked keys stop working on MCP", async () => {
  await call(USER, "POST", `/companies/${co}/api-keys/${rwKeyId}/revoke`);
  await assert.rejects(httpClient(rwKey));
});

test("in-memory client against buildMcpServer: member role with read_write key gets write tools", async () => {
  const { buildMcpServer } = require("../lib/mcp");
  const srv = buildMcpServer({ companyId: co, uid: "mo", email: "mo@example.com", role: "member", apiKey: { id: "k1", scope: "read_write" } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mem", version: "1" });
  await Promise.all([srv.connect(a), client.connect(b)]);
  const c = json(await client.callTool({ name: "create_customer", arguments: { name: "Beta" } }));
  assert.equal(c.name, "Beta");
  const list = json(await client.callTool({ name: "list_customers", arguments: { q: "beta" } }));
  assert.deepEqual(list.items.map((x) => x.name), ["Beta"]);
  await client.close();
});
