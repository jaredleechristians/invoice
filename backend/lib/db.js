const { getDb } = require("./firebase");
const { companyRef } = require("./refs");

const PAGE_SIZE = 500;

/**
 * Read every document matching a query in pages (no hard row cap).
 * Uses document-snapshot cursors, so it works with or without orderBy.
 */
async function fetchAll(query, { pageSize = PAGE_SIZE } = {}) {
  const out = [];
  let last = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let q = query.limit(pageSize);
    if (last) q = q.startAfter(last);
    const snap = await q.get();
    for (const doc of snap.docs) out.push({ id: doc.id, ...doc.data() });
    if (snap.docs.length < pageSize) break;
    last = snap.docs[snap.docs.length - 1];
  }
  return out;
}

function col(companyId, name) {
  return companyRef(getDb(), companyId).collection(name);
}

module.exports = { fetchAll, col, PAGE_SIZE };
