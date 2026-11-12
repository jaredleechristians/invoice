// Helpers for posting bank-linked journal entries inside an existing
// Firestore transaction (reconcile, undo, opening balances).
const { getDb } = require("../firebase");
const { companyRef } = require("../refs");
const { httpError } = require("../errors");
const { bankLedgerId } = require("./accounts");
const { planPost, planReverse, sourceKey, nextVersion } = require("./post");

async function planBankEntry(tx, companyId, {
  type,
  id,
  date,
  lines,
  event = "post",
  createdBy,
  memo,
  number,
  currentLedger,
  ctx,
  kind,
}) {
  const version = currentLedger?.entryId ? nextVersion(currentLedger) : (Number(currentLedger?.version) || 0) + 1;
  const post = await planPost(tx, companyId, {
    sourceKey: sourceKey(type, id, version),
    date,
    lines,
    kind: kind || (type === "opening" ? "opening" : "auto"),
    source: { type, id, number: number || "", event, version },
    memo: memo || "",
    createdBy,
    baseCurrency: ctx.baseCurrency,
  });
  return {
    ledger: { entryId: post.id, version },
    entry: post.entry,
    skipped: post.skipped,
    commit(writeTx) {
      post.commit(writeTx);
    },
  };
}

/**
 * Average base cost of a foreign bank ledger account as at `asOf` (inclusive),
 * from already-posted journal lines: base net / foreign net.
 */
async function averageCostRate(tx, companyId, ledgerAccountId, { asOf } = {}) {
  if (!ledgerAccountId) throw httpError(400, "Bank ledger account is missing");
  const snap = await tx.get(companyRef(getDb(), companyId).collection("journals"));
  let baseNet = 0;
  let foreignNet = 0;
  for (const doc of snap.docs) {
    const entry = doc.data();
    if (asOf && entry.date > asOf) continue;
    for (const line of entry.lines || []) {
      if (line.accountId !== ledgerAccountId) continue;
      baseNet += (Number(line.debit) || 0) - (Number(line.credit) || 0);
      foreignNet += Number(line.foreignAmount) || 0;
    }
  }
  if (!foreignNet) {
    throw httpError(400, "No average cost is available for this account yet. Set an opening balance with a rate first.");
  }
  return baseNet / foreignNet;
}

function nextLedger(current) {
  return { entryId: null, version: Number(current?.version) || 0 };
}

module.exports = {
  planBankEntry,
  planBankReverse: planReverse,
  averageCostRate,
  bankLedgerId,
  sourceKey,
  nextLedger,
};
