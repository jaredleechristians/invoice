const crypto = require("crypto");

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}

function formatInvoiceNumber(prefix, n) {
  const cleanPrefix = String(prefix || "INV-");
  const num = Number(n);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error("Invoice number must be a positive integer");
  }
  return `${cleanPrefix}${String(num).padStart(4, "0")}`;
}

function parseSequenceNumber(prefix, invoiceNumber) {
  const p = String(prefix || "INV-");
  const value = String(invoiceNumber || "");
  if (!value.startsWith(p)) return null;
  const rest = value.slice(p.length);
  if (!/^\d+$/.test(rest)) return null;
  return parseInt(rest, 10);
}

module.exports = { randomId, formatInvoiceNumber, parseSequenceNumber };
