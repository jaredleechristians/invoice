const { deletion } = require("./softDelete");
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { canWriteRecords, canDeleteRecords, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { fetchAll } = require("./db");
const { toIsoDate, todayIso } = require("./dates");
const { roundMoney, normalizeCurrency } = require("./money");

const MAX_MINUTES = 100 * 60;
const SOURCES = new Set(["manual", "assistant"]);

function timeCol(db, companyId) {
  return companyRef(db, companyId).collection("timeEntries");
}

function hoursFromMinutes(minutes) {
  return Math.round((Number(minutes) || 0) * 100 / 60) / 100;
}

function parseMinutes(body) {
  if (body.minutes !== undefined && body.minutes !== null && body.minutes !== "") {
    const n = Number(body.minutes);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_MINUTES) {
      throw httpError(400, `Minutes must be a whole number from 1 to ${MAX_MINUTES}`);
    }
    return n;
  }
  if (body.hours !== undefined && body.hours !== null && body.hours !== "") {
    const h = Number(body.hours);
    if (!Number.isFinite(h) || h <= 0 || h > MAX_MINUTES / 60) {
      throw httpError(400, `Hours must be greater than 0 and at most ${MAX_MINUTES / 60}`);
    }
    const minutes = Math.round(h * 60);
    if (minutes <= 0) throw httpError(400, "Hours is too small");
    return minutes;
  }
  throw httpError(400, "Enter hours or minutes");
}

function entryIdsFromItems(items) {
  return [...new Set((items || []).map((i) => String(i.timeEntryId || "").trim()).filter(Boolean))];
}

function withComputed(entry) {
  const billed = Boolean(entry.billedAt && entry.invoiceId);
  const reserved = Boolean(entry.invoiceId && !entry.billedAt);
  return {
    ...entry,
    hours: hoursFromMinutes(entry.minutes),
    billed,
    reserved,
    status: entry.billable ? (billed ? "billed" : reserved ? "reserved" : "unbilled") : "internal",
  };
}

async function agreementNames(companyId, rows) {
  const ids = [...new Set(rows.map((e) => e.agreementId).filter(Boolean))];
  if (!ids.length) return {};
  const { getDb } = require("./firebase");
  const { companyRef } = require("./refs");
  const names = {};
  await Promise.all(ids.map(async (id) => {
    const snap = await companyRef(getDb(), companyId).collection("agreements").doc(id).get();
    if (snap.exists && !snap.data().deletedAt) names[id] = snap.data().name || "";
  }));
  return names;
}

