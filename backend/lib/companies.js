const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const {
  ROLES,
  canInvite,
  canManageSettings,
  canManageMembers,
  canDeleteCompany,
} = require("./permissions");
const { logAudit } = require("./audit");
const { SUPPORTED_CURRENCIES, normalizeCurrency, parseAmount } = require("./money");
const { readCounter } = require("./numbering");

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LOGO_BYTES = 300 * 1024;
const MAX_BANK_ACCOUNTS = 10;

const COMPANY_DEFAULTS = {
  legalName: "",
  logoDataUrl: "",
  email: "",
  phone: "",
  website: "",
  address: "",
  registrationNumber: "",
  taxNumber: "",
  vatRegistered: false,
  vatNumber: "",
  vatRate: 15,
  // Tax year ends on the last day of this month (2 = SA: 1 Mar - end Feb).
  taxYearEndMonth: 2,
  invoicePrefix: "INV-",
  quotePrefix: "QUO-",
  defaultCurrency: "ZAR",
  currencies: ["ZAR", "USD"],
  paymentTermsDays: 30,
  quoteValidDays: 30,
  defaultNotes: "",
  legal: "",
  footer: "",
  bankAccounts: [],
};

function withDefaults(data) {
  return { ...COMPANY_DEFAULTS, ...(data || {}) };
}

