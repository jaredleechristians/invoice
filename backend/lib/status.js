const { roundMoney } = require("./money");

function parseHumanDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value).trim();
  if (/on receipt/i.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function invoiceStatus({ total, paidAmount, dueDate }, now = new Date()) {
  const totalAmt = roundMoney(total);
  const paid = roundMoney(paidAmount);
  const outstanding = roundMoney(totalAmt - paid);
  const credit = outstanding < 0 ? roundMoney(-outstanding) : 0;
  const due = parseHumanDate(dueDate);
  const overdue =
    outstanding > 0 && due && startOfDay(due) < startOfDay(now);

  let status = "unpaid";
  if (paid <= 0 && outstanding > 0) status = overdue ? "overdue" : "unpaid";
  else if (outstanding > 0) status = overdue ? "overdue" : "partially_paid";
  else status = "paid";

  return {
    total: totalAmt,
    paidAmount: paid,
    outstanding: Math.max(0, outstanding),
    credit,
    status,
    overdue: Boolean(overdue),
  };
}

function agingBucket(dueDate, now = new Date()) {
  const due = parseHumanDate(dueDate);
  if (!due) return "current";
  const days = Math.floor((startOfDay(now) - startOfDay(due)) / 86400000);
  if (days <= 0) return "current";
  if (days <= 30) return "30";
  if (days <= 60) return "60";
  return "90+";
}

module.exports = { parseHumanDate, invoiceStatus, agingBucket };
