const { deletion } = require("./softDelete");
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { canWriteRecords, canDeleteRecords, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { roundMoney, normalizeCurrency } = require("./money");
const { fetchAll } = require("./db");

function productsCol(companyId) {
  return companyRef(getDb(), companyId).collection("products");
}

function normalizeProduct(body = {}) {
  const name = String(body.name || "").trim().slice(0, 200);
  if (!name) throw httpError(400, "Product name is required");
  const unitPrice = roundMoney(body.unitPrice);
  if (unitPrice < 0) throw httpError(400, "Price cannot be negative");
  return {
    name,
    description: String(body.description || "").trim().slice(0, 1000),
    unitPrice,
    currency: body.currency ? normalizeCurrency(body.currency, "") : "",
    kind: body.kind === "product" ? "product" : "service",
    taxable: body.taxable !== false,
    active: body.active !== false,
  };
}

async function listProducts(companyId, { includeInactive = false } = {}) {
  const rows = await fetchAll(productsCol(companyId));
  return rows
    .filter((p) => includeInactive || p.active !== false)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

async function createProduct(companyId, uid, email, role, body) {
  assertCan(canWriteRecords, role);
  const data = normalizeProduct(body);
  const id = randomId();
  const now = new Date().toISOString();
  const doc = { ...data, createdAt: now, updatedAt: now, createdBy: uid };
  await productsCol(companyId).doc(id).set(doc);
  await logAudit({ companyId, uid, email, action: "product.create", payload: { productId: id, name: data.name } });
  return { id, ...doc };
}

async function updateProduct(companyId, uid, email, role, productId, body) {
  assertCan(canWriteRecords, role);
  const ref = productsCol(companyId).doc(productId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Product not found");
  const data = normalizeProduct({ ...snap.data(), ...body });
  const patch = { ...data, updatedAt: new Date().toISOString() };
  await ref.set(patch, { merge: true });
  await logAudit({ companyId, uid, email, action: "product.update", payload: { productId } });
  return { id: productId, ...snap.data(), ...patch };
}

async function deleteProduct(companyId, uid, email, role, productId) {
  assertCan(canDeleteRecords, role);
  const ref = productsCol(companyId).doc(productId);
  const snap = await ref.get();
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Product not found");
  // Invoice lines keep their own description/price copy, so deleting is safe.
  await ref.set(deletion(uid), { merge: true });
  await logAudit({ companyId, uid, email, action: "product.delete", payload: { productId } });
}

module.exports = { listProducts, createProduct, updateProduct, deleteProduct, normalizeProduct };
