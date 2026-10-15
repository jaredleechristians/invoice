const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { ROLES, canInvite, canManageSettings, canDeleteCompany } = require("./permissions");
const { logAudit } = require("./audit");

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function companyRef(db, companyId) {
  return db.collection("companies").doc(companyId);
}

async function listCompaniesForUser(uid) {
  const db = getDb();
  if (!db) return [];
  const snap = await db
    .collectionGroup("members")
    .where("userId", "==", uid)
    .get();
  const out = [];
  for (const doc of snap.docs) {
    const companyId = doc.ref.parent.parent.id;
    const companySnap = await companyRef(db, companyId).get();
    if (!companySnap.exists) continue;
    out.push({
      id: companyId,
      ...companySnap.data(),
      role: doc.data().role,
    });
  }
  return out;
}

async function getMembership(companyId, uid) {
  const db = getDb();
  if (!db) return null;
  const snap = await companyRef(db, companyId).collection("members").doc(uid).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function createCompany({ uid, email, name }) {
  const db = getDb();
  const companyId = randomId();
  const now = new Date().toISOString();
  const company = {
    name: name || "My company",
    createdAt: now,
    updatedAt: now,
    ownerUid: uid,
    invoicePrefix: "INV-",
    invoiceNextNumber: 1,
  };
  await db.runTransaction(async (tx) => {
    const cref = companyRef(db, companyId);
    tx.set(cref, company);
    tx.set(cref.collection("members").doc(uid), {
      userId: uid,
      email: email || "",
      role: "owner",
      joinedAt: now,
    });
    tx.set(cref.collection("counters").doc("invoices"), { next: 1, prefix: "INV-" });
  });
  await logAudit({
    companyId,
    uid,
    email,
    action: "company.create",
    payload: { name: company.name },
  });
  return { id: companyId, ...company, role: "owner" };
}

async function bootstrapUser({ uid, email, displayName }) {
  const existing = await listCompaniesForUser(uid);
  if (existing.length) return { companies: existing, created: false };
  const company = await createCompany({
    uid,
    email,
    name: displayName ? `${displayName}'s company` : "My company",
  });
  return { companies: [company], created: true };
}

async function updateCompanySettings(companyId, uid, email, role, patch) {
  if (!canManageSettings(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const db = getDb();
  const allowed = {};
  if (patch.name != null) allowed.name = String(patch.name).trim();
  if (patch.invoicePrefix != null) allowed.invoicePrefix = String(patch.invoicePrefix);
  if (patch.banking != null) allowed.banking = patch.banking;
  if (patch.legal != null) allowed.legal = patch.legal;
  if (patch.footer != null) allowed.footer = patch.footer;
  allowed.updatedAt = new Date().toISOString();
  await companyRef(db, companyId).set(allowed, { merge: true });
  await logAudit({ companyId, uid, email, action: "company.update", payload: allowed });
  const snap = await companyRef(db, companyId).get();
  return { id: companyId, ...snap.data() };
}

async function createInvite(
  companyId,
  uid,
  actorEmail,
  actorRole,
  { email: inviteeEmail = "", role: inviteRole = "member" } = {}
) {
  if (!canInvite(actorRole)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  if (!ROLES.includes(inviteRole) || inviteRole === "owner") {
    const err = new Error("Invalid invite role");
    err.status = 400;
    throw err;
  }
  const db = getDb();
  const inviteId = randomId();
  const token = randomId() + randomId();
  const now = Date.now();
  const doc = {
    token,
    email: inviteeEmail ? String(inviteeEmail).trim().toLowerCase() : "",
    role: inviteRole,
    createdBy: uid,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
  };
  await companyRef(db, companyId).collection("invites").doc(inviteId).set(doc);
  await logAudit({
    companyId,
    uid,
    email: actorEmail,
    action: "invite.create",
    payload: { inviteId, role: inviteRole },
  });
  return { id: inviteId, ...doc };
}

async function acceptInvite(token, uid, userEmail) {
  const db = getDb();
  const snap = await db.collectionGroup("invites").where("token", "==", token).limit(1).get();
  if (snap.empty) {
    const err = new Error("Invite not found");
    err.status = 404;
    throw err;
  }
  const inviteDoc = snap.docs[0];
  const invite = inviteDoc.data();
  if (new Date(invite.expiresAt).getTime() < Date.now()) {
    const err = new Error("Invite expired");
    err.status = 410;
    throw err;
  }
  if (invite.email && userEmail && invite.email !== userEmail.toLowerCase()) {
    const err = new Error("Invite email mismatch");
    err.status = 403;
    throw err;
  }
  const companyId = inviteDoc.ref.parent.parent.id;
  const memberRef = companyRef(db, companyId).collection("members").doc(uid);
  const existing = await memberRef.get();
  if (existing.exists) {
    return { companyId, alreadyMember: true };
  }
  const now = new Date().toISOString();
  await db.runTransaction(async (tx) => {
    tx.set(memberRef, {
      userId: uid,
      email: userEmail || "",
      role: invite.role,
      joinedAt: now,
    });
    tx.delete(inviteDoc.ref);
  });
  await logAudit({
    companyId,
    uid,
    email: userEmail,
    action: "invite.accept",
    payload: { role: invite.role },
  });
  return { companyId, alreadyMember: false };
}

async function deleteCompany(companyId, uid, email, role) {
  if (!canDeleteCompany(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
  const db = getDb();
  await companyRef(db, companyId).delete();
  await logAudit({ companyId, uid, email, action: "company.delete", payload: {} });
}

module.exports = {
  listCompaniesForUser,
  getMembership,
  createCompany,
  bootstrapUser,
  updateCompanySettings,
  createInvite,
  acceptInvite,
  deleteCompany,
  companyRef,
};
