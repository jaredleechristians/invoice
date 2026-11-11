const { firebaseConfigured, getDb, verifyIdToken } = require("./firebase");

const { httpError } = require("./errors");

async function verifyRequest(req) {
  if (!firebaseConfigured()) {
    throw httpError(
      503,
      "Signed-in features are not configured (Firebase is missing)."
    );
  }
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw httpError(401, "Missing bearer token");

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

async function requireMember(req, res, next) {
  try {
    const user = req.user || (await verifyRequest(req));
    req.user = user;
    const companyId = req.params.companyId || req.body?.companyId;
    if (!companyId) throw httpError(400, "companyId is required");
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

module.exports = { httpError, verifyRequest, requireUser, requireMember };
