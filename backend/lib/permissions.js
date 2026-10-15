const ROLES = ["owner", "admin", "member"];

function canInvite(role) {
  return role === "owner" || role === "admin";
}

function canManageSettings(role) {
  return role === "owner" || role === "admin";
}

function canDeleteCompany(role) {
  return role === "owner";
}

function canDeleteRecords(role) {
  return role === "owner" || role === "admin";
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

module.exports = {
  ROLES,
  canInvite,
  canManageSettings,
  canDeleteCompany,
  canDeleteRecords,
  canWriteRecords,
  assertRole,
};
