const { roundMoney } = require("./money");
const { toIsoDate, todayIso, daysBetween } = require("./dates");

function parseHumanDate(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const raw = String(value).trim();
  if (/on receipt/i.test(raw)) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Derived payment status. Stored status is a snapshot; always recompute on read
 * because "overdue" depends on today's date.
 */
function invoiceStatus({ total, paidAmount, creditedAmount, dueDate, draft, voided }, now = new Date()) {
  const totalAmt = roundMoney(total);
  const paid = roundMoney(paidAmount);
  const credited = roundMoney(creditedAmount || 0);
  const rawOutstanding = roundMoney(totalAmt - paid - credited);
  const credit = rawOutstanding < 0 ? roundMoney(-rawOutstanding) : 0;
  const due = toIsoDate(dueDate);
  const today = todayIso(now);
  const overdueBase = rawOutstanding > 0 && Boolean(due) && due < today;

  if (voided) {
    return { total: totalAmt, paidAmount: paid, outstanding: 0, credit: 0, status: "void", overdue: false, daysOverdue: 0 };
  }
  if (draft) {
    return { total: totalAmt, paidAmount: paid, outstanding: 0, credit: 0, status: "draft", overdue: false, daysOverdue: 0 };
  }

  let status;
  if (rawOutstanding <= 0) status = "paid";
  else if (overdueBase) status = "overdue";
  else if (paid > 0 || credited > 0) status = "partially_paid";
  else status = "unpaid";

  return {
    total: totalAmt,
    paidAmount: paid,
    outstanding: Math.max(0, rawOutstanding),
    credit,
    status,
    overdue: overdueBase,
    daysOverdue: overdueBase ? daysBetween(due, today) : 0,
  };
}

const AGING_BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"];

/** Bucket by days past due as of `now`. No/blank due date counts as current. */
function agingBucket(dueDate, now = new Date()) {
  const due = toIsoDate(dueDate);
  if (!due) return "current";
  const days = daysBetween(due, todayIso(now));
  if (days <= 0) return "current";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

module.exports = { parseHumanDate, invoiceStatus, agingBucket, AGING_BUCKETS };