async function listCompaniesForUser(uid) {
  const db = getDb();
  if (!db) return [];
  const snap = await db.collectionGroup("members").where("userId", "==", uid).get();
  const out = [];
  for (const doc of snap.docs) {
    const companyId = doc.ref.parent.parent.id;
    const companySnap = await companyRef(db, companyId).get();
    if (!companySnap.exists) continue;
    const data = companySnap.data();
    out.push({
      id: companyId,
      name: data.name,
      defaultCurrency: data.defaultCurrency || "ZAR",
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

async function getCompany(companyId) {
  const db = getDb();
  const snap = await companyRef(db, companyId).get();
  if (!snap.exists) throw httpError(404, "Company not found");
  const [inv, quo] = await Promise.all([
    readCounter(companyId, "invoices"),
    readCounter(companyId, "quotes"),
  ]);
  return {
    id: snap.id,
    ...withDefaults(snap.data()),
    invoicePrefix: inv.prefix,
    invoiceNextNumber: inv.next,
    quotePrefix: quo.prefix,
    quoteNextNumber: quo.next,
  };
}

async function createCompany({ uid, email, name }) {
  const db = getDb();
  const companyId = randomId();
  const now = new Date().toISOString();
  const company = {
    ...COMPANY_DEFAULTS,
    name: String(name || "My company").trim() || "My company",
    createdAt: now,
    updatedAt: now,
    ownerUid: uid,
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
    tx.set(cref.collection("counters").doc("invoices"), { next: 1, prefix: company.invoicePrefix });
    tx.set(cref.collection("counters").doc("quotes"), { next: 1, prefix: company.quotePrefix });
  });
  await logAudit({ companyId, uid, email, action: "company.create", payload: { name: company.name } });
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

const str = (v, max = 2000) => String(v ?? "").trim().slice(0, max);

function normalizeBankAccounts(list) {
  if (!Array.isArray(list)) throw httpError(400, "bankAccounts must be an array");
  if (list.length > MAX_BANK_ACCOUNTS) throw httpError(400, `At most ${MAX_BANK_ACCOUNTS} bank accounts`);
  return list
    .map((a) => ({
      id: str(a?.id, 40) || randomId(6),
      label: str(a?.label, 80),
      currency: a?.currency ? normalizeCurrency(a.currency, "") : "",
      details: str(a?.details, 1000),
    }))
    .filter((a) => a.label || a.details);
}

function validateLogo(value) {
  const v = String(value || "");
  if (!v) return "";
  const m = /^data:image\/(png|jpeg|jpg|webp|svg\+xml|gif);base64,([A-Za-z0-9+/=]+)$/.exec(v);
  if (!m) throw httpError(400, "Logo must be a PNG, JPEG, WebP, GIF or SVG image");
  const bytes = Math.floor((m[2].length * 3) / 4);
  if (bytes > MAX_LOGO_BYTES) throw httpError(400, "Logo must be 300 KB or smaller");
  return v;
}

function validatePrefix(value) {
  const v = String(value ?? "").slice(0, 20);
  if (!/^[A-Za-z0-9\-_/.#]*$/.test(v)) throw httpError(400, "Prefix may only contain letters, numbers and - _ / . #");
  return v;
}

function validateNextNumber(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 99999999) throw httpError(400, "Next number must be a whole number ≥ 1");
  return n;
}

/** Whitelist + validate a settings patch. Exported for tests. */
function normalizeSettingsPatch(patch = {}) {
  const out = {};
  const textFields = {
    name: 200,
    legalName: 200,
    email: 200,
    phone: 60,
    website: 200,
    address: 1000,
    registrationNumber: 80,
    taxNumber: 80,
    vatNumber: 80,
    defaultNotes: 2000,
    legal: 1000,
    footer: 1000,
  };
  for (const [key, max] of Object.entries(textFields)) {
    if (patch[key] !== undefined) out[key] = str(patch[key], max);
  }
  if (out.name !== undefined && !out.name) throw httpError(400, "Company name is required");
  if (patch.logoDataUrl !== undefined) out.logoDataUrl = validateLogo(patch.logoDataUrl);
  if (patch.vatRegistered !== undefined) out.vatRegistered = Boolean(patch.vatRegistered);
  if (patch.vatRate !== undefined) {
    const rate = parseAmount(patch.vatRate);
    if (rate < 0 || rate > 100) throw httpError(400, "VAT rate must be between 0 and 100");
    out.vatRate = rate;
  }
  if (patch.taxYearEndMonth !== undefined) {
    const m = Number(patch.taxYearEndMonth);
    if (!Number.isInteger(m) || m < 1 || m > 12) throw httpError(400, "Tax year end month must be 1-12");
    out.taxYearEndMonth = m;
  }
  if (patch.defaultCurrency !== undefined) {
    const c = normalizeCurrency(patch.defaultCurrency, "");
    if (!c) throw httpError(400, `Currency must be one of ${SUPPORTED_CURRENCIES.join(", ")}`);
    out.defaultCurrency = c;
  }
  if (patch.currencies !== undefined) {
    const list = Array.isArray(patch.currencies) ? patch.currencies : [];
    const clean = [...new Set(list.map((c) => normalizeCurrency(c, "")).filter(Boolean))];
    if (!clean.length) throw httpError(400, "Pick at least one currency");
    out.currencies = clean;
  }
  if (patch.paymentTermsDays !== undefined) {
    const d = Number(patch.paymentTermsDays);
    if (!Number.isInteger(d) || d < 0 || d > 365) throw httpError(400, "Payment terms must be 0–365 days");
    out.paymentTermsDays = d;
  }
  if (patch.quoteValidDays !== undefined) {
    const d = Number(patch.quoteValidDays);
    if (!Number.isInteger(d) || d < 0 || d > 365) throw httpError(400, "Quote validity must be 0–365 days");
    out.quoteValidDays = d;
  }
  if (patch.bankAccounts !== undefined) out.bankAccounts = normalizeBankAccounts(patch.bankAccounts);
  if (patch.invoicePrefix !== undefined) out.invoicePrefix = validatePrefix(patch.invoicePrefix);
  if (patch.quotePrefix !== undefined) out.quotePrefix = validatePrefix(patch.quotePrefix);
  if (patch.invoiceNextNumber !== undefined) out.invoiceNextNumber = validateNextNumber(patch.invoiceNextNumber);
  if (patch.quoteNextNumber !== undefined) out.quoteNextNumber = validateNextNumber(patch.quoteNextNumber);
  if (out.currencies && out.defaultCurrency && !out.currencies.includes(out.defaultCurrency)) {
    out.currencies.push(out.defaultCurrency);
  }
  return out;
}

async function updateCompanySettings(companyId, uid, email, role, patch) {
  if (!canManageSettings(role)) throw httpError(403, "Only owners and admins can change company settings");
  const db = getDb();
  const clean = normalizeSettingsPatch(patch || {});
  const { invoiceNextNumber, quoteNextNumber, ...companyFields } = clean;
  const cref = companyRef(db, companyId);
  const now = new Date().toISOString();

  await db.runTransaction(async (tx) => {
    tx.set(cref, { ...companyFields, updatedAt: now }, { merge: true });
    const invCounter = {};
    if (clean.invoicePrefix !== undefined) invCounter.prefix = clean.invoicePrefix;
    if (invoiceNextNumber !== undefined) invCounter.next = invoiceNextNumber;
    if (Object.keys(invCounter).length) {
      tx.set(cref.collection("counters").doc("invoices"), invCounter, { merge: true });
    }
    const quoCounter = {};
    if (clean.quotePrefix !== undefined) quoCounter.prefix = clean.quotePrefix;
    if (quoteNextNumber !== undefined) quoCounter.next = quoteNextNumber;
    if (Object.keys(quoCounter).length) {
      tx.set(cref.collection("counters").doc("quotes"), quoCounter, { merge: true });
    }
  });

  const auditPayload = { ...clean };
  if (auditPayload.logoDataUrl) auditPayload.logoDataUrl = "[image]";
  await logAudit({ companyId, uid, email, action: "company.update", payload: auditPayload });
  return getCompany(companyId);
}

// ---------- members ----------

async function listMembers(companyId) {
  const db = getDb();
  const snap = await companyRef(db, companyId).collection("members").get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => ROLES.indexOf(a.role) - ROLES.indexOf(b.role) || String(a.email).localeCompare(String(b.email)));
}

function countOwners(members) {
  return members.filter((m) => m.role === "owner").length;
}

/** Pure permission check for role changes. Exported for tests. */
function assertRoleChangeAllowed({ actorUid, actorRole, target, newRole, members }) {
  if (!canManageMembers(actorRole)) throw httpError(403, "Only owners and admins can manage members");
  if (!ROLES.includes(newRole)) throw httpError(400, "Invalid role");
  if ((target.role === "owner" || newRole === "owner") && actorRole !== "owner") {
    throw httpError(403, "Only an owner can grant or change the owner role");
  }
  if (target.role === "owner" && newRole !== "owner" && countOwners(members) <= 1) {
    throw httpError(400, "A company needs at least one owner");
  }
  void actorUid;
}

function assertRemoveAllowed({ actorUid, actorRole, target, members }) {
  const self = target.id === actorUid;
  if (!self && !canManageMembers(actorRole)) throw httpError(403, "Only owners and admins can remove members");
  if (!self && target.role === "owner" && actorRole !== "owner") {
    throw httpError(403, "Only an owner can remove another owner");
  }
  if (target.role === "owner" && countOwners(members) <= 1) {
    throw httpError(400, "A company needs at least one owner");
  }
}

async function updateMemberRole(companyId, uid, email, role, memberUid, newRole) {
  const members = await listMembers(companyId);
  const target = members.find((m) => m.id === memberUid);
  if (!target) throw httpError(404, "Member not found");
  assertRoleChangeAllowed({ actorUid: uid, actorRole: role, target, newRole, members });
  const db = getDb();
  await companyRef(db, companyId).collection("members").doc(memberUid).set({ role: newRole }, { merge: true });
  await logAudit({ companyId, uid, email, action: "member.role", payload: { memberUid, from: target.role, to: newRole } });
  return { ...target, role: newRole };
}

async function removeMember(companyId, uid, email, role, memberUid) {
  const members = await listMembers(companyId);
  const target = members.find((m) => m.id === memberUid);
  if (!target) throw httpError(404, "Member not found");
  assertRemoveAllowed({ actorUid: uid, actorRole: role, target, members });
  const db = getDb();
  await companyRef(db, companyId).collection("members").doc(memberUid).delete();
  await logAudit({ companyId, uid, email, action: "member.remove", payload: { memberUid, email: target.email } });
}

// ---------- invites ----------

async function createInvite(companyId, uid, actorEmail, actorRole, { email: inviteeEmail = "", role: inviteRole = "member" } = {}) {
  if (!canInvite(actorRole)) throw httpError(403, "Only owners and admins can invite");
  if (!ROLES.includes(inviteRole) || inviteRole === "owner") throw httpError(400, "Invalid invite role");
  const db = getDb();
  const inviteId = randomId();
  const token = randomId() + randomId();
  const now = Date.now();
  const doc = {
    token,
    email: inviteeEmail ? String(inviteeEmail).trim().toLowerCase() : "",
    role: inviteRole,
    createdBy: uid,
    createdByEmail: actorEmail || "",
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
  };
  await companyRef(db, companyId).collection("invites").doc(inviteId).set(doc);
  await logAudit({ companyId, uid, email: actorEmail, action: "invite.create", payload: { inviteId, role: inviteRole, email: doc.email } });
  return { id: inviteId, ...doc };
}

async function listInvites(companyId, role) {
  if (!canInvite(role)) throw httpError(403, "Only owners and admins can view invites");
  const db = getDb();
  const snap = await companyRef(db, companyId).collection("invites").get();
  const now = Date.now();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .map((i) => ({ ...i, expired: new Date(i.expiresAt).getTime() < now }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function revokeInvite(companyId, uid, email, role, inviteId) {
  if (!canInvite(role)) throw httpError(403, "Only owners and admins can revoke invites");
  const db = getDb();
  const ref = companyRef(db, companyId).collection("invites").doc(inviteId);
  const snap = await ref.get();
  if (!snap.exists) throw httpError(404, "Invite not found");
  await ref.delete();
  await logAudit({ companyId, uid, email, action: "invite.revoke", payload: { inviteId } });
}

async function findInvite(token) {
  const db = getDb();
  const snap = await db.collectionGroup("invites").where("token", "==", String(token || "")).limit(1).get();
  if (snap.empty) throw httpError(404, "Invite not found");
  return snap.docs[0];
}

async function previewInvite(token) {
  const inviteDoc = await findInvite(token);
  const invite = inviteDoc.data();
  const companyId = inviteDoc.ref.parent.parent.id;
  const db = getDb();
  const companySnap = await companyRef(db, companyId).get();
  return {
    companyId,
    companyName: companySnap.exists ? companySnap.data().name : "",
    role: invite.role,
    email: invite.email,
    expiresAt: invite.expiresAt,
    expired: new Date(invite.expiresAt).getTime() < Date.now(),
  };
}

async function acceptInvite(token, uid, userEmail) {
  const db = getDb();
  const inviteDoc = await findInvite(token);
  const invite = inviteDoc.data();
  if (new Date(invite.expiresAt).getTime() < Date.now()) throw httpError(410, "Invite expired");
  if (invite.email && (!userEmail || invite.email !== userEmail.toLowerCase())) {
    throw httpError(403, "This invite is for a different email address");
  }
  const companyId = inviteDoc.ref.parent.parent.id;
  const memberRef = companyRef(db, companyId).collection("members").doc(uid);
  const existing = await memberRef.get();
  if (existing.exists) return { companyId, alreadyMember: true };
  const now = new Date().toISOString();
  await db.runTransaction(async (tx) => {
    tx.set(memberRef, { userId: uid, email: userEmail || "", role: invite.role, joinedAt: now });
    tx.delete(inviteDoc.ref);
  });
  await logAudit({ companyId, uid, email: userEmail, action: "invite.accept", payload: { role: invite.role } });
  return { companyId, alreadyMember: false };
}

async function deleteCompany(companyId, uid, email, role) {
  if (!canDeleteCompany(role)) throw httpError(403, "Forbidden");
  const db = getDb();
  await companyRef(db, companyId).delete();
  await logAudit({ companyId, uid, email, action: "company.delete", payload: {} });
}

module.exports = {
  COMPANY_DEFAULTS,
  withDefaults,
  listCompaniesForUser,
  getMembership,
  getCompany,
  createCompany,
  bootstrapUser,
  normalizeSettingsPatch,
  updateCompanySettings,
  listMembers,
  updateMemberRole,
  removeMember,
  assertRoleChangeAllowed,
  assertRemoveAllowed,
  createInvite,
  listInvites,
  revokeInvite,
  previewInvite,
  acceptInvite,
  deleteCompany,
  companyRef,
};
