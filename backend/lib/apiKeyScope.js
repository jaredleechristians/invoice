/**
 * What an API key may do on /companies/:companyId/* routes.
 *
 * - "read": GET only.
 * - "read_write": everything the key owner's role allows, including publish,
 *   void and (soft) delete, EXCEPT company settings, bank accounts (their
 *   details print on invoices), members, invites, the assistant and API keys.
 * Keys never see invites (they hold secret tokens) or API keys.
 * Invoices created with a key are drafts unless the request says finalize: true.
 */
const { httpError } = require("./errors");
const { withAuditContext } = require("./audit");

const NEVER = [/^\/invites(\/|$)/, /^\/api-keys(\/|$)/, /^\/assistant(\/|$)/];

// Blocked writes even for read_write keys (any method except GET).
const SETTINGS = [/^\/$/, /^\/members(\/|$)/, /^\/bank-accounts(\/|$)/];

const READ_METHODS = new Set(["GET", "HEAD"]);

function checkApiKeyRequest(req) {
  const key = req.apiKey;
  const path = req.path.replace(/\/+$/, "") || "/";
  if (NEVER.some((re) => re.test(path))) throw httpError(403, "API keys can't use this endpoint");
  if (READ_METHODS.has(req.method)) return;
  if (key.scope !== "read_write") throw httpError(403, "This API key is read only");
  if (SETTINGS.some((re) => re.test(path))) {
    throw httpError(403, "API keys can't change company settings, bank accounts or members. Use the app.");
  }
  if (req.method === "POST" && path === "/invoices") {
    const body = req.body || {};
    if (body.finalize !== true && body.draft !== false) req.body = { ...body, draft: true };
  }
}

/** Express middleware for the company router. No-op for signed-in users. */
function enforceApiKeyScope(req, res, next) {
  if (!req.apiKey) return next();
  try {
    checkApiKeyRequest(req);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }
  withAuditContext({ via: "api_key", apiKeyId: req.apiKey.id }, next);
}

module.exports = { enforceApiKeyScope, checkApiKeyRequest };
