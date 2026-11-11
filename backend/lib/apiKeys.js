/**
 * Personal API keys.
 *
 * A key belongs to one user in one company and acts as that user (their
 * membership and role are re-checked on every request). Keys look like
 * `inv_live_<43 chars>` (32 random bytes, base64url). Only an HMAC-SHA256 of
 * the key (keyed with the API_KEY_PEPPER env var) is stored, plus a short
 * display prefix. The full key is returned once, when it is created.
 *
 * Stored in the top-level `apiKeys` collection, which clients can never read.
 */
const crypto = require("crypto");
const { getDb } = require("./firebase");
const { httpError } = require("./errors");
const { randomId } = require("./ids");
const { logAudit } = require("./audit");

const KEY_PREFIX = "inv_live_";
const KEY_RE = /^inv_live_[A-Za-z0-9_-]{43}$/;
const SCOPES = ["read", "read_write"];
const EXPIRY_DAYS = [30, 90, 365];
const MAX_ACTIVE_KEYS_PER_USER = 20;
const LAST_USED_THROTTLE_MS = 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_LIMIT = Number(process.env.API_KEY_RATE_LIMIT) || 120; // requests per key per minute

const col = () => getDb().collection("apiKeys");
const isAdmin = (role) => role === "owner" || role === "admin";

function pepper() {
  const p = process.env.API_KEY_PEPPER || "";
  return p.length >= 32 ? p : null;
}

function requirePepper() {
  const p = pepper();
  if (!p) throw httpError(503, "API keys are not configured on this server (API_KEY_PEPPER is missing)");
  return p;
}

function hashKey(key, p = requirePepper()) {
  return crypto.createHmac("sha256", p).update(key).digest("hex");
}

function looksLikeApiKey(token) {
  return String(token || "").startsWith("inv_");
}

function publicKey(id, d) {
  return {
    id,
    name: d.name,
    prefix: d.prefix,
    scope: d.scope,
    userId: d.userId,
    userEmail: d.userEmail || "",
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt || null,
    expiresAt: d.expiresAt || null,
    revokedAt: d.revokedAt || null,
    status: d.revokedAt ? "revoked" : d.expiresAt && d.expiresAt <= new Date().toISOString() ? "expired" : "active",
  };
}

async function listKeys(companyId, uid, role) {
  const snap = await col().where("companyId", "==", companyId).get();
  return snap.docs
    .map((doc) => publicKey(doc.id, doc.data()))
    .filter((k) => isAdmin(role) || k.userId === uid)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function createKey(companyId, uid, email, role, body = {}) {
  const p = requirePepper();
  const name = String(body.name ?? "").trim().slice(0, 80);
  if (!name) throw httpError(400, "Name is required");
  const scope = body.scope || "read";
  if (!SCOPES.includes(scope)) throw httpError(400, "Scope must be read or read_write");
  let expiresAt = null;
  if (body.expiresInDays !== undefined && body.expiresInDays !== null && body.expiresInDays !== "" && body.expiresInDays !== "never") {
    const days = Number(body.expiresInDays);
    if (!EXPIRY_DAYS.includes(days)) throw httpError(400, "Expiry must be never, 30, 90 or 365 days");
    expiresAt = new Date(Date.now() + days * 86400000).toISOString();
  }
  const mine = await col().where("companyId", "==", companyId).where("userId", "==", uid).get();
  const active = mine.docs.filter((d) => publicKey(d.id, d.data()).status === "active").length;
  if (active >= MAX_ACTIVE_KEYS_PER_USER) throw httpError(409, `You can have at most ${MAX_ACTIVE_KEYS_PER_USER} active keys in a company. Revoke one first.`);

  const key = KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
  const id = randomId();
  const now = new Date().toISOString();
  const doc = {
    companyId,
    userId: uid,
    userEmail: email || "",
    name,
    scope,
    prefix: key.slice(0, KEY_PREFIX.length + 6),
    hash: hashKey(key, p),
    createdAt: now,
    createdBy: uid,
    lastUsedAt: null,
    expiresAt,
    revokedAt: null,
  };
  await col().doc(id).set(doc);
  await logAudit({ companyId, uid, email, action: "apiKey.create", payload: { apiKeyId: id, name, scope, expiresAt } });
  return { ...publicKey(id, doc), key };
}

async function revokeKey(companyId, uid, email, role, keyId) {
  const ref = col().doc(String(keyId || ""));
  const snap = await ref.get();
  if (!snap.exists || snap.data().companyId !== companyId) throw httpError(404, "API key not found");
  const d = snap.data();
  if (d.userId !== uid && !isAdmin(role)) throw httpError(403, "You can only revoke your own keys");
  if (!d.revokedAt) {
    d.revokedAt = new Date().toISOString();
    await ref.set({ revokedAt: d.revokedAt, revokedBy: uid }, { merge: true });
    await logAudit({ companyId, uid, email, action: "apiKey.revoke", payload: { apiKeyId: snap.id, name: d.name } });
  }
  return publicKey(snap.id, d);
}

// ---------- request auth ----------

const hits = new Map(); // keyId -> { start, count }
function rateLimit(keyId, now = Date.now()) {
  const h = hits.get(keyId);
  if (!h || now - h.start >= RATE_WINDOW_MS) {
    hits.set(keyId, { start: now, count: 1 });
    if (hits.size > 10000) for (const [k, v] of hits) if (now - v.start >= RATE_WINDOW_MS) hits.delete(k);
    return;
  }
  h.count += 1;
  if (h.count > RATE_LIMIT) throw httpError(429, "Too many requests for this API key. Try again in a minute.");
}

/** Resolve a bearer key to { user, apiKey } or throw 401/429/503. */
async function authenticateKey(token) {
  const p = requirePepper();
  if (!KEY_RE.test(token)) throw httpError(401, "Invalid API key");
  const hash = hashKey(token, p);
  const snap = await col().where("hash", "==", hash).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) throw httpError(401, "Invalid API key");
  const d = doc.data();
  const a = Buffer.from(String(d.hash || ""), "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw httpError(401, "Invalid API key");
  if (d.revokedAt) throw httpError(401, "API key has been revoked");
  const now = new Date();
  if (d.expiresAt && d.expiresAt <= now.toISOString()) throw httpError(401, "API key has expired");
  rateLimit(doc.id, now.getTime());
  if (!d.lastUsedAt || now.getTime() - Date.parse(d.lastUsedAt) >= LAST_USED_THROTTLE_MS) {
    col().doc(doc.id).set({ lastUsedAt: now.toISOString() }, { merge: true }).catch(() => {});
  }
  return {
    user: { uid: d.userId, email: d.userEmail || "", name: d.userEmail || d.userId },
    apiKey: { id: doc.id, companyId: d.companyId, scope: d.scope, name: d.name },
  };
}

module.exports = {
  KEY_PREFIX,
  SCOPES,
  EXPIRY_DAYS,
  looksLikeApiKey,
  hashKey,
  listKeys,
  createKey,
  revokeKey,
  authenticateKey,
  __resetRateLimit: () => hits.clear(),
};
