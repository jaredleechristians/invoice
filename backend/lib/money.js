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

module.exports = { parseAmount, roundMoney, lineAmount, invoiceTotal };
