const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
process.env.API_KEY_PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
const { setupFake } = require("./helpers/setup");

let db;
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

const ANA = "ana:ana@example.com";
const BEN = "ben:ben@example.com";
let co;
let other;
let readKey;
let rwKey;
let rwKeyId;
let customerId;

test.before(async () => {
  db = setupFake();
  const app = express();
  app.use(express.json());
  app.use("/api/tenant", require("../routes/tenant"));
  await new Promise((r) => (server = app.listen(0, "127.0.0.1", r)));
  base = `http://127.0.0.1:${server.address().port}`;
  co = (await call(ANA, "POST", "/bootstrap")).data.companies[0].id;
  other = (await call(ANA, "POST", "/companies", { name: "Other Co" })).data.id;
  customerId = (await call(ANA, "POST", `/companies/${co}/customers`, { name: "Acme" })).data.id;
});
test.after(() => server?.close());

test("creating a key returns it once; only a hash is stored", async () => {
  const r = await call(ANA, "POST", `/companies/${co}/api-keys`, { name: "Zapier", scope: "read" });
  assert.equal(r.status, 201);
  readKey = r.data.key;
  assert.match(readKey, /^inv_live_[A-Za-z0-9_-]{43}$/);
  assert.equal(r.data.prefix, readKey.slice(0, 15));
  assert.equal(r.data.scope, "read");
  assert.equal(r.data.expiresAt, null);

  const stored = (await db.collection("apiKeys").doc(r.data.id).get()).data();
  assert.equal(stored.key, undefined);
  assert.ok(!JSON.stringify(stored).includes(readKey.slice(9)), "no plaintext secret stored");
  assert.match(stored.hash, /^[0-9a-f]{64}$/);
  assert.equal(stored.createdBy, "ana");

  const list = await call(ANA, "GET", `/companies/${co}/api-keys`);
  assert.equal(list.status, 200);
  assert.equal(list.data.keys.length, 1);
  assert.equal(list.data.keys[0].key, undefined, "list never shows the key");
  assert.equal(list.data.keys[0].hash, undefined, "list never shows the hash");

  const rw = await call(ANA, "POST", `/companies/${co}/api-keys`, { name: "Script", scope: "read_write", expiresInDays: 90 });
  rwKey = rw.data.key;
  rwKeyId = rw.data.id;
  const days = (Date.parse(rw.data.expiresAt) - Date.now()) / 86400000;
  assert.ok(days > 89.9 && days <= 90);
  assert.equal((await call(ANA, "POST", `/companies/${co}/api-keys`, { name: "x", scope: "admin" })).status, 400);
  assert.equal((await call(ANA, "POST", `/companies/${co}/api-keys`, { name: "x", expiresInDays: 7 })).status, 400);
});

test("a key authenticates as its user on its company, and only there", async () => {
  const r = await call(readKey, "GET", `/companies/${co}/customers`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.customers.map((c) => c.name), ["Acme"]);
  assert.equal((await call(readKey, "GET", `/companies/${co}/invoices`)).status, 200);
  const wrong = await call(readKey, "GET", `/companies/${other}/customers`);
  assert.equal(wrong.status, 403);
  assert.match(wrong.data.error, /different company/);
  assert.equal((await call(readKey, "GET", "/me")).status, 403, "keys are refused outside company routes");
  assert.equal((await call(readKey, "POST", "/companies", { name: "Nope" })).status, 403);
  assert.equal((await call("inv_live_" + "A".repeat(43), "GET", `/companies/${co}/customers`)).status, 401);
  assert.equal((await call("inv_live_short", "GET", `/companies/${co}/customers`)).status, 401);
  const used = (await call(ANA, "GET", `/companies/${co}/api-keys`)).data.keys.find((k) => k.name === "Zapier");
  assert.ok(used.lastUsedAt, "lastUsedAt is recorded");
});

test("read-only keys block every write", async () => {
  for (const [m, p, b] of [
    ["POST", "/customers", { name: "X" }],
    ["PATCH", `/customers/${customerId}`, { name: "Y" }],
    ["POST", "/invoices", { draft: true, customerId, items: [{ description: "a", qty: 1, unitPrice: 1 }] }],
    ["DELETE", `/customers/${customerId}`],
  ]) {
    const r = await call(readKey, m, `/companies/${co}${p}`, b);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.match(r.data.error, /read only/);
  }
});

