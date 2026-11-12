// Pure posting rules for Phase 1 slice 1.5.0. See docs/design/phase-1-ledger.md §5.4.
// No Firestore. Each function returns balanced journal lines in base-currency
// minor units, plus the original currency, amount and rate.
const { httpError } = require("../errors");
const { roundMoney, lineAmount } = require("../money");

function toCents(amount) {
  return Math.round(roundMoney(amount) * 100);
}

/** Convert a 2dp document amount into base-currency minor units. */
function toBaseCents(amount, rate) {
  return toCents(roundMoney(roundMoney(amount) * Number(rate)));
}

function documentRate(doc, baseCurrency) {
  const currency = doc.currency || baseCurrency || "ZAR";
  if (currency === (baseCurrency || "ZAR")) return 1;
  const rate = Number(doc.exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw httpError(400, "An exchange rate is required for a foreign-currency document");
  }
  return rate;
}

function line({ accountId, debit = 0, credit = 0, currency, foreignAmount, rate, customerId, description }) {
  return {
    accountId,
    debit,
    credit,
    currency,
    foreignAmount,
    rate,
    customerId: customerId || "",
    description: description || "",
  };
}

function assertBalanced(lines) {
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  if (debit !== credit) throw httpError(400, `Journal does not balance (${debit} vs ${credit} cents)`);
  return lines;
}

/** Residual rounding cents go to the largest income (credit) line so the entry balances. */
function applyResidual(lines) {
  const debit = lines.reduce((s, l) => s + l.debit, 0);
  const credit = lines.reduce((s, l) => s + l.credit, 0);
  const residual = debit - credit;
  if (!residual) return assertBalanced(lines);
  const income = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => l.credit > 0)
    .sort((a, b) => b.l.credit - a.l.credit || a.i - b.i)[0];
  const target = income || lines.map((l, i) => ({ l, i })).sort((a, b) => b.l.debit + b.l.credit - (a.l.debit + a.l.credit) || a.i - b.i)[0];
  if (!target) return assertBalanced(lines);
  if (residual > 0) target.l.credit += residual;
  else if (target.l.credit >= -residual) target.l.credit += residual;
  else target.l.debit += -residual;
  return assertBalanced(lines);
}

/**
 * Invoice published: Dr 1100 Debtors (total), Cr income per account group (subtotal),
 * Cr 2100 VAT (taxTotal). Residual cents go to the largest income line.
 */
function invoiceLines(invoice, { systemAccounts, baseCurrency }) {
  const base = baseCurrency || "ZAR";
  const currency = invoice.currency || base;
  const rate = documentRate(invoice, base);
  const items = invoice.items || [];
  const groups = new Map();
  for (const item of items) {
    const amount = lineAmount(item);
    if (!amount) continue;
    const accountId = item.accountId || systemAccounts.default_income;
    groups.set(accountId, roundMoney((groups.get(accountId) || 0) + amount));
  }
  const customerId = invoice.customerId || "";
  const lines = [];
  const total = roundMoney(invoice.total ?? 0);
  if (total) {
    lines.push(
      line({
        accountId: systemAccounts.debtors,
        debit: toBaseCents(total, rate),
        currency,
        foreignAmount: toCents(total),
        rate,
        customerId,
        description: invoice.invoiceNumber || "Invoice",
      })
    );
  }
  for (const [accountId, amount] of groups) {
    lines.push(
      line({
        accountId,
        credit: toBaseCents(amount, rate),
        currency,
        foreignAmount: -toCents(amount),
        rate,
        customerId,
        description: invoice.invoiceNumber || "Invoice",
      })
    );
  }
  const taxTotal = roundMoney(invoice.taxTotal ?? 0);
  if (taxTotal) {
    lines.push(
      line({
        accountId: systemAccounts.vat,
        credit: toBaseCents(taxTotal, rate),
        currency,
        foreignAmount: -toCents(taxTotal),
        rate,
        customerId,
        description: `VAT ${invoice.vatRate || ""}%`.trim(),
      })
    );
  }
  return applyResidual(lines.filter((l) => l.debit > 0 || l.credit > 0));
}

/**
 * Payment recorded (not via bank in 1.5.0): Dr 1150 Undeposited funds, Cr 1100
 * Debtors, both at the invoice rate. FX against the bank is 1.6.0.
 */
function paymentLines(payment, invoice, { systemAccounts, baseCurrency }) {
  const base = baseCurrency || "ZAR";
  const currency = payment.currency || invoice.currency || base;
  const rate = documentRate({ currency, exchangeRate: invoice.exchangeRate }, base);
  const amount = roundMoney(payment.amount);
  const cents = toBaseCents(amount, rate);
  const foreign = toCents(amount);
  const customerId = payment.customerId || invoice.customerId || "";
  const description = payment.invoiceNumber || invoice.invoiceNumber || "Payment";
  return assertBalanced([
    line({
      accountId: systemAccounts.undeposited_funds,
      debit: cents,
      currency,
      foreignAmount: foreign,
      rate,
      customerId,
      description,
    }),
    line({
      accountId: systemAccounts.debtors,
      credit: cents,
      currency,
      foreignAmount: -foreign,
      rate,
      customerId,
      description,
    }),
  ]);
}

/**
 * Expense saved: Dr the category expense account, Cr 2050 Expenses awaiting
 * bank match (until 1.6.0 bank matching). Gross, no VAT split.
 */
function expenseLines(expense, { systemAccounts, baseCurrency }) {
  const base = baseCurrency || "ZAR";
  const currency = expense.currency || base;
  const rate = documentRate(expense, base);
  const amount = roundMoney(expense.amount);
  const cents = toBaseCents(amount, rate);
  const foreign = toCents(amount);
  const accountId = expense.accountId || systemAccounts.default_expense;
  const description = expense.vendor || expense.categoryName || "Expense";
  return assertBalanced([
    line({
      accountId,
      debit: cents,
      currency,
      foreignAmount: foreign,
      rate,
      description,
    }),
    line({
      accountId: systemAccounts.expense_clearing,
      credit: cents,
      currency,
      foreignAmount: -foreign,
      rate,
      description,
    }),
  ]);
}

function swapLines(lines) {
  return (lines || []).map((l) => ({
    ...l,
    debit: l.credit,
    credit: l.debit,
    foreignAmount: -Number(l.foreignAmount || 0),
  }));
}

module.exports = {
  toCents,
  toBaseCents,
  documentRate,
  invoiceLines,
  paymentLines,
  expenseLines,
  swapLines,
  applyResidual,
  assertBalanced,
};
