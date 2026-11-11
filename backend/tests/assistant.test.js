const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { setupFake } = require("./helpers/setup");
const openrouter = require("../lib/openrouter");
const { parseJsonToolCall } = require("../lib/tenantChat");
const { WRITE_TOOL_DEFS, prepareAction } = require("../lib/assistantActions");
const { todayIso } = require("../lib/dates");

let server;
let base;
let db;

async function call(token, method, path, body) {
  const res = await fetch(`${base}/api/tenant${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

const ALICE = "alice:alice@example.com";
const BOB = "bob:bob@example.com";
const CAROL = "carol:carol@example.com";
const VERA = "vera:vera@example.com"; // a role without write rights

/**
 * Scripted model: each entry is either a message object or a function that
 * receives the request ({ messages, tools }) and returns a message.
 */
let script = [];
const requests = [];
openrouter.chatCompletion = async (req) => {
  requests.push(JSON.parse(JSON.stringify(req)));
  const next = script.shift();
  if (!next) return { role: "assistant", content: "OK." };
  return typeof next === "function" ? next(req) : next;
};
const toolCall = (name, args) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: `call_${Math.random().toString(36).slice(2)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});
const say = (content) => ({ role: "assistant", content });
const lastToolResult = (req) => {
  const m = [...req.messages].reverse().find((x) => x.role === "tool" || /^TOOL RESULT/.test(x.content || ""));
  if (!m) return null;
  return m.role === "tool" ? JSON.parse(m.content) : JSON.parse(m.content.replace(/^TOOL RESULT for \S+: /, "").split("\nNow answer")[0]);
};

let co;
let acmeTrading;

test.before(async () => {
  db = setupFake();
  const router = require("../routes/tenant");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/tenant", router);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;

  co = (await call(ALICE, "POST", "/bootstrap", {})).data.companies[0].id;
  await call(BOB, "POST", "/bootstrap", {});
  acmeTrading = (await call(ALICE, "POST", `/companies/${co}/customers`, { name: "Acme Trading", currency: "ZAR" })).data;
  await call(ALICE, "POST", `/companies/${co}/customers`, { name: "Acme Holdings", currency: "USD" });
  await call(ALICE, "POST", `/companies/${co}/customers`, { name: "Beta Studio" });
  // Carol is a normal member; Vera has a role that may not write.
  const members = db.collection("companies").doc(co).collection("members");
  await members.doc("carol").set({ userId: "carol", email: "carol@example.com", role: "member", joinedAt: new Date().toISOString() });
  await members.doc("vera").set({ userId: "vera", email: "vera@example.com", role: "viewer", joinedAt: new Date().toISOString() });
});

test.after(() => server?.close());

const ask = (token, text) => call(token, "POST", `/companies/${co}/assistant`, { messages: [{ role: "user", content: text }] });
const auditEntries = async () => (await db.collection("companies").doc(co).collection("auditLog").get()).docs.map((d) => d.data());

// ---------- protocol ----------

test("JSON fallback parses a bare or fenced tool call and ignores other JSON", () => {
  assert.deepEqual(parseJsonToolCall('{"tool":"list_customers","arguments":{}}'), { name: "list_customers", args: {} });
  assert.deepEqual(
    parseJsonToolCall('Sure:\n```json\n{"tool":"propose_create_expense","arguments":{"amount":5}}\n```'),
    { name: "propose_create_expense", args: { amount: 5 } }
  );
  assert.equal(parseJsonToolCall('{"tool":"delete_everything","arguments":{}}'), null);
  assert.equal(parseJsonToolCall("No JSON here"), null);
});

test("there is no finalize, void or delete tool, and drafts are forced", () => {
  const names = WRITE_TOOL_DEFS.map((t) => t.function.name);
  for (const n of names) assert.doesNotMatch(n, /finali|void|delete|send/);
  assert.ok(names.includes("propose_create_draft_invoice"));
});

// ---------- dispatch + confirmation ----------

test("a write tool only proposes: nothing is saved until Confirm", async () => {
  script = [toolCall("propose_create_expense", { amount: 1200, currency: "ZAR", date: todayIso(), category: "Travel", vendor: "Shell" }), say("I've prepared it. Please confirm.")];
  const r = await ask(ALICE, "Add an R1,200 fuel expense today at Shell");
  assert.equal(r.status, 200);
  assert.equal(r.data.actions.length, 1);
  const action = r.data.actions[0];
  assert.equal(action.status, "pending");
  assert.match(action.title, /R\s?1\s?200,00|1,200|1 200/);
  assert.equal((await call(ALICE, "GET", `/companies/${co}/expenses`)).data.expenses.length, 0, "no expense before confirming");

  const ok = await call(ALICE, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.action.status, "done");
  const list = (await call(ALICE, "GET", `/companies/${co}/expenses`)).data.expenses;
  assert.equal(list.length, 1);
  assert.equal(list[0].amount, 1200);
  assert.equal(list[0].currency, "ZAR");

  const tagged = (await auditEntries()).find((e) => e.action === "expense.create");
  assert.equal(tagged.via, "assistant");
  assert.equal(tagged.assistantActionId, action.id);

  const again = await call(ALICE, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`);
  assert.equal(again.status, 409, "an action can only run once");
});

test("Cancel discards the proposal", async () => {
  script = [toolCall("propose_create_customer", { name: "Gamma Ltd", email: "a@gamma.test" }), say("Confirm?")];
  const action = (await ask(ALICE, "Add customer Gamma Ltd")).data.actions[0];
  const c = await call(ALICE, "POST", `/companies/${co}/assistant/actions/${action.id}/cancel`);
  assert.equal(c.status, 200);
  assert.equal(c.data.action.status, "cancelled");
  assert.equal((await call(ALICE, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`)).status, 409);
  const names = (await call(ALICE, "GET", `/companies/${co}/customers`)).data.customers.map((x) => x.name);
  assert.ok(!names.includes("Gamma Ltd"));
});

