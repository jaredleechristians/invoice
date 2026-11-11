const SUPPORTED_CURRENCIES = ["ZAR", "USD", "EUR", "GBP"];

function parseAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const cleaned = String(value ?? "").replace(/[^\d.-]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function roundMoney(value) {
  return Math.round((parseAmount(value) + Number.EPSILON) * 100) / 100;
}

function lineAmount(item) {
  return roundMoney(parseAmount(item?.qty ?? 1) * parseAmount(item?.unitPrice ?? 0));
}

function invoiceTotal(items) {
  return roundMoney((items || []).reduce((sum, item) => sum + lineAmount(item), 0));
}

/**
 * Subtotal / VAT / total for a document. VAT only applies when the document
 * carries a vatRate > 0 (company is VAT registered) and the line is taxable.
 */
function documentTotals(items, { vatRate = 0 } = {}) {
  const rate = Math.max(0, parseAmount(vatRate));
  let subtotal = 0;
  let taxable = 0;
  for (const item of items || []) {
    const amount = lineAmount(item);
    subtotal += amount;
    if (item?.taxable !== false) taxable += amount;
  }
  subtotal = roundMoney(subtotal);
  const taxTotal = rate > 0 ? roundMoney((taxable * rate) / 100) : 0;
  return { subtotal, taxTotal, total: roundMoney(subtotal + taxTotal) };
}

function normalizeCurrency(value, fallback = "ZAR") {
  const code = String(value || "").trim().toUpperCase();
  if (SUPPORTED_CURRENCIES.includes(code)) return code;
  return fallback;
}

/** Add amount into a { [currency]: number } map. */
function addTo(map, currency, amount) {
  const key = currency || "ZAR";
  map[key] = roundMoney((map[key] || 0) + parseAmount(amount));
  return map;
}

function formatMoney(amount, currency = "ZAR") {
  try {
    return new Intl.NumberFormat("en-ZA", {
      style: "currency",
      currency: currency || "ZAR",
      minimumFractionDigits: 2,
    }).format(roundMoney(amount));
  } catch {
    return `${currency} ${roundMoney(amount).toFixed(2)}`;
  }
}

module.exports = {
  SUPPORTED_CURRENCIES,
  parseAmount,
  roundMoney,
  lineAmount,
  invoiceTotal,
  documentTotals,
  normalizeCurrency,
  addTo,
  formatMoney,
};
