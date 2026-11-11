/**
 * What an API key may do on /companies/:companyId/* routes.
 *
 * - "read": GET only.
 * - "read_write": GET plus the same writes the assistant can make: create or
 *   edit customers and products, create expenses, create draft invoices and
 *   quotes, edit draft invoices, record payments. Never publish, void or
 *   delete, and never settings, members, invites, bank accounts, imports,
 *   reconciliation, the assistant or API keys.
 * Keys never see invites (they hold secret tokens) or API keys.
 */
const { httpError } = require("./errors");
const { withAuditContext } = require("./audit");
const invoices = require("./invoices");

const NEVER = [/^\/invites(\/|$)/, /^\/api-keys(\/|$)/, /^\/assistant(\/|$)/];

const WRITES = [
  ["POST", /^\/customers$/],
  ["PATCH", /^\/customers\/[^/]+$/],
  ["POST", /^\/products$/],
  ["PATCH", /^\/products\/[^/]+$/],
  ["POST", /^\/expenses$/],
  ["POST", /^\/invoices$/],
  ["PATCH", /^\/invoices\/[^/]+$/],
  ["POST", /^\/quotes$/],
  ["POST", /^\/payments$/],
];

const READ_METHODS = new Set(["GET", "HEAD"]);

async function checkApiKeyRequest(req) {
  const key = req.apiKey;
  const path = req.path.replace(/\/+$/, "") || "/";
  if (NEVER.some((re) => re.test(path))) throw httpError(403, "API keys can't use this endpoint");
  if (READ_METHODS.has(req.method)) return;
  if (key.scope !== "read_write") throw httpError(403, "This API key is read only");
  if (!WRITES.some(([m, re]) => m === req.method && re.test(path))) {
    throw httpError(403, "API keys can't do this (publish, void, delete and settings need the app)");
  }
  const body = req.body || {};
  if (body.finalize === true || body.draft === false) throw httpError(403, "API keys can't publish invoices");
  if (req.method === "POST" && path === "/invoices") {
    req.body = { ...body, draft: true };
    delete req.body.finalize;
  }
  if (req.method === "PATCH" && path.startsWith("/invoices/")) {
    const inv = await invoices.requireInvoice(req.companyId, path.split("/")[2]);
    if (!inv.draft) throw httpError(403, "API keys can only edit draft invoices");
  }
}

/** Express middleware for the company router. No-op for signed-in users. */
async function enforceApiKeyScope(req, res, next) {
  if (!req.apiKey) return next();
  try {
    await checkApiKeyRequest(req);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  withAuditContext({ via: "api_key", apiKeyId: req.apiKey.id }, next);
}

module.exports = { enforceApiKeyScope, checkApiKeyRequest };
