const { deletion } = require("./softDelete");
const { getDb } = require("./firebase");
const { randomId } = require("./ids");
const { companyRef } = require("./refs");
const { httpError } = require("./errors");
const { canWriteRecords, canDeleteRecords, assertCan } = require("./permissions");
const { logAudit } = require("./audit");
const { fetchAll } = require("./db");
const { toIsoDate, todayIsoInZone } = require("./dates");
const { roundMoney, normalizeCurrency } = require("./money");
const {
  roundHours,
  periodDocumentId,
  periodLabel,
  listPeriodWindows,
  periodCoveringDate,
  closeHours,
  hoursFromEntries,
  requireIso,
  requirePeriodType,
} = require("./agreementPeriods");

const STATUSES = new Set(["draft", "active", "paused", "ended"]);
const SYSTEM_ACTOR = ["system", "system@invoice", "owner"];

function agreementsCol(db, companyId) {
  return companyRef(db, companyId).collection("agreements");
}

function periodsCol(db, companyId) {
  return companyRef(db, companyId).collection("agreementPeriods");
}

function timeCol(db, companyId) {
  return companyRef(db, companyId).collection("timeEntries");
}

function invoicesCol(db, companyId) {
  return companyRef(db, companyId).collection("invoices");
}

function emptyRollover(mode = "expire") {
  return { mode: mode === "rollover" ? "rollover" : "expire", limitHours: null };
}

function normalizeRollover(body, existing) {
  const prev = existing?.rolloverPolicy || emptyRollover();
  const raw = body.rolloverPolicy !== undefined ? body.rolloverPolicy : prev;
  const mode = raw?.mode === "rollover" ? "rollover" : "expire";
  let limitHours = null;
  if (mode === "rollover") {
    const rawLimit = raw?.limitHours;
    if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
      const n = Number(rawLimit);
      if (!Number.isFinite(n) || n < 0) throw httpError(400, "Rollover cap must be zero or a positive number of hours");
      limitHours = roundHours(n);
    }
  }
  return { mode, limitHours };
}

function normalizeAgreement(body = {}, existing = {}) {
  const name = String(body.name !== undefined ? body.name : existing.name || "").trim().slice(0, 200);
  if (!name) throw httpError(400, "Agreement name is required");
  const customerId = String(body.customerId !== undefined ? body.customerId : existing.customerId || "").trim();
  if (!customerId) throw httpError(400, "Pick a customer");
  const serviceId = String(body.serviceId !== undefined ? body.serviceId : existing.serviceId || "").trim();
  if (!serviceId) throw httpError(400, "Pick a billable service");
  const startDate = requireIso(body.startDate !== undefined ? body.startDate : existing.startDate, "startDate");
  let endDate = "";
  if (body.endDate !== undefined) endDate = body.endDate ? requireIso(body.endDate, "endDate") : "";
  else if (existing.endDate) endDate = existing.endDate;
  if (endDate && endDate < startDate) throw httpError(400, "End date cannot be before the start date");
  const period = requirePeriodType(body.period !== undefined ? body.period : existing.period || "month");
  const hoursRaw = body.hours !== undefined ? body.hours : existing.hours;
  if (hoursRaw === undefined || hoursRaw === null || hoursRaw === "") throw httpError(400, "Included hours are required");
  const hours = roundHours(hoursRaw);
  if (!Number.isFinite(hours) || hours < 0) throw httpError(400, "Included hours cannot be negative");
  const feeRaw = body.fee !== undefined ? body.fee : existing.fee;
  if (feeRaw === undefined || feeRaw === null || feeRaw === "") throw httpError(400, "Period fee is required");
  const fee = roundMoney(feeRaw);
  if (!Number.isFinite(fee) || fee < 0) throw httpError(400, "Period fee cannot be negative");
  let rate = existing.rate ?? null;
  if (body.rate !== undefined) {
    if (body.rate === null || body.rate === "") rate = null;
    else {
      rate = roundMoney(body.rate);
      if (!Number.isFinite(rate) || rate < 0) throw httpError(400, "Standard rate cannot be negative");
    }
  }
  if (rate == null) {
    rate = hours > 0 ? roundMoney(fee / hours) : 0;
  }
  let overageRate = existing.overageRate ?? null;
  if (body.overageRate !== undefined) {
    if (body.overageRate === null || body.overageRate === "") overageRate = null;
    else {
      overageRate = roundMoney(body.overageRate);
      if (!Number.isFinite(overageRate) || overageRate < 0) throw httpError(400, "Overage rate cannot be negative");
    }
  }
  const currency = normalizeCurrency(body.currency !== undefined ? body.currency : existing.currency, "");
  const autoPublish = body.autoPublish !== undefined ? Boolean(body.autoPublish) : Boolean(existing.autoPublish);
  return {
    name,
    customerId,
    serviceId,
    startDate,
    endDate,
    period,
    hours,
    fee,
    rate,
    overageRate,
    currency,
    rolloverPolicy: normalizeRollover(body, existing),
    autoPublish,
  };
}

