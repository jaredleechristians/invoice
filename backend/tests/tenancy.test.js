const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { setupFake } = require("./helpers/setup");

let server;
let base;

async function call(token, method, path, body) {
  const res = await fetch(`${base}/api/tenant${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const ALICE = "alice:alice@example.com";
const BOB = "bob:bob@example.com";
const CAROL = "carol:carol@example.com";

test.before(async () => {
  setupFake();
  const router = require("../routes/tenant");
  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api/tenant", router);
  await new Promise((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

let aliceCo;
let bobCo;
let aliceInvoice;

test("requests without a token are rejected", async () => {
  const r = await call(null, "GET", "/me");
  assert.equal(r.status, 401);
});

test("bootstrap creates one company per new user with safe defaults", async () => {
  const a = await call(ALICE, "POST", "/bootstrap", {});
  assert.equal(a.status, 200);
  aliceCo = a.data.companies[0].id;
  const b = await call(BOB, "POST", "/bootstrap", {});
  bobCo = b.data.companies[0].id;
  assert.notEqual(aliceCo, bobCo);
  const co = await call(ALICE, "GET", `/companies/${aliceCo}`);
  assert.equal(co.data.vatRegistered, false);
  assert.equal(co.data.defaultCurrency, "ZAR");
  assert.equal(co.data.role, "owner");
});

test("a user only sees companies they belong to", async () => {
  const me = await call(BOB, "GET", "/me");
  assert.deepEqual(me.data.companies.map((c) => c.id), [bobCo]);
});

test("cross-tenant reads and writes are forbidden", async () => {
  const cust = await call(ALICE, "POST", `/companies/${aliceCo}/customers`, { name: "Acme" });
  assert.equal(cust.status, 201);
  const inv = await call(ALICE, "POST", `/companies/${aliceCo}/invoices`, {
    finalize: true,
    customerId: cust.data.id,
    items: [{ description: "Work", qty: 1, unitPrice: 1000 }],
  });
  assert.equal(inv.status, 201);
  aliceInvoice = inv.data.id;

  const paths = [
    ["GET", `/companies/${aliceCo}`],
    ["GET", `/companies/${aliceCo}/invoices`],
    ["GET", `/companies/${aliceCo}/invoices/${aliceInvoice}`],
    ["GET", `/companies/${aliceCo}/reports`],
    ["GET", `/companies/${aliceCo}/summary`],
    ["GET", `/companies/${aliceCo}/expenses`],
    ["GET", `/companies/${aliceCo}/members`],
    ["POST", `/companies/${aliceCo}/payments`, { invoiceId: aliceInvoice, amount: 10 }],
    ["PATCH", `/companies/${aliceCo}`, { name: "Hacked" }],
    ["POST", `/companies/${aliceCo}/invites`, { role: "admin" }],
  ];
  for (const [method, path, body] of paths) {
    const r = await call(BOB, method, path, body);
    assert.equal(r.status, 403, `${method} ${path} should be 403, got ${r.status}`);
  }
});

test("ids from another tenant are not reachable through your own company", async () => {
  const r = await call(BOB, "GET", `/companies/${bobCo}/invoices/${aliceInvoice}`);
  assert.equal(r.status, 404);
  const p = await call(BOB, "POST", `/companies/${bobCo}/payments`, { invoiceId: aliceInvoice, amount: 10 });
  assert.equal(p.status, 404);
  const own = await call(BOB, "GET", `/companies/${bobCo}/invoices`);
  assert.equal(own.data.invoices.length, 0);
  const aliceCustomers = await call(ALICE, "GET", `/companies/${aliceCo}/customers`);
  const leak = await call(BOB, "POST", `/companies/${bobCo}/invoices`, { draft: true, customerId: aliceCustomers.data.customers[0].id });
  assert.equal(leak.status, 400);
});

test("invites, roles and member management follow role rules", async () => {
  const inv = await call(ALICE, "POST", `/companies/${aliceCo}/invites`, { email: "carol@example.com", role: "member" });
  assert.equal(inv.status, 201);
  const wrong = await call(BOB, "POST", `/invites/${inv.data.token}/accept`);
  assert.equal(wrong.status, 403);
  const ok = await call(CAROL, "POST", `/invites/${inv.data.token}/accept`);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.companyId, aliceCo);

  assert.equal((await call(CAROL, "GET", `/companies/${aliceCo}/invoices`)).status, 200);
  assert.equal((await call(CAROL, "PATCH", `/companies/${aliceCo}`, { name: "x" })).status, 403);
  assert.equal((await call(CAROL, "POST", `/companies/${aliceCo}/invites`, {})).status, 403);
  assert.equal((await call(CAROL, "POST", `/companies/${aliceCo}/invoices/${aliceInvoice}/void`)).status, 403);

  const promote = await call(ALICE, "PATCH", `/companies/${aliceCo}/members/carol`, { role: "admin" });
  assert.equal(promote.status, 200);
  assert.equal((await call(CAROL, "PATCH", `/companies/${aliceCo}/members/alice`, { role: "member" })).status, 403);
  assert.equal((await call(CAROL, "DELETE", `/companies/${aliceCo}/members/alice`)).status, 403);
  assert.equal((await call(CAROL, "PATCH", `/companies/${aliceCo}/members/carol`, { role: "owner" })).status, 403);

  assert.equal((await call(ALICE, "PATCH", `/companies/${aliceCo}/members/alice`, { role: "admin" })).status, 400);
  assert.equal((await call(ALICE, "DELETE", `/companies/${aliceCo}/members/alice`)).status, 400);

  assert.equal((await call(ALICE, "DELETE", `/companies/${aliceCo}/members/carol`)).status, 200);
  assert.equal((await call(CAROL, "GET", `/companies/${aliceCo}/invoices`)).status, 403);

  const members = await call(ALICE, "GET", `/companies/${aliceCo}/members`);
  assert.deepEqual(members.data.members.map((m) => m.id), ["alice"]);
});

test("settings validation keeps VAT off by default and bank accounts as text", async () => {
  const r = await call(ALICE, "PATCH", `/companies/${aliceCo}`, {
    name: "Ezintsha Holdings",
    bankAccounts: [
      { label: "ZAR bank", currency: "ZAR", details: "Account 123\nBranch 250655" },
      { label: "USD Wise", currency: "USD", details: "Account 987\nACH routing 000000000" },
    ],
    invoicePrefix: "EZ-",
    invoiceNextNumber: 40,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.vatRegistered, false);
  assert.equal(r.data.bankAccounts.length, 2);
  assert.equal(r.data.invoicePrefix, "EZ-");
  assert.equal(r.data.invoiceNextNumber, 40);
  const bad = await call(ALICE, "PATCH", `/companies/${aliceCo}`, { logoDataUrl: "javascript:alert(1)" });
  assert.equal(bad.status, 400);
});

test("invoice PDF HTML picks the bank account matching the invoice currency", async () => {
  const cust = await call(ALICE, "POST", `/companies/${aliceCo}/customers`, { name: "US Client", currency: "USD" });
  const inv = await call(ALICE, "POST", `/companies/${aliceCo}/invoices`, {
    finalize: true,
    customerId: cust.data.id,
    items: [{ description: "Sprint", qty: 1, unitPrice: 2000 }],
  });
  assert.equal(inv.data.currency, "USD", "customer default currency is used");
  const res = await fetch(`${base}/api/tenant/companies/${aliceCo}/invoices/${inv.data.id}/pdf?format=html`, {
    headers: { Authorization: `Bearer ${ALICE}` },
  });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /USD Wise/);
  assert.doesNotMatch(html, /ZAR bank/);
  assert.doesNotMatch(html, /VAT/);
});
