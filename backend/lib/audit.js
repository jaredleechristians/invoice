const { getDb } = require("./firebase");
const { randomId } = require("./ids");

async function logAudit({ companyId, uid, email, action, payload }) {
  const db = getDb();
  if (!db) return;
  await db
    .collection("companies")
    .doc(companyId)
    .collection("auditLog")
    .doc(randomId())
    .set({
      actorUid: uid,
      actorEmail: email || "",
      action,
      payload: payload || {},
      createdAt: new Date().toISOString(),
    });
}

module.exports = { logAudit };