test("read-write keys create drafts but can't publish, void, delete or change settings", async () => {
  const cust = await call(rwKey, "POST", `/companies/${co}/customers`, { name: "Via key" });
  assert.equal(cust.status, 201);
  const inv = await call(rwKey, "POST", `/companies/${co}/invoices`, { customerId, items: [{ description: "Work", qty: 1, unitPrice: 100 }] });
  assert.equal(inv.status, 201);
  assert.equal(inv.data.draft, true, "invoices from a key are always drafts");
  assert.equal((await call(rwKey, "PATCH", `/companies/${co}/invoices/${inv.data.id}`, { notes: "ok" })).status, 200);
  assert.equal((await call(rwKey, "PATCH", `/companies/${co}/invoices/${inv.data.id}`, { finalize: true })).status, 403);
  assert.equal((await call(rwKey, "POST", `/companies/${co}/invoices`, { finalize: true, customerId, items: [{ description: "a", qty: 1, unitPrice: 1 }] })).status, 403);
  assert.equal((await call(rwKey, "POST", `/companies/${co}/invoices/${inv.data.id}/finalize`)).status, 403);
  assert.equal((await call(rwKey, "DELETE", `/companies/${co}/invoices/${inv.data.id}`)).status, 403);
  assert.equal((await call(rwKey, "DELETE", `/companies/${co}/customers/${cust.data.id}`)).status, 403);
  assert.equal((await call(rwKey, "PATCH", `/companies/${co}`, { name: "Hacked" })).status, 403);
  assert.equal((await call(rwKey, "POST", `/companies/${co}/invites`, { email: "x@example.com", role: "admin" })).status, 403);
  assert.equal((await call(rwKey, "GET", `/companies/${co}/invites`)).status, 403, "invite tokens stay hidden from keys");
  assert.equal((await call(rwKey, "POST", `/companies/${co}/bank-accounts`, { name: "Mine" })).status, 403);
  assert.equal((await call(rwKey, "POST", `/companies/${co}/assistant`, { messages: [{ role: "user", content: "hi" }] })).status, 403);

  // Published invoices can't be edited by a key.
  const pub = await call(ANA, "POST", `/companies/${co}/invoices`, { finalize: true, customerId, items: [{ description: "a", qty: 1, unitPrice: 10 }] });
  assert.equal((await call(rwKey, "PATCH", `/companies/${co}/invoices/${pub.data.id}`, { notes: "x" })).status, 403);
  // Recording a payment is allowed (same as the assistant).
  assert.equal((await call(rwKey, "POST", `/companies/${co}/payments`, { invoiceId: pub.data.id, amount: 5, paidAt: "2026-11-01" })).status, 201);

  // Writes through a key are audited with the key id.
  const logs = (await db.collection("companies").doc(co).collection("auditLog").get()).docs.map((d) => d.data());
  const viaKey = logs.filter((l) => l.apiKeyId === rwKeyId);
  assert.ok(viaKey.length >= 3);
  assert.ok(viaKey.every((l) => l.via === "api_key" && l.actorUid === "ana"));
});

test("keys can't list, create or revoke keys", async () => {
  assert.equal((await call(rwKey, "GET", `/companies/${co}/api-keys`)).status, 403);
  assert.equal((await call(rwKey, "POST", `/companies/${co}/api-keys`, { name: "child", scope: "read_write" })).status, 403);
  assert.equal((await call(rwKey, "POST", `/companies/${co}/api-keys/${rwKeyId}/revoke`)).status, 403);
});

test("members manage only their own keys; admins see and revoke all; removed members' keys stop working", async () => {
  await db.collection("companies").doc(co).collection("members").doc("ben").set({ userId: "ben", email: "ben@example.com", role: "member", joinedAt: new Date().toISOString() });
  const benKey = await call(BEN, "POST", `/companies/${co}/api-keys`, { name: "Ben's", scope: "read_write" });
  assert.equal(benKey.status, 201);
  assert.deepEqual((await call(BEN, "GET", `/companies/${co}/api-keys`)).data.keys.map((k) => k.name), ["Ben's"]);
  assert.equal((await call(BEN, "POST", `/companies/${co}/api-keys/${rwKeyId}/revoke`)).status, 403);
  assert.equal((await call(ANA, "GET", `/companies/${co}/api-keys`)).data.keys.length, 3);
  assert.equal((await call(benKey.data.key, "GET", `/companies/${co}/customers`)).status, 200);
  await db.collection("companies").doc(co).collection("members").doc("ben").delete();
  assert.equal((await call(benKey.data.key, "GET", `/companies/${co}/customers`)).status, 403);
});

test("revoked and expired keys are rejected", async () => {
  const rev = await call(ANA, "POST", `/companies/${co}/api-keys/${rwKeyId}/revoke`);
  assert.equal(rev.status, 200);
  assert.equal(rev.data.status, "revoked");
  const r = await call(rwKey, "GET", `/companies/${co}/customers`);
  assert.equal(r.status, 401);
  assert.match(r.data.error, /revoked/);

  const exp = await call(ANA, "POST", `/companies/${co}/api-keys`, { name: "Short", expiresInDays: 30 });
  await db.collection("apiKeys").doc(exp.data.id).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }, { merge: true });
  const e = await call(exp.data.key, "GET", `/companies/${co}/customers`);
  assert.equal(e.status, 401);
  assert.match(e.data.error, /expired/);
});

test("per-key rate limit", async () => {
  require("../lib/apiKeys").__resetRateLimit();
  const k = (await call(ANA, "POST", `/companies/${co}/api-keys`, { name: "Busy" })).data.key;
  let last;
  for (let i = 0; i < 121; i++) last = await call(k, "GET", `/companies/${co}/summary`);
  assert.equal(last.status, 429);
});

test("without a pepper, keys are disabled", async () => {
  const saved = process.env.API_KEY_PEPPER;
  delete process.env.API_KEY_PEPPER;
  try {
    assert.equal((await call(ANA, "POST", `/companies/${co}/api-keys`, { name: "x" })).status, 503);
    assert.equal((await call(readKey, "GET", `/companies/${co}/customers`)).status, 503);
  } finally {
    process.env.API_KEY_PEPPER = saved;
  }
});