function effectiveOverageRate(agreement) {
  const rate = agreement.overageRate != null && agreement.overageRate !== "" ? Number(agreement.overageRate) : Number(agreement.rate);
  return roundMoney(rate || 0);
}

async function customerNameFor(companyId, customerId) {
  const { getCustomer } = require("./customers");
  const customer = await getCustomer(companyId, customerId);
  if (!customer) throw httpError(400, "Customer not found in this company");
  return { customer, customerName: customer.name || "" };
}

async function loadService(companyId, serviceId) {
  const snap = await companyRef(getDb(), companyId).collection("products").doc(serviceId).get();
  if (!snap.exists || snap.data().deletedAt) throw httpError(400, "Billable service not found");
  return { id: snap.id, ...snap.data() };
}

function withAgreementComputed(row) {
  return {
    ...row,
    endDate: row.endDate || "",
    autoPublish: Boolean(row.autoPublish),
    rolloverPolicy: row.rolloverPolicy || emptyRollover(),
    status: row.status || "draft",
  };
}

async function listAgreements(companyId, filters = {}) {
  const rows = (await fetchAll(agreementsCol(getDb(), companyId))).map(withAgreementComputed);
  const needle = String(filters.q || "").trim().toLowerCase();
  return rows
    .filter((a) => {
      if (filters.customerId && a.customerId !== filters.customerId) return false;
      if (filters.status && a.status !== filters.status) return false;
      if (needle) {
        const hay = `${a.name || ""} ${a.customerName || ""}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    })
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")) || String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function getAgreement(companyId, id) {
  const snap = await agreementsCol(getDb(), companyId).doc(String(id || "")).get();
  if (!snap.exists || snap.data().deletedAt) return null;
  return withAgreementComputed({ id: snap.id, ...snap.data() });
}

async function requireAgreement(companyId, id) {
  const row = await getAgreement(companyId, id);
  if (!row) throw httpError(404, "Agreement not found");
  return row;
}

async function createAgreement(companyId, uid, email, role, body = {}) {
  assertCan(canWriteRecords, role);
  const data = normalizeAgreement(body);
  const { customerName, customer } = await customerNameFor(companyId, data.customerId);
  await loadService(companyId, data.serviceId);
  if (!data.currency) data.currency = customer.currency || (await loadCompanyCurrency(companyId));
  const id = randomId();
  const now = new Date().toISOString();
  const doc = {
    ...data,
    customerName,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    createdBy: uid,
  };
  await agreementsCol(getDb(), companyId).doc(id).set(doc);
  await logAudit({ companyId, uid, email, action: "agreement.create", payload: { agreementId: id, customerId: data.customerId } });
  return withAgreementComputed({ id, ...doc });
}

async function loadCompanyCurrency(companyId) {
  const snap = await companyRef(getDb(), companyId).get();
  return snap.exists ? snap.data().defaultCurrency || "ZAR" : "ZAR";
}

function invoicedPeriods(periods) {
  return periods.filter((p) => p.recurringInvoiceId || p.overageInvoiceId || p.invoiced);
}

async function updateAgreement(companyId, uid, email, role, agreementId, body = {}) {
  assertCan(canWriteRecords, role);
  const existing = await requireAgreement(companyId, agreementId);
  if (existing.status !== "draft") {
    if (body.customerId && body.customerId !== existing.customerId) {
      throw httpError(409, "The customer on an active agreement cannot be changed");
    }
    if (body.startDate && requireIso(body.startDate, "startDate") !== existing.startDate) {
      throw httpError(409, "The start date cannot be changed once the agreement is active");
    }
    if (body.period && requirePeriodType(body.period) !== existing.period) {
      throw httpError(409, "The period type cannot be changed once the agreement is active");
    }
    if (body.endDate !== undefined) {
      const nextEnd = body.endDate ? requireIso(body.endDate, "endDate") : "";
      const periods = await listPeriods(companyId, agreementId);
      const blocked = invoicedPeriods(periods).find((p) => nextEnd && p.startsOn > nextEnd);
      if (blocked) throw httpError(409, "End date cannot cut off a period that already has an invoice");
    }
  }
  const data = normalizeAgreement(body, existing);
  const customerChanged = data.customerId !== existing.customerId;
  const { customerName, customer } = customerChanged
    ? await customerNameFor(companyId, data.customerId)
    : { customerName: existing.customerName, customer: null };
  if (data.serviceId !== existing.serviceId) await loadService(companyId, data.serviceId);
  if (!data.currency) data.currency = existing.currency || customer?.currency || (await loadCompanyCurrency(companyId));
  const patch = { ...data, customerName, updatedAt: new Date().toISOString() };
  await agreementsCol(getDb(), companyId).doc(agreementId).set(patch, { merge: true });
  const updated = withAgreementComputed({ ...existing, ...patch });
  if (updated.status !== "draft") await recomputeOpenPeriods(companyId, updated);
  await logAudit({ companyId, uid, email, action: "agreement.update", payload: { agreementId } });
  return updated;
}

async function deleteAgreement(companyId, uid, email, role, agreementId) {
  assertCan(canDeleteRecords, role);
  await requireAgreement(companyId, agreementId);
  await agreementsCol(getDb(), companyId).doc(agreementId).set(deletion(uid), { merge: true });
  await logAudit({ companyId, uid, email, action: "agreement.delete", payload: { agreementId } });
}

async function setAgreementStatus(companyId, uid, email, role, agreementId, status, { endDate, asOf } = {}) {
  assertCan(canWriteRecords, role);
  if (!STATUSES.has(status) || status === "draft") throw httpError(400, "Status must be active, paused or ended");
  const existing = await requireAgreement(companyId, agreementId);
  if (existing.status === "ended" && status !== "ended") {
    throw httpError(409, "An ended agreement cannot be reopened. Create a new agreement instead.");
  }
  const patch = { status, updatedAt: new Date().toISOString() };
  if (status === "ended") {
    patch.endDate = endDate ? requireIso(endDate, "endDate") : existing.endDate || todayIsoInZone();
    if (patch.endDate < existing.startDate) throw httpError(400, "End date cannot be before the start date");
  }
  await agreementsCol(getDb(), companyId).doc(agreementId).set(patch, { merge: true });
  const updated = withAgreementComputed({ ...existing, ...patch });
  await logAudit({ companyId, uid, email, action: "agreement.status", payload: { agreementId, status } });
  if (status === "active" || status === "ended") {
    await generateForAgreement(companyId, uid, email, role, updated, { asOf });
  } else if (status === "paused") {
    await ensurePeriods(companyId, updated, asOf || todayIsoInZone());
  }
  return requireAgreement(companyId, agreementId);
}

async function listPeriods(companyId, agreementId) {
  const rows = (await fetchAll(periodsCol(getDb(), companyId))).filter((p) => p.agreementId === agreementId);
  rows.sort((a, b) => String(a.startsOn).localeCompare(String(b.startsOn)));
  return rows;
}

async function getPeriod(companyId, periodId) {
  const snap = await periodsCol(getDb(), companyId).doc(String(periodId || "")).get();
  if (!snap.exists || snap.data().deletedAt) return null;
  return { id: snap.id, ...snap.data() };
}

function newPeriodDoc(agreement, window, { hoursRolledIn = 0, now } = {}) {
  const id = periodDocumentId(agreement.id, window.fullStartsOn);
  return {
    id,
    doc: {
      agreementId: agreement.id,
      customerId: agreement.customerId,
      startsOn: window.startsOn,
      endsOn: window.endsOn,
      fullStartsOn: window.fullStartsOn,
      fullEndsOn: window.fullEndsOn,
      daysInPeriod: window.daysInPeriod,
      daysInFullPeriod: window.daysInFullPeriod,
      prorated: window.prorated,
      hoursAllowed: window.hoursAllowed,
      hoursRolledIn: roundHours(hoursRolledIn),
      hoursUsed: 0,
      hoursRemaining: roundHours(window.hoursAllowed + hoursRolledIn),
      hoursExpired: 0,
      hoursOverage: 0,
      hoursRolledOut: 0,
      fee: window.fee,
      currency: agreement.currency,
      recurringInvoiceId: "",
      overageInvoiceId: "",
      invoiced: false,
      status: "open",
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function recomputeOpenPeriods(companyId, agreement) {
  const db = getDb();
  const periods = await listPeriods(companyId, agreement.id);
  const now = new Date().toISOString();
  for (const period of periods) {
    if (period.status === "closed" || period.recurringInvoiceId || period.invoiced) continue;
    const window = periodCoveringDate(agreement, period.fullStartsOn || period.startsOn);
    if (!window) continue;
    await periodsCol(db, companyId).doc(period.id).set(
      {
        startsOn: window.startsOn,
        endsOn: window.endsOn,
        daysInPeriod: window.daysInPeriod,
        daysInFullPeriod: window.daysInFullPeriod,
        prorated: window.prorated,
        hoursAllowed: window.hoursAllowed,
        fee: window.fee,
        currency: agreement.currency,
        updatedAt: now,
      },
      { merge: true }
    );
  }
}

async function ensurePeriods(companyId, agreement, through) {
  const db = getDb();
  const asOf = requireIso(through || todayIsoInZone());
  const existing = await listPeriods(companyId, agreement.id);
  const byId = Object.fromEntries(existing.map((p) => [p.id, p]));
  const now = new Date().toISOString();
  const windows = listPeriodWindows(agreement, asOf);
  let rolledIn = 0;
  const out = [];
  for (const window of windows) {
    const id = periodDocumentId(agreement.id, window.fullStartsOn);
    let row = byId[id];
    if (!row) {
      const made = newPeriodDoc(agreement, window, { hoursRolledIn: rolledIn, now });
      await periodsCol(db, companyId).doc(made.id).set(made.doc);
      row = { id: made.id, ...made.doc };
    } else if (row.status !== "closed" && !row.recurringInvoiceId && !row.invoiced && row.hoursRolledIn !== rolledIn) {
      await periodsCol(db, companyId).doc(id).set({ hoursRolledIn: rolledIn, updatedAt: now }, { merge: true });
      row = { ...row, hoursRolledIn: rolledIn };
    }
    if (row.status === "closed") rolledIn = row.hoursRolledOut || 0;
    else rolledIn = 0;
    out.push(row);
  }
  return out;
}

async function entriesForPeriod(companyId, period) {
  const rows = await fetchAll(timeCol(getDb(), companyId));
  return rows.filter((e) => e.agreementId === period.agreementId && (e.periodId === period.id || (!e.periodId && e.date >= period.startsOn && e.date <= period.endsOn)));
}

async function liveHoursUsed(companyId, period) {
  return hoursFromEntries(await entriesForPeriod(companyId, period));
}

async function loadInvoiceIfPresent(companyId, invoiceId) {
  if (!invoiceId) return null;
  const snap = await invoicesCol(getDb(), companyId).doc(invoiceId).get();
  if (!snap.exists || snap.data().deletedAt) return null;
  return { id: snap.id, ...snap.data() };
}

/** An existing (even voided) invoice counts as generated; a missing/deleted one can be retried. */
async function alreadyGenerated(companyId, invoiceId, flagged) {
  if (flagged && !invoiceId) return true;
  if (!invoiceId) return false;
  const inv = await loadInvoiceIfPresent(companyId, invoiceId);
  return Boolean(inv);
}

async function closePeriod(companyId, agreement, period, hoursUsed) {
  const math = closeHours({
    hoursAllowed: period.hoursAllowed,
    hoursRolledIn: period.hoursRolledIn,
    hoursUsed,
    rolloverPolicy: agreement.rolloverPolicy,
  });
  const now = new Date().toISOString();
  const patch = {
    ...math,
    status: "closed",
    closedAt: period.closedAt || now,
    updatedAt: now,
  };
  await periodsCol(getDb(), companyId).doc(period.id).set(patch, { merge: true });
  return { ...period, ...patch };
}

function feeLine(agreement, service, period) {
  if (roundMoney(period.fee) <= 0) return null;
  return {
    description: `${service.name || agreement.name} — ${periodLabel(period.startsOn, period.endsOn)}`,
    note: period.prorated ? `Prorated ${period.daysInPeriod} of ${period.daysInFullPeriod} days` : "",
    qty: 1,
    unitPrice: period.fee,
    taxable: service.taxable !== false,
    productId: service.id,
  };
}

function overageLine(agreement, service, previous, math) {
  if (!math.hoursOverage) return null;
  const rate = effectiveOverageRate(agreement);
  return {
    description: `Overage hours — ${periodLabel(previous.startsOn, previous.endsOn)}`,
    note: `${math.hoursOverage} hours at ${rate}`,
    qty: math.hoursOverage,
    unitPrice: rate,
    taxable: service.taxable !== false,
    productId: service.id,
  };
}

async function createPeriodInvoice(companyId, uid, email, role, agreement, period, { items, asOf, overageForPeriodId } = {}) {
  const lines = (items || []).filter(Boolean);
  if (!lines.length) return null;
  const invoices = require("./invoices");
  const invoiceId = randomId();
  const issueDate = period.startsOn && overageForPeriodId ? (asOf && asOf > period.endsOn ? asOf : period.endsOn) : period.startsOn;
  const inv = await invoices.createInvoice(companyId, uid, email, role, {
    id: invoiceId,
    customerId: agreement.customerId,
    currency: agreement.currency,
    items: lines,
    issueDate,
    notes: `Agreement: ${agreement.name}`,
    draft: !agreement.autoPublish,
    finalize: Boolean(agreement.autoPublish),
    agreementId: agreement.id,
    agreementPeriodId: period.id,
    overageForPeriodId: overageForPeriodId || "",
  });
  return inv;
}

async function generateForAgreement(companyId, uid, email, role, agreement, { asOf } = {}) {
  if (agreement.status === "draft") return { invoices: [], periods: [] };
  const asOfDate = toIsoDate(asOf) || todayIsoInZone();
  const service = await loadService(companyId, agreement.serviceId);
  let periods = await ensurePeriods(companyId, agreement, asOfDate);
  const created = [];

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i];
    const previous = i > 0 ? periods[i - 1] : null;
    const due = period.startsOn <= asOfDate;
    if (!due) continue;
    if (agreement.status === "paused") continue;
    if (await alreadyGenerated(companyId, period.recurringInvoiceId, period.invoiced)) {
      continue;
    }

    let prevMath = null;
    let closedPrev = previous;
    if (previous && previous.endsOn < period.startsOn) {
      const used = previous.status === "closed" ? previous.hoursUsed : await liveHoursUsed(companyId, previous);
      closedPrev = await closePeriod(companyId, agreement, previous, used);
      periods[i - 1] = closedPrev;
      prevMath = closeHours({
        hoursAllowed: closedPrev.hoursAllowed,
        hoursRolledIn: closedPrev.hoursRolledIn,
        hoursUsed: closedPrev.hoursUsed,
        rolloverPolicy: agreement.rolloverPolicy,
      });
      if (period.hoursRolledIn !== prevMath.hoursRolledOut) {
        await periodsCol(getDb(), companyId).doc(period.id).set({ hoursRolledIn: prevMath.hoursRolledOut, updatedAt: new Date().toISOString() }, { merge: true });
        period.hoursRolledIn = prevMath.hoursRolledOut;
      }
    }

    if (agreement.status !== "active" && agreement.status !== "ended") continue;

    const items = [feeLine(agreement, service, period), prevMath ? overageLine(agreement, service, closedPrev, prevMath) : null];
    const inv = await createPeriodInvoice(companyId, uid, email, role, agreement, period, { items, asOf: asOfDate });
    const now = new Date().toISOString();
    const patch = { invoiced: true, recurringInvoiceId: inv ? inv.id : "", updatedAt: now };
    await periodsCol(getDb(), companyId).doc(period.id).set(patch, { merge: true });
    periods[i] = { ...period, ...patch };
    if (inv) {
      if (prevMath && closedPrev) {
        await periodsCol(getDb(), companyId).doc(closedPrev.id).set({ overageInvoiceId: inv.id, updatedAt: now }, { merge: true });
        periods[i - 1] = { ...closedPrev, overageInvoiceId: inv.id };
      }
      created.push(inv);
    }
  }

  // Final overage-only invoice when the agreement has ended and no later period will carry it.
  const last = periods[periods.length - 1];
  const ended = agreement.status === "ended" || (agreement.endDate && agreement.endDate <= asOfDate);
  if (last && ended && last.endsOn <= asOfDate && !(await alreadyGenerated(companyId, last.overageInvoiceId, false))) {
    const used = await liveHoursUsed(companyId, last);
    const closed = await closePeriod(companyId, agreement, last, used);
    periods[periods.length - 1] = closed;
    // The last period's overage is on a later fee invoice only if a later period exists.
    const hasLater = periods.some((p) => p.startsOn > last.startsOn);
    if (!hasLater && closed.hoursOverage > 0) {
      const inv = await createPeriodInvoice(companyId, uid, email, role, agreement, closed, {
        items: [overageLine(agreement, service, closed, closed)],
        asOf: asOfDate,
        overageForPeriodId: closed.id,
      });
      if (inv) {
        await periodsCol(getDb(), companyId).doc(closed.id).set({ overageInvoiceId: inv.id, updatedAt: new Date().toISOString() }, { merge: true });
        periods[periods.length - 1] = { ...closed, overageInvoiceId: inv.id };
        created.push(inv);
      }
    }
  }

  return { invoices: created, periods };
}

async function generateDueInvoices(companyId, uid, email, role, { asOf, agreementId } = {}) {
  assertCan(canWriteRecords, role);
  const asOfDate = toIsoDate(asOf) || todayIsoInZone();
  const agreements = agreementId
    ? [await requireAgreement(companyId, agreementId)]
    : (await listAgreements(companyId)).filter((a) => a.status === "active" || a.status === "ended" || a.status === "paused");
  const invoices = [];
  const results = [];
  for (const agreement of agreements) {
    const r = await generateForAgreement(companyId, uid, email, role, agreement, { asOf: asOfDate });
    invoices.push(...r.invoices);
    results.push({ agreementId: agreement.id, created: r.invoices.length });
  }
  await logAudit({ companyId, uid, email, action: "agreement.generate", payload: { asOf: asOfDate, created: invoices.length, agreementId: agreementId || "" } });
  return { asOf: asOfDate, invoices, results };
}

function billedHoursFor(period, invoice, overageInvoice) {
  const feeIssued = Boolean(invoice && !invoice.deletedAt && !invoice.voided);
  const overageIssued = Boolean(overageInvoice && !overageInvoice.deletedAt && !overageInvoice.voided);
  const covered = feeIssued ? Math.min(period.hoursUsed || 0, (period.hoursAllowed || 0) + (period.hoursRolledIn || 0)) : 0;
  const billedOverage = overageIssued ? period.hoursOverage || 0 : 0;
  return roundHours(covered + billedOverage);
}

async function withLivePeriod(companyId, agreement, period) {
  const used = period.status === "closed" ? period.hoursUsed : await liveHoursUsed(companyId, period);
  const math = closeHours({
    hoursAllowed: period.hoursAllowed,
    hoursRolledIn: period.hoursRolledIn,
    hoursUsed: used,
    rolloverPolicy: agreement.rolloverPolicy,
  });
  const invoice = await loadInvoiceIfPresent(companyId, period.recurringInvoiceId);
  const overageInvoice = (await loadInvoiceIfPresent(companyId, period.overageInvoiceId)) || (invoice && period.overageInvoiceId === invoice.id ? invoice : null);
  return {
    ...period,
    ...math,
    status: period.status || "open",
    label: periodLabel(period.startsOn, period.endsOn),
    hoursBilled: billedHoursFor({ ...period, ...math }, invoice, overageInvoice),
    invoice: invoice ? { id: invoice.id, invoiceNumber: invoice.invoiceNumber, draft: invoice.draft, voided: invoice.voided, total: invoice.total } : null,
    overageInvoice: overageInvoice && overageInvoice.id !== invoice?.id
      ? { id: overageInvoice.id, invoiceNumber: overageInvoice.invoiceNumber, draft: overageInvoice.draft, voided: overageInvoice.voided, total: overageInvoice.total }
      : null,
  };
}

async function hoursReport(companyId, { agreementId, customerId, asOf } = {}) {
  const asOfDate = toIsoDate(asOf) || todayIsoInZone();
  let agreements = await listAgreements(companyId, { customerId });
  if (agreementId) agreements = agreements.filter((a) => a.id === agreementId);
  const timeEntries = require("./timeEntries");
  const reports = [];
  for (const agreement of agreements) {
    if (agreement.status !== "draft") await ensurePeriods(companyId, agreement, asOfDate);
    const periods = await listPeriods(companyId, agreement.id);
    const periodRows = [];
    for (const period of periods) {
      periodRows.push(await withLivePeriod(companyId, agreement, period));
    }
    const adHoc = await timeEntries.listTimeEntries(companyId, { customerId: agreement.customerId });
    const adHocOnly = adHoc.filter((e) => e.billable && !e.agreementId);
    const adHocHours = {
      used: hoursFromEntries(adHocOnly),
      billed: hoursFromEntries(adHocOnly.filter((e) => e.billed)),
      unbilled: hoursFromEntries(adHocOnly.filter((e) => !e.invoiceId)),
    };
    const totals = periodRows.reduce(
      (s, p) => ({
        hoursAllowed: roundHours(s.hoursAllowed + p.hoursAllowed),
        hoursRolledIn: roundHours(s.hoursRolledIn + p.hoursRolledIn),
        hoursUsed: roundHours(s.hoursUsed + p.hoursUsed),
        hoursRemaining: roundHours(s.hoursRemaining + p.hoursRemaining),
        hoursExpired: roundHours(s.hoursExpired + p.hoursExpired),
        hoursOverage: roundHours(s.hoursOverage + p.hoursOverage),
        hoursBilled: roundHours(s.hoursBilled + p.hoursBilled),
      }),
      { hoursAllowed: 0, hoursRolledIn: 0, hoursUsed: 0, hoursRemaining: 0, hoursExpired: 0, hoursOverage: 0, hoursBilled: 0 }
    );
    reports.push({
      agreement: {
        id: agreement.id,
        name: agreement.name,
        status: agreement.status,
        customerId: agreement.customerId,
        customerName: agreement.customerName,
        period: agreement.period,
        hours: agreement.hours,
        fee: agreement.fee,
        currency: agreement.currency,
        startDate: agreement.startDate,
        endDate: agreement.endDate,
        rolloverPolicy: agreement.rolloverPolicy,
        autoPublish: agreement.autoPublish,
      },
      periods: periodRows,
      totals,
      adHocHours,
    });
  }
  return { asOf: asOfDate, reports };
}

async function listAgreementPeriods(companyId, agreementId, { asOf } = {}) {
  const agreement = await requireAgreement(companyId, agreementId);
  if (agreement.status !== "draft") await ensurePeriods(companyId, agreement, asOf || todayIsoInZone());
  const periods = await listPeriods(companyId, agreementId);
  const rows = [];
  for (const period of periods) rows.push(await withLivePeriod(companyId, agreement, period));
  return { agreement, periods: rows };
}

/**
 * Resolve and validate an agreement + period for a time entry.
 * Agreement-linked time counts toward the period allowance and cannot be
 * invoiced as ad hoc billable hours.
 */
async function resolveTimeLink(companyId, { agreementId, periodId, date, customerId } = {}) {
  const id = String(agreementId || "").trim();
  if (!id) return { agreementId: "", periodId: "", customerId: customerId || "", agreementName: "" };
  const agreement = await requireAgreement(companyId, id);
  if (agreement.status === "draft") throw httpError(409, "Activate the agreement before logging time against it");
  const iso = requireIso(date || todayIsoInZone());
  if (iso < agreement.startDate || (agreement.endDate && iso > agreement.endDate)) {
    throw httpError(400, "That date is outside the agreement");
  }
  if (customerId && customerId !== agreement.customerId) {
    throw httpError(400, "Time on an agreement must use the agreement's customer");
  }
  const window = periodCoveringDate(agreement, iso);
  if (!window) throw httpError(400, "That date is not in an agreement period");
  await ensurePeriods(companyId, agreement, iso);
  const pid = periodId || periodDocumentId(agreement.id, window.fullStartsOn);
  const period = await getPeriod(companyId, pid);
  if (!period) throw httpError(400, "Agreement period not found");
  if (period.status === "closed") {
    throw httpError(409, "This period is closed. Time has to be logged before the next recurring invoice is generated.");
  }
  return {
    agreementId: agreement.id,
    periodId: period.id,
    customerId: agreement.customerId,
    agreementName: agreement.name,
    agreement,
    period,
  };
}

async function listAllCompanyIds() {
  const db = getDb();
  if (!db) return [];
  const snap = await db.collection("companies").get();
  return snap.docs.filter((d) => !d.data()?.deletedAt).map((d) => d.id);
}

async function runRecurringJob({ asOf } = {}) {
  const asOfDate = toIsoDate(asOf) || todayIsoInZone();
  const ids = await listAllCompanyIds();
  const results = [];
  for (const companyId of ids) {
    try {
      const r = await generateDueInvoices(companyId, ...SYSTEM_ACTOR, { asOf: asOfDate });
      results.push({ companyId, created: r.invoices.length });
    } catch (err) {
      console.error("recurring invoices failed", companyId, err);
      results.push({ companyId, error: err.message || String(err) });
    }
  }
  return { asOf: asOfDate, results };
}

function startRecurringInvoiceScheduler({ intervalMs = 60 * 60 * 1000, startupDelayMs = 30_000 } = {}) {
  if (process.env.NODE_ENV === "test" || process.env.DISABLE_RECURRING_JOB === "1") return () => {};
  const tick = () => runRecurringJob().catch((err) => console.error("recurring invoice job", err));
  const interval = setInterval(tick, intervalMs);
  const startup = setTimeout(tick, startupDelayMs);
  if (typeof interval.unref === "function") interval.unref();
  if (typeof startup.unref === "function") startup.unref();
  return () => {
    clearInterval(interval);
    clearTimeout(startup);
  };
}

module.exports = {
  listAgreements,
  getAgreement,
  requireAgreement,
  createAgreement,
  updateAgreement,
  deleteAgreement,
  setAgreementStatus,
  listPeriods,
  listAgreementPeriods,
  generateDueInvoices,
  generateForAgreement,
  hoursReport,
  resolveTimeLink,
  runRecurringJob,
  startRecurringInvoiceScheduler,
  ensurePeriods,
  effectiveOverageRate,
  STATUSES,
};