async function listTimeEntries(companyId, filters = {}) {
  const rows = (await fetchAll(timeCol(getDb(), companyId))).map(withComputed);
  const names = await agreementNames(companyId, rows);
  for (const e of rows) {
    if (e.agreementId && !e.agreementName) e.agreementName = names[e.agreementId] || "";
  }
  const needle = String(filters.q || "").trim().toLowerCase();
  return rows
    .filter((e) => {
      if (filters.customerId && e.customerId !== filters.customerId) return false;
      if (filters.billable === true || filters.billable === "true") {
        if (!e.billable) return false;
      } else if (filters.billable === false || filters.billable === "false") {
        if (e.billable) return false;
      }
      if (filters.unbilled === true || filters.unbilled === "1" || filters.unbilled === "true") {
        if (!e.billable || e.invoiceId) return false;
      }
      if (filters.billed === true || filters.billed === "1" || filters.billed === "true") {
        if (!e.billed) return false;
      } else if (filters.billed === false || filters.billed === "0" || filters.billed === "false") {
        if (e.billed) return false;
      }
      if (filters.from && String(e.date || "") < String(filters.from)) return false;
      if (filters.to && String(e.date || "") > String(filters.to)) return false;
      if (filters.invoiceId && e.invoiceId !== filters.invoiceId) return false;
      if (filters.agreementId && e.agreementId !== filters.agreementId) return false;
      if (filters.periodId && e.periodId !== filters.periodId) return false;
      if (needle) {
        const hay = `${e.description || ""} ${e.notes || ""} ${e.personName || ""} ${e.customerName || ""} ${e.agreementName || ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    })
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function getTimeEntry(companyId, id) {
  const snap = await timeCol(getDb(), companyId).doc(String(id || "")).get();
  if (!snap.exists || snap.data().deletedAt) return null;
  return withComputed({ id: snap.id, ...snap.data() });
}

async function requireTimeEntry(companyId, id) {
  const entry = await getTimeEntry(companyId, id);
  if (!entry) throw httpError(404, "Time entry not found");
  return entry;
}

async function customerNameFor(companyId, customerId) {
  if (!customerId) return "";
  const { getCustomer } = require("./customers");
  const customer = await getCustomer(companyId, customerId);
  if (!customer) throw httpError(400, "Customer not found in this company");
  return customer.name || "";
}

function normalizeEntry(body, existing = {}) {
  const date = toIsoDate(body.date !== undefined ? body.date : existing.date) || todayIso();
  const description = String(body.description !== undefined ? body.description : existing.description || "").trim().slice(0, 500);
  if (!description) throw httpError(400, "Description is required");
  const billable = body.billable !== undefined ? Boolean(body.billable) : Boolean(existing.billable);
  const source = body.source !== undefined ? String(body.source || "manual") : existing.source || "manual";
  if (!SOURCES.has(source)) throw httpError(400, "source must be manual or assistant");
  const minutes = body.minutes !== undefined || body.hours !== undefined ? parseMinutes(body) : existing.minutes;
  if (!minutes) throw httpError(400, "Enter hours or minutes");
  const customerId =
    body.customerId !== undefined ? String(body.customerId || "").trim() : existing.customerId || "";
  let rate = existing.rate ?? null;
  if (body.rate !== undefined) {
    if (body.rate === null || body.rate === "") rate = null;
    else {
      rate = roundMoney(body.rate);
      if (Number.isNaN(rate) || rate < 0) throw httpError(400, "Rate cannot be negative");
    }
  }
  let currency = existing.currency || "";
  if (body.currency !== undefined) currency = body.currency ? normalizeCurrency(body.currency, "") : "";
  const agreementId =
    body.agreementId !== undefined ? String(body.agreementId || "").trim() : existing.agreementId || "";
  const periodId =
    body.periodId !== undefined ? String(body.periodId || "").trim() : existing.periodId || "";
  return {
    date,
    minutes,
    personUid: body.personUid !== undefined ? String(body.personUid || "").trim().slice(0, 100) : existing.personUid || "",
    personName: String(body.personName !== undefined ? body.personName : existing.personName || "").trim().slice(0, 200),
    customerId,
    description,
    notes: String(body.notes !== undefined ? body.notes : existing.notes || "").trim().slice(0, 2000),
    billable,
    rate,
    currency,
    agreementId,
    periodId,
    source,
  };
}

async function applyAgreementLink(companyId, data) {
  if (!data.agreementId && !data.periodId) {
    return { ...data, agreementId: "", periodId: "", agreementName: "" };
  }
  const agreements = require("./agreements");
  const link = await agreements.resolveTimeLink(companyId, data);
  return {
    ...data,
    agreementId: link.agreementId,
    periodId: link.periodId,
    customerId: link.customerId || data.customerId,
    agreementName: link.agreementName || "",
    // Retainer time counts toward the allowance; it is not ad hoc billable.
    billable: link.agreementId ? false : data.billable,
  };
}

async function createTimeEntry(companyId, uid, email, role, body = {}) {
  assertCan(canWriteRecords, role);
  const data = await applyAgreementLink(companyId, normalizeEntry(body));
  const customerName = await customerNameFor(companyId, data.customerId);
  const id = randomId();
  const now = new Date().toISOString();
  const doc = {
    ...data,
    customerName,
    invoiceId: "",
    billedAt: null,
    createdAt: now,
    updatedAt: now,
    createdBy: uid,
  };
  await timeCol(getDb(), companyId).doc(id).set(doc);
  await logAudit({ companyId, uid, email, action: "timeEntry.create", payload: { timeEntryId: id, date: data.date, billable: data.billable } });
  return withComputed({ id, ...doc });
}

async function updateTimeEntry(companyId, uid, email, role, entryId, body = {}) {
  assertCan(canWriteRecords, role);
  const existing = await requireTimeEntry(companyId, entryId);
  if (existing.invoiceId) {
    throw httpError(409, existing.billedAt
      ? "This time entry has already been invoiced"
      : "This time entry is already on a draft invoice");
  }
  const data = await applyAgreementLink(companyId, normalizeEntry(body, existing));
  const customerName = data.customerId !== existing.customerId
    ? await customerNameFor(companyId, data.customerId)
    : existing.customerName || (await customerNameFor(companyId, data.customerId));
  const patch = { ...data, customerName, updatedAt: new Date().toISOString() };
  await timeCol(getDb(), companyId).doc(entryId).set(patch, { merge: true });
  await logAudit({ companyId, uid, email, action: "timeEntry.update", payload: { timeEntryId: entryId } });
  return withComputed({ ...existing, ...patch });
}

async function deleteTimeEntry(companyId, uid, email, role, entryId) {
  assertCan(canDeleteRecords, role);
  const existing = await requireTimeEntry(companyId, entryId);
  if (existing.invoiceId) {
    throw httpError(409, "Remove this time entry from its invoice first, or void or delete the invoice");
  }
  await timeCol(getDb(), companyId).doc(entryId).set(deletion(uid), { merge: true });
  await logAudit({ companyId, uid, email, action: "timeEntry.delete", payload: { timeEntryId: entryId } });
}

async function loadEntryTx(tx, db, companyId, id) {
  const ref = timeCol(db, companyId).doc(id);
  const snap = await tx.get(ref);
  if (!snap.exists || snap.data().deletedAt) throw httpError(404, "Time entry not found");
  return { ref, data: { id: snap.id, ...snap.data() } };
}

/**
 * Read phase: load every time entry that will be reserved, billed, or freed.
 * Must run before any writes in the same Firestore transaction.
 */
async function prepareInvoiceTimeEntries(tx, db, companyId, invoiceId, { items, previousItems = [], customerId } = {}) {
  const nextIds = entryIdsFromItems(items);
  const prevIds = entryIdsFromItems(previousItems);
  const loaded = {};
  for (const id of [...new Set([...nextIds, ...prevIds])]) {
    loaded[id] = await loadEntryTx(tx, db, companyId, id);
  }
  for (const id of nextIds) {
    const { data } = loaded[id];
    if (data.agreementId) throw httpError(409, "Agreement time is billed through the retainer invoice and cannot be invoiced again");
    if (!data.billable) throw httpError(400, "Only billable time entries can be invoiced");
    if (data.invoiceId && data.invoiceId !== invoiceId) {
      throw httpError(409, "That time entry is already on another invoice");
    }
    if (customerId && data.customerId && data.customerId !== customerId) {
      throw httpError(400, "Time entries must belong to the invoice's customer");
    }
  }
  return { nextIds, prevIds, loaded };
}

/** Write phase: apply the reservation / billed mark after invoice writes. */
function commitInvoiceTimeEntries(tx, invoiceId, prepared, { billed, customerId, now } = {}) {
  if (!prepared) return;
  const stamp = now || new Date().toISOString();
  const { nextIds, prevIds, loaded } = prepared;
  for (const id of prevIds) {
    if (nextIds.includes(id)) continue;
    const { ref, data } = loaded[id];
    if (data.invoiceId && data.invoiceId !== invoiceId) continue;
    tx.set(ref, { invoiceId: "", billedAt: null, updatedAt: stamp }, { merge: true });
  }
  for (const id of nextIds) {
    const { ref, data } = loaded[id];
    tx.set(
      ref,
      {
        invoiceId,
        billedAt: billed ? stamp : null,
        updatedAt: stamp,
        ...(customerId && !data.customerId ? { customerId } : {}),
      },
      { merge: true }
    );
  }
}

/** Convenience when this is the only work in the transaction (reads, then writes). */
async function syncInvoiceTimeEntries(tx, db, companyId, invoiceId, opts) {
  const prepared = await prepareInvoiceTimeEntries(tx, db, companyId, invoiceId, opts);
  commitInvoiceTimeEntries(tx, invoiceId, prepared, opts);
}

async function prepareDetachInvoiceTimeEntries(tx, db, companyId, invoiceId, { items } = {}) {
  const ids = [...new Set(entryIdsFromItems(items))];
  const loaded = {};
  for (const id of ids) loaded[id] = await loadEntryTx(tx, db, companyId, id);
  return { ids, loaded, invoiceId };
}

function commitDetachInvoiceTimeEntries(tx, prepared, { now } = {}) {
  if (!prepared) return;
  const stamp = now || new Date().toISOString();
  for (const id of prepared.ids) {
    const { ref, data } = prepared.loaded[id];
    if (data.invoiceId && data.invoiceId !== prepared.invoiceId) continue;
    tx.set(ref, { invoiceId: "", billedAt: null, updatedAt: stamp }, { merge: true });
  }
}

async function detachInvoiceTimeEntries(tx, db, companyId, invoiceId, opts = {}) {
  const prepared = await prepareDetachInvoiceTimeEntries(tx, db, companyId, invoiceId, opts);
  commitDetachInvoiceTimeEntries(tx, prepared, opts);
}

async function runWithTx(fn) {
  const db = getDb();
  return db.runTransaction((tx) => fn(tx, db));
}

async function createInvoiceFromTime(companyId, uid, email, role, body = {}) {
  assertCan(canWriteRecords, role);
  const ids = [...new Set((body.entryIds || body.timeEntryIds || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) throw httpError(400, "Select at least one unbilled time entry");
  const entries = [];
  for (const id of ids) entries.push(await requireTimeEntry(companyId, id));
  const already = entries.filter((e) => e.invoiceId);
  if (already.length) throw httpError(409, "One or more time entries are already on an invoice");
  if (entries.some((e) => e.agreementId)) throw httpError(409, "Agreement time is billed through the retainer invoice and cannot be invoiced again");
  if (entries.some((e) => !e.billable)) throw httpError(400, "Only billable time entries can be invoiced");
  const customerIds = [...new Set(entries.map((e) => e.customerId).filter(Boolean))];
  const customerId = String(body.customerId || customerIds[0] || "").trim();
  if (!customerId) throw httpError(400, "These time entries need a customer before they can be invoiced");
  if (customerIds.some((id) => id !== customerId)) throw httpError(400, "Select time entries for a single customer");
  const defaultRate = body.rate === undefined || body.rate === null || body.rate === "" ? null : roundMoney(body.rate);
  if (defaultRate != null && (Number.isNaN(defaultRate) || defaultRate < 0)) throw httpError(400, "Rate cannot be negative");
  const items = entries.map((e) => {
    const unitPrice = e.rate != null ? e.rate : defaultRate;
    if (unitPrice == null) throw httpError(400, "Set a rate on the time entries or pass a rate");
    return {
      description: e.description,
      note: e.notes || e.date,
      qty: hoursFromMinutes(e.minutes),
      unitPrice,
      taxable: true,
      timeEntryId: e.id,
    };
  });
  const invoices = require("./invoices");
  return invoices.createInvoice(companyId, uid, email, role, {
    customerId,
    items,
    issueDate: body.issueDate,
    notes: body.notes,
    currency: body.currency,
    draft: body.finalize === true ? false : body.draft !== false,
    finalize: body.finalize === true,
  });
}

module.exports = {
  listTimeEntries,
  getTimeEntry,
  requireTimeEntry,
  createTimeEntry,
  updateTimeEntry,
  deleteTimeEntry,
  createInvoiceFromTime,
  syncInvoiceTimeEntries,
  detachInvoiceTimeEntries,
  prepareInvoiceTimeEntries,
  commitInvoiceTimeEntries,
  prepareDetachInvoiceTimeEntries,
  commitDetachInvoiceTimeEntries,
  runWithTx,
  entryIdsFromItems,
  hoursFromMinutes,
  withComputed,
};
