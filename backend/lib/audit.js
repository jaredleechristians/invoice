const { AsyncLocalStorage } = require("node:async_hooks");
const { getDb } = require("./firebase");
const { randomId } = require("./ids");

// Extra audit fields for everything logged inside a context, e.g. writes the
// assistant performs after the user confirmed them ({ via: "assistant" }).
const auditContext = new AsyncLocalStorage();

function withAuditContext(extra, fn) {
  return auditContext.run({ ...(auditContext.getStore() || {}), ...extra }, fn);
}

async function logAudit({ companyId, uid, email, action, payload }) {
  const db = getDb();
  if (!db) return;
  const ctx = auditContext.getStore() || {};
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
      ...(ctx.via ? { via: ctx.via } : {}),
      ...(ctx.assistantActionId ? { assistantActionId: ctx.assistantActionId } : {}),
      ...(ctx.apiKeyId ? { apiKeyId: ctx.apiKeyId } : {}),
      createdAt: new Date().toISOString(),
    });
}

module.exports = { logAudit, withAuditContext };
