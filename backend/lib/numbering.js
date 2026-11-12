const { getDb } = require("./firebase");
const { companyRef } = require("./refs");
const { formatInvoiceNumber } = require("./ids");

const SEQUENCES = {
  invoices: { collection: "invoices", field: "invoiceNumber", prefixField: "invoicePrefix", defaultPrefix: "INV-" },
  quotes: { collection: "quotes", field: "quoteNumber", prefixField: "quotePrefix", defaultPrefix: "QUO-" },
  journals: { collection: "journals", field: "number", prefixField: "journalPrefix", defaultPrefix: "JNL-" },
};

const MAX_SKIP = 50;

/**
 * Transactionally allocate the next number for a sequence ("invoices" | "quotes").
 * Skips numbers already used (e.g. after the admin lowers the next number),
 * so numbers stay unique per company.
 */
/**
 * Plan the next number inside an existing transaction (reads only).
 * Call `commit(tx)` during the write phase of the same transaction.
 */
async function planNumber(tx, companyId, sequence = "invoices") {
  const cfg = SEQUENCES[sequence];
  if (!cfg) throw new Error(`Unknown sequence ${sequence}`);
  const db = getDb();
  const cref = companyRef(db, companyId);
  const counterRef = cref.collection("counters").doc(sequence);
  const [counterSnap, companySnap] = await Promise.all([tx.get(counterRef), tx.get(cref)]);
  const company = companySnap.exists ? companySnap.data() : {};
  const data = counterSnap.exists ? counterSnap.data() : {};
  const prefix = data.prefix || company[cfg.prefixField] || cfg.defaultPrefix;
  let next = Number(data.next) || 1;
  let number = formatInvoiceNumber(prefix, next);
  for (let i = 0; i < MAX_SKIP; i++) {
    const clash = await tx.get(cref.collection(cfg.collection).where(cfg.field, "==", number).limit(1));
    if (clash.empty) break;
    next += 1;
    number = formatInvoiceNumber(prefix, next);
  }
  const storedNext = next + 1;
  return {
    number,
    commit(writeTx) {
      writeTx.set(counterRef, { next: storedNext, prefix }, { merge: true });
    },
  };
}

async function allocateNumber(companyId, sequence = "invoices") {
  const db = getDb();
  return db.runTransaction(async (tx) => {
    const planned = await planNumber(tx, companyId, sequence);
    planned.commit(tx);
    return planned.number;
  });
}

async function readCounter(companyId, sequence = "invoices") {
  const cfg = SEQUENCES[sequence];
  const db = getDb();
  const cref = companyRef(db, companyId);
  const [snap, companySnap] = await Promise.all([
    cref.collection("counters").doc(sequence).get(),
    cref.get(),
  ]);
  const company = companySnap.exists ? companySnap.data() : {};
  const data = snap.exists ? snap.data() : {};
  return {
    prefix: data.prefix || company[cfg.prefixField] || cfg.defaultPrefix,
    next: Number(data.next) || 1,
  };
}

module.exports = { planNumber, allocateNumber, readCounter, SEQUENCES };
