// Realised FX helpers, generalised to the company base currency (1.6.0).
// Readers fall back to the old zar* field names so leftover records still work.
const { roundMoney } = require("../money");

const round6 = (n) => Math.round(n * 1e6) / 1e6;

function pick(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] != null && obj[key] !== "") return obj[key];
  }
  return null;
}

function baseReceivedOf(p) {
  const v = pick(p, "baseReceived", "zarReceived");
  return v == null ? null : v;
}

function baseAtInvoiceRateOf(p) {
  const v = pick(p, "baseAtInvoiceRate", "zarAtInvoiceRate");
  return v == null ? null : v;
}

function forexGainBaseOf(p) {
  const v = pick(p, "forexGainBase", "forexGainZar");
  return v == null ? null : v;
}

function forexFlagOf(p) {
  const flag = p?.forexFlag || "";
  return flag === "non_zar_account" ? "non_base_account" : flag;
}

/**
 * Realised forex when a foreign-currency invoice is paid into a base-currency
 * account. `invoiceRate` is base per 1 unit of the invoice currency.
 */
function computeForex({
  invoiceCurrency,
  amount,
  receivedCurrency,
  receivedAmount,
  invoiceRate,
  baseCurrency = "ZAR",
} = {}) {
  const base = baseCurrency || "ZAR";
  const out = {
    receivedAmount: roundMoney(receivedAmount),
    receivedCurrency,
    baseReceived: receivedCurrency === base ? roundMoney(receivedAmount) : null,
    receivedRate: null,
    invoiceRate: null,
    baseAtInvoiceRate: null,
    forexGainBase: null,
    forexFlag: "",
  };
  if (invoiceCurrency === receivedCurrency) return out;
  if (receivedCurrency !== base) return { ...out, forexFlag: "non_base_account" };
  const next = { ...out, receivedRate: amount > 0 ? round6(receivedAmount / amount) : null };
  if (!(invoiceRate > 0)) return { ...next, forexFlag: "missing_invoice_rate" };
  const baseAtInvoiceRate = roundMoney(amount * invoiceRate);
  return {
    ...next,
    invoiceRate: round6(invoiceRate),
    baseAtInvoiceRate,
    forexGainBase: roundMoney(roundMoney(receivedAmount) - baseAtInvoiceRate),
  };
}

module.exports = {
  computeForex,
  baseReceivedOf,
  baseAtInvoiceRateOf,
  forexGainBaseOf,
  forexFlagOf,
  round6,
};
