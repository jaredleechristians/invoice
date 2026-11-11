const { firebaseConfigured, getDb, verifyIdToken } = require("./firebase");

const { httpError } = require("./errors");
const apiKeys = require("./apiKeys");

function bearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/**
 * Verify a Firebase ID token. API keys are refused here unless allowApiKey is
 * set (only the company routes accept them); then req.apiKey is filled in.
 */
async function verifyRequest(req, { allowApiKey = false } = {}) {
  if (!firebaseConfigured()) {
    throw httpError(
      503,
      "Signed-in features are not configured (Firebase is missing)."
    );
  }
  const token = bearer(req);
  if (!token) throw httpError(401, "Missing bearer token");
  if (apiKeys.looksLikeApiKey(token)) {
    if (!allowApiKey) throw httpError(403, "API keys only work on company endpoints");
    const { user, apiKey } = await apiKeys.authenticateKey(token);
    req.apiKey = apiKey;
    return user;
  }

  try {
    const decoded = await verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email || "",
      name: decoded.name || decoded.email || "",
    };
  } catch {
    throw httpError(401, "Invalid or expired token");
  }
}

async function requireUser(req, res, next) {
  try {
    req.user = await verifyRequest(req);
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

/** Signed-in user or API key (company routes only; requireMember checks the company). */
async function requireUserOrKey(req, res, next) {
  try {
    req.user = await verifyRequest(req, { allowApiKey: true });
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

async function requireMember(req, res, next) {
  try {
    const user = req.user || (await verifyRequest(req));
    req.user = user;
    const companyId = req.params.companyId || req.body?.companyId;
    if (!companyId) throw httpError(400, "companyId is required");
    if (req.apiKey && req.apiKey.companyId !== companyId) throw httpError(403, "This API key is for a different company");
    const db = getDb();
    const snap = await db
      .collection("companies")
      .doc(companyId)
      .collection("members")
      .doc(user.uid)
      .get();
    if (!snap.exists) throw httpError(403, "Not a member of this company");
    req.companyId = companyId;
    req.membership = { id: user.uid, ...snap.data() };
    req.role = snap.data().role;
    next();
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
}

module.exports = { httpError, verifyRequest, requireUser, requireUserOrKey, requireMember };