test("draft invoices are created as drafts with the confirmed lines", async () => {
  script = [
    toolCall("propose_create_draft_invoice", {
      customer: "Acme Trading",
      currency: "ZAR",
      items: [{ description: "Design", qty: 2, unitPrice: 2000 }, { description: "Hosting", unitPrice: 1000 }],
      dueDate: "2026-11-25",
    }),
    say("Ready for you to confirm."),
  ];
  const action = (await ask(ALICE, "Invoice Acme Trading R5000")).data.actions[0];
  assert.match(action.title, /draft invoice for Acme Trading, 2 lines, .*5.?000.*due 25 Nov 2026/);
  const ok = await call(ALICE, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const inv = (await call(ALICE, "GET", `/companies/${co}/invoices/${ok.data.action.result.id}`)).data;
  assert.equal(inv.draft, true);
  assert.equal(inv.invoiceNumber, "");
  assert.equal(inv.total, 5000);
  assert.equal(inv.customerId, acmeTrading.id);
});

// ---------- clarifying instead of guessing ----------

test("ambiguous customer → clarification with candidates, no proposal", async () => {
  let seen;
  script = [
    toolCall("propose_create_draft_invoice", { customer: "Acme", currency: "ZAR", items: [{ description: "Work", unitPrice: 100 }] }),
    (req) => {
      seen = lastToolResult(req);
      return say("Which Acme: Acme Trading or Acme Holdings?");
    },
  ];
  const r = await ask(ALICE, "Invoice Acme R100");
  assert.equal(r.data.actions.length, 0);
  assert.equal(seen.needsClarification, true);
  assert.deepEqual(seen.candidates.map((c) => c.name).sort(), ["Acme Holdings", "Acme Trading"]);
});

test("a currency the user never mentioned is not accepted from the model", async () => {
  let seen;
  script = [
    toolCall("propose_create_expense", { amount: 500, currency: "ZAR", date: todayIso(), category: "Software & subscriptions" }),
    (req) => {
      seen = lastToolResult(req);
      return say("Which currency is the 500 in?");
    },
  ];
  const r = await ask(ALICE, "Add a 500 software expense today");
  assert.equal(r.data.actions.length, 0);
  assert.equal(seen.needsClarification, true);
  assert.deepEqual(seen.missing, ["currency"]);
  // A customer's default currency counts as implied for invoices.
  script = [toolCall("propose_create_draft_invoice", { customer: "Acme Trading", currency: "ZAR", items: [{ description: "Work", unitPrice: 100 }] }), say("Confirm?")];
  assert.equal((await ask(ALICE, "Draft an invoice for Acme Trading, 1 x work at 100")).data.actions.length, 1);
  // …but not a different one.
  script = [toolCall("propose_create_draft_invoice", { customer: "Acme Trading", currency: "USD", items: [{ description: "Work", unitPrice: 100 }] }), say("Which currency?")];
  assert.equal((await ask(ALICE, "Draft an invoice for Acme Trading, 1 x work at 100")).data.actions.length, 0);
});

test("missing currency, amount or date → clarification", async () => {
  const noCurrency = await prepareAction(co, "propose_create_expense", { amount: 50, date: todayIso() });
  assert.equal(noCurrency.needsClarification, true);
  assert.deepEqual(noCurrency.missing, ["currency"]);
  const noAmount = await prepareAction(co, "propose_create_expense", { currency: "ZAR", date: todayIso() });
  assert.deepEqual(noAmount.missing, ["amount"]);
  const noDate = await prepareAction(co, "propose_create_expense", { amount: 50, currency: "ZAR" });
  assert.deepEqual(noDate.missing, ["date"]);
  const noPrice = await prepareAction(co, "propose_create_draft_quote", { customer: "Beta Studio", currency: "USD", items: [{ description: "Logo" }] });
  assert.deepEqual(noPrice.missing, ["unitPrice"]);
});

test("payments: ambiguous invoice asks which one; overpayment asks again", async () => {
  const mk = async (amount) => {
    const inv = (await call(ALICE, "POST", `/companies/${co}/invoices`, { draft: true, customerId: acmeTrading.id, currency: "ZAR", items: [{ description: "X", qty: 1, unitPrice: amount }] })).data;
    return (await call(ALICE, "POST", `/companies/${co}/invoices/${inv.id}/finalize`)).data;
  };
  const a = await mk(300);
  await mk(700);
  const which = await prepareAction(co, "propose_record_payment", { invoice: "Acme Trading", amount: 300 });
  assert.equal(which.needsClarification, true);
  assert.equal(which.candidates.length, 2);
  const over = await prepareAction(co, "propose_record_payment", { invoice: a.invoiceNumber, amount: 999 });
  assert.equal(over.needsClarification, true);
  const full = await prepareAction(co, "propose_record_payment", { invoice: a.invoiceNumber, payInFull: true });
  assert.equal(full.input.amount, 300);
  assert.equal(full.input.invoiceId, a.id);
});

test("a draft can't take a payment and finalized invoices can't be edited through the assistant", async () => {
  const draft = (await call(ALICE, "POST", `/companies/${co}/invoices`, { draft: true, customerId: acmeTrading.id, currency: "ZAR", items: [{ description: "Y", unitPrice: 10 }] })).data;
  const pay = await prepareAction(co, "propose_record_payment", { invoice: draft.id, amount: 10 });
  assert.equal(pay.needsClarification, true);
  const fin = (await call(ALICE, "GET", `/companies/${co}/invoices?status=unpaid`)).data.invoices.find((i) => !i.draft);
  const edit = await prepareAction(co, "propose_update_draft_invoice", { invoice: fin.invoiceNumber, changes: { notes: "x" } });
  assert.equal(edit.needsClarification, true);
  assert.match(edit.question, /finalized/);
});

// ---------- permissions ----------

test("users without write rights get no write tools and cannot confirm", async () => {
  script = [say("I can't change records for you.")];
  const r = await ask(VERA, "Add customer Delta");
  assert.equal(r.status, 200);
  const offered = requests.at(-1).tools.map((t) => t.function.name);
  assert.ok(!offered.some((n) => n.startsWith("propose_")), "no write tools offered");

  // Even a forged JSON-protocol write is refused.
  script = [say('{"tool":"propose_create_customer","arguments":{"name":"Delta"}}'), say("Sorry, you can't.")];
  const forged = await ask(VERA, "Add customer Delta");
  assert.equal(forged.data.actions.length, 0);

  // An action Alice proposed can't be confirmed by Vera (role) or Carol (not the proposer).
  script = [toolCall("propose_create_customer", { name: "Epsilon" }), say("Confirm?")];
  const action = (await ask(ALICE, "Add Epsilon")).data.actions[0];
  assert.equal((await call(VERA, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`)).status, 403);
  assert.equal((await call(CAROL, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`)).status, 403);
  // Another tenant can't reach it at all.
  assert.equal((await call(BOB, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`)).status, 403);
  // Alice still can.
  assert.equal((await call(ALICE, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`)).status, 200);
});

test("the role is re-checked when confirming, not just when proposing", async () => {
  script = [toolCall("propose_create_product", { name: "Consulting hour", unitPrice: 900, currency: "ZAR" }), say("Confirm?")];
  const action = (await ask(CAROL, "Add consulting at R900/h")).data.actions[0];
  // Carol is demoted to a read-only role before confirming.
  await db.collection("companies").doc(co).collection("members").doc("carol").set({ role: "viewer" }, { merge: true });
  assert.equal((await call(CAROL, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`)).status, 403);
  const names = (await call(ALICE, "GET", `/companies/${co}/products`)).data.products.map((p) => p.name);
  assert.ok(!names.includes("Consulting hour"));
});

test("expired proposals can't be confirmed", async () => {
  script = [toolCall("propose_create_customer", { name: "Zeta" }), say("Confirm?")];
  const action = (await ask(ALICE, "Add Zeta")).data.actions[0];
  await db.collection("companies").doc(co).collection("assistantActions").doc(action.id).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }, { merge: true });
  assert.equal((await call(ALICE, "POST", `/companies/${co}/assistant/actions/${action.id}/confirm`)).status, 410);
});
