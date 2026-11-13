// Shared helpers for invoices and quotes (line items, customer, issuer, totals).
const { httpError } = require("./errors");
const { parseAmount, roundMoney, documentTotals, normalizeCurrency } = require("./money");
const { getCustomer } = require("./customers");

const MAX_LINES = 200;

function normalizeLines(items) {
  if (items == null) return [];
  if (!Array.isArray(items)) throw httpError(400, "items must be an array");
  if (items.length > MAX_LINES) throw httpError(400, `At most ${MAX_LINES} line items`);
  return items.map((item) => {
    const qty = parseAmount(item?.qty ?? 1);
    const unitPrice = roundMoney(item?.unitPrice ?? 0);
    return {
      productId: String(item?.productId || ""),
      accountId: String(item?.accountId || ""),
      description: String(item?.description ?? "").slice(0, 500),
      note: String(item?.note ?? "").slice(0, 1000),
      qty,
      unitPrice,
      taxable: item?.taxable !== false,
      timeEntryId: String(item?.timeEntryId || "").trim(),
    };
  });
}

/** Company VAT rate to apply on new documents (0 when not VAT registered). */
function companyVatRate(company) {
  return company?.vatRegistered ? Math.max(0, parseAmount(company.vatRate)) : 0;
}

function totalsFor(items, vatRate) {
  return documentTotals(items, { vatRate });
}

async function customerFields(companyId, body, existing = {}) {
  const customerId = body.customerId !== undefined ? String(body.customerId || "") : existing.customerId || "";
  if (customerId) {
    const customer = await getCustomer(companyId, customerId);
    if (!customer) throw httpError(400, "Customer not found in this company");
    const snapshot = {
      id: customer.id,
      name: customer.name,
      email: customer.email || "",
      phone: customer.phone || "",
      address: customer.address || "",
      taxNumber: customer.taxNumber || "",
    };
    const billTo =
      body.billTo !== undefined
        ? String(body.billTo || "")
        : [customer.name, customer.address, customer.email, customer.taxNumber ? `Tax no. ${customer.taxNumber}` : ""]
            .filter(Boolean)
            .join("\n");
    return { customerId, customerName: customer.name, customerSnapshot: snapshot, billTo, customer };
  }
  const customerName =
    body.customerName !== undefined ? String(body.customerName || "") : existing.customerName || "";
  return {
    customerId: "",
    customerName,
    customerSnapshot: existing.customerSnapshot || null,
    billTo: body.billTo !== undefined ? String(body.billTo || "") : existing.billTo || customerName,
    customer: null,
  };
}

function issuerDetailsText(company) {
  return [
    company.legalName && company.legalName !== company.name ? company.legalName : "",
    company.address,
    [company.phone, company.email].filter(Boolean).join(" · "),
    company.website,
    company.registrationNumber ? `Reg. No. ${company.registrationNumber}` : "",
    company.vatRegistered && company.vatNumber ? `VAT No. ${company.vatNumber}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Bank accounts relevant to a currency: matching currency first, then untagged. */
function bankAccountsFor(company, currency) {
  const list = Array.isArray(company?.bankAccounts) ? company.bankAccounts : [];
  const matching = list.filter((a) => a.currency === currency);
  const untagged = list.filter((a) => !a.currency);
  const chosen = [...matching, ...untagged];
  return chosen.length ? chosen : list;
}

/** Frozen copy of the issuing company's details stored on finalize. */
function issuerSnapshot(company, currency) {
  return {
    name: company.name || "",
    details: issuerDetailsText(company),
    vatRegistered: Boolean(company.vatRegistered),
    vatNumber: company.vatNumber || "",
    bankAccounts: bankAccountsFor(company, currency).map((a) => ({
      label: a.label || "",
      currency: a.currency || "",
      details: a.details || "",
    })),
    legal: company.legal || "",
    footer: company.footer || "",
  };
}

function pickCurrency(body, existing, company, customer) {
  if (body.currency !== undefined) {
    const c = normalizeCurrency(body.currency, "");
    if (!c) throw httpError(400, "Unsupported currency");
    return c;
  }
  return existing.currency || customer?.currency || company?.defaultCurrency || "ZAR";
}


/** Stamp each line with the product's income account (or the services default). */
async function stampLineAccounts(companyId, items) {
  const { defaultIncomeAccountId } = require("./ledger/accounts");
  const lines = normalizeLines(items);
  const ids = [...new Set(lines.map((l) => l.productId).filter(Boolean))];
  const products = {};
  if (ids.length) {
    const { getDb } = require("./firebase");
    const { companyRef } = require("./refs");
    const col = companyRef(getDb(), companyId).collection("products");
    await Promise.all(
      ids.map(async (id) => {
        const snap = await col.doc(id).get();
        if (snap.exists && !snap.data().deletedAt) products[id] = { id: snap.id, ...snap.data() };
      })
    );
  }
  return lines.map((line) => {
    const product = line.productId ? products[line.productId] : null;
    const accountId = line.accountId || product?.incomeAccountId || defaultIncomeAccountId(product?.kind);
    return { ...line, accountId };
  });
}

/** Optional positive rate (base per 1 unit). Empty becomes null. */
function cleanExchangeRate(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw httpError(400, "Exchange rate must be a positive number");
  return Math.round(n * 1e6) / 1e6;
}

module.exports = {
  normalizeLines,
  stampLineAccounts,
  cleanExchangeRate,
  companyVatRate,
  totalsFor,
  customerFields,
  issuerDetailsText,
  issuerSnapshot,
  bankAccountsFor,
  pickCurrency,
};
