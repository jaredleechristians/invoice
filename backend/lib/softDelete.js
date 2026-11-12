/**
 * Soft deletes: records are never removed. Deleting sets deletedAt/deletedBy
 * (and is audit-logged); every list, get, report and tool skips such records.
 * Numbers stay reserved because the documents still exist.
 */
const isDeleted = (d) => Boolean(d && d.deletedAt);
const alive = (rows) => rows.filter((r) => !isDeleted(r));
const deletedSnap = (snap) => !snap.exists || isDeleted(snap.data());
const deletion = (uid) => ({ deletedAt: new Date().toISOString(), deletedBy: uid || "" });
const RESTORE = { deletedAt: null, deletedBy: null };

module.exports = { isDeleted, alive, deletedSnap, deletion, RESTORE };
