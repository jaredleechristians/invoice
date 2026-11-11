const ROLES = ["owner", "admin", "member"];

const isAdmin = (role) => role === "owner" || role === "admin";

function canInvite(role) {
  return isAdmin(role);
}

function canManageSettings(role) {
  return isAdmin(role);
}

function canManageMembers(role) {
  return isAdmin(role);
}

function canDeleteCompany(role) {
  return role === "owner";
}

function canDeleteRecords(role) {
  return isAdmin(role);
}

function canWriteRecords(role) {
  return ROLES.includes(role);
}

function assertRole(role, allowed) {
  if (!allowed.includes(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}

function assertCan(check, role) {
  if (!check(role)) {
    const err = new Error("Forbidden");
    err.status = 403;
    throw err;
  }
}

module.exports = {
  ROLES,
  canInvite,
  canManageSettings,
  canManageMembers,
  canDeleteCompany,
  canDeleteRecords,
  canWriteRecords,
  assertRole,
  assertCan,
};
