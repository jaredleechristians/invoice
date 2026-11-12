// Pure posting rules for Phase 1. See docs/design/phase-1-ledger.md §5.4.
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

function line({ accountId, debit = 0, credit = 0, currency, foreignAmount, rate, customerId, bankAccountId, description }) {
  return {
    accountId,
    debit,
    credit,
    currency,
    foreignAmount,
    rate,
    customerId: customerId || "",
    bankAccountId: bankAccountId || "",
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
 * Payment recorded: Dr 1150 Undeposited funds, Cr 1100 Debtors, both at the
 * invoice rate. The bank receipt that clears 1150 is paymentBankLines.
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
 * bank match. Gross, no VAT split. The bank payment that clears 2050 is expenseBankLines.
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


/**
 * Bank receipt that clears undeposited funds.
 * Same currency as the invoice: Dr Bank, Cr 1150 at the invoice rate.
 * Foreign invoice into a base-currency account: Dr Bank baseReceived, Cr 1150
 * baseAtInvoiceRate, difference to 4900 (Cr gain / Dr loss).
 * Foreign invoice into a same-currency foreign account: Dr Bank at the invoice
 * rate, Cr 1150, no FX until the money is converted.
 */
function paymentBankLines(payment, invoice, { systemAccounts, baseCurrency, bankLedgerAccountId, bankAccountId, bankCurrency }) {
  if (!bankLedgerAccountId) throw httpError(400, "Bank ledger account is missing");
  const base = baseCurrency || "ZAR";
  const currency = payment.currency || invoice.currency || base;
  const invoiceRate = documentRate({ currency, exchangeRate: invoice.exchangeRate ?? payment.invoiceRate }, base);
  const amount = roundMoney(payment.amount);
  const receivedCurrency = payment.receivedCurrency || bankCurrency || currency;
  const receivedAmount = payment.receivedAmount != null
    ? roundMoney(payment.receivedAmount)
    : receivedCurrency === currency
      ? amount
      : null;
  const description = payment.invoiceNumber || invoice.invoiceNumber || "Bank receipt";
  const undeposited = systemAccounts.undeposited_funds;

  if (currency === receivedCurrency) {
    const cents = toBaseCents(amount, invoiceRate);
    const foreign = toCents(amount);
    return assertBalanced([
      line({
        accountId: bankLedgerAccountId,
        debit: cents,
        currency,
        foreignAmount: foreign,
        rate: invoiceRate,
        bankAccountId,
        description,
      }),
      line({
        accountId: undeposited,
        credit: cents,
        currency,
        foreignAmount: -foreign,
        rate: invoiceRate,
        description,
      }),
    ]);
  }

  if (receivedCurrency !== base || !(receivedAmount > 0)) {
    throw httpError(400, "A foreign-currency invoice can only be matched to a same-currency or base-currency bank account");
  }
  const bankCents = toCents(receivedAmount);
  const clearCents = toBaseCents(amount, invoiceRate);
  const lines = [
    line({
      accountId: bankLedgerAccountId,
      debit: bankCents,
      currency: base,
      foreignAmount: bankCents,
      rate: 1,
      bankAccountId,
      description,
    }),
    line({
      accountId: undeposited,
      credit: clearCents,
      currency,
      foreignAmount: -toCents(amount),
      rate: invoiceRate,
      description,
    }),
  ];
  const gain = bankCents - clearCents;
  if (gain > 0) {
    lines.push(line({
      accountId: systemAccounts.fx,
      credit: gain,
      currency: base,
      foreignAmount: -gain,
      rate: 1,
      description: "Realised FX gain",
    }));
  } else if (gain < 0) {
    lines.push(line({
      accountId: systemAccounts.fx,
      debit: -gain,
      currency: base,
      foreignAmount: -gain,
      rate: 1,
      description: "Realised FX loss",
    }));
  }
  return assertBalanced(lines);
}

/**
 * Bank payment that clears expenses awaiting match: Dr 2050, Cr Bank.
 * Foreign expense paid from a base-currency account: 2050 clears at the
 * expense rate, the bank is the cash actually paid, and the difference goes
 * to 4900.
 */
function expenseBankLines(expense, bankTx, { systemAccounts, baseCurrency, bankLedgerAccountId, bankAccountId, bankCurrency }) {
  if (!bankLedgerAccountId) throw httpError(400, "Bank ledger account is missing");
  const base = baseCurrency || "ZAR";
  const currency = expense.currency || base;
  const rate = documentRate(expense, base);
  const amount = roundMoney(expense.amount);
  const clearCents = toBaseCents(amount, rate);
  const bankCur = bankCurrency || bankTx.currency || base;
  const bankAmount = roundMoney(Math.abs(bankTx.amount));
  const description = expense.vendor || expense.categoryName || "Expense";

  let bankCents;
  let bankRate;
  if (bankCur === base) {
    bankCents = toCents(bankAmount);
    bankRate = 1;
  } else if (bankCur === currency) {
    bankCents = toBaseCents(bankAmount, rate);
    bankRate = rate;
  } else {
    throw httpError(400, "An expense can only be matched to a same-currency or base-currency bank account");
  }

  const lines = [
    line({
      accountId: systemAccounts.expense_clearing,
      debit: clearCents,
      currency,
      foreignAmount: toCents(amount),
      rate,
      description,
    }),
    line({
      accountId: bankLedgerAccountId,
      credit: bankCents,
      currency: bankCur,
      foreignAmount: -toCents(bankAmount),
      rate: bankRate,
      bankAccountId,
      description,
    }),
  ];
  const diff = bankCents - clearCents;
  if (diff > 0) {
    lines.push(line({
      accountId: systemAccounts.fx,
      debit: diff,
      currency: base,
      foreignAmount: diff,
      rate: 1,
      description: "Realised FX loss",
    }));
  } else if (diff < 0) {
    lines.push(line({
      accountId: systemAccounts.fx,
      credit: -diff,
      currency: base,
      foreignAmount: diff,
      rate: 1,
      description: "Realised FX gain",
    }));
  }
  return assertBalanced(lines);
}

/**
 * Paired transfer: Dr receiving bank, Cr sending bank.
 * Cross-currency with a base receiving account: credit the foreign account at
 * `sendRate` (average base cost), debit the base amount received, difference
 * to 4900. Two non-base accounts are both valued at the sending account's
 * average cost (no FX).
 */
function transferPairLines({
  sendLedgerAccountId,
  sendBankAccountId,
  sendCurrency,
  sendAmount,
  sendRate,
  receiveLedgerAccountId,
  receiveBankAccountId,
  receiveCurrency,
  receiveAmount,
  systemAccounts,
  baseCurrency,
  description = "Transfer",
}) {
  const base = baseCurrency || "ZAR";
  const sent = roundMoney(Math.abs(sendAmount));
  const received = roundMoney(Math.abs(receiveAmount));
  if (!(sent > 0 && received > 0)) throw httpError(400, "Both sides of a transfer need an amount");
  const sendIsBase = sendCurrency === base;
  const receiveIsBase = receiveCurrency === base;
  const rate = sendIsBase ? 1 : Number(sendRate);
  if (!sendIsBase && (!(rate > 0))) {
    throw httpError(400, "No average cost is available for this account yet. Set an opening balance with a rate first.");
  }
  const sendCents = sendIsBase ? toCents(sent) : toBaseCents(sent, rate);
  let receiveCents;
  let receiveRate;
  if (receiveIsBase) {
    receiveCents = toCents(received);
    receiveRate = 1;
  } else if (sendCurrency === receiveCurrency || !receiveIsBase) {
    // Same currency, or both non-base: value the receiving side at the sending cost.
    receiveCents = sendCents;
    receiveRate = received ? sendCents / toCents(received) : rate;
  }
  const lines = [
    line({
      accountId: receiveLedgerAccountId,
      debit: receiveCents,
      currency: receiveCurrency,
      foreignAmount: toCents(received),
      rate: receiveRate,
      bankAccountId: receiveBankAccountId,
      description,
    }),
    line({
      accountId: sendLedgerAccountId,
      credit: sendCents,
      currency: sendCurrency,
      foreignAmount: -toCents(sent),
      rate,
      bankAccountId: sendBankAccountId,
      description,
    }),
  ];
  const gain = receiveCents - sendCents;
  if (gain > 0) {
    lines.push(line({
      accountId: systemAccounts.fx,
      credit: gain,
      currency: base,
      foreignAmount: -gain,
      rate: 1,
      description: "Realised FX gain",
    }));
  } else if (gain < 0) {
    lines.push(line({
      accountId: systemAccounts.fx,
      debit: -gain,
      currency: base,
      foreignAmount: -gain,
      rate: 1,
      description: "Realised FX loss",
    }));
  }
  return assertBalanced(lines);
}

/**
 * Unpaired transfer: the bank line posts against 1160 Transfers in transit.
 * Money in: Dr Bank, Cr 1160. Money out: Dr 1160, Cr Bank.
 */
function transferInTransitLines({
  bankLedgerAccountId,
  bankAccountId,
  currency,
  amount,
  rate,
  systemAccounts,
  baseCurrency,
  description = "Transfer",
}) {
  if (!bankLedgerAccountId) throw httpError(400, "Bank ledger account is missing");
  const base = baseCurrency || "ZAR";
  const signed = roundMoney(amount);
  const abs = Math.abs(signed);
  if (!(abs > 0)) throw httpError(400, "Transfer amount is required");
  const isBase = (currency || base) === base;
  const usedRate = isBase ? 1 : Number(rate);
  if (!isBase && (!(usedRate > 0))) {
    throw httpError(400, "Pair the other side or set an opening balance so the transfer can be valued");
  }
  const cents = isBase ? toCents(abs) : toBaseCents(abs, usedRate);
  const foreign = toCents(abs);
  const inbound = signed > 0;
  return assertBalanced([
    line({
      accountId: inbound ? bankLedgerAccountId : systemAccounts.transfers_in_transit,
      debit: cents,
      currency,
      foreignAmount: inbound ? foreign : foreign,
      rate: usedRate,
      bankAccountId: inbound ? bankAccountId : "",
      description,
    }),
    line({
      accountId: inbound ? systemAccounts.transfers_in_transit : bankLedgerAccountId,
      credit: cents,
      currency,
      foreignAmount: -foreign,
      rate: usedRate,
      bankAccountId: inbound ? "" : bankAccountId,
      description,
    }),
  ]);
}

/** Bank account opening: Dr Bank, Cr 3200 (or the reverse if the opening is overdrawn). */
function bankOpeningLines({
  bankLedgerAccountId,
  bankAccountId,
  currency,
  openingBalance,
  rate,
  systemAccounts,
  baseCurrency,
  description = "Opening balance",
}) {
  if (!bankLedgerAccountId) throw httpError(400, "Bank ledger account is missing");
  const base = baseCurrency || "ZAR";
  const amount = roundMoney(openingBalance);
  if (!amount) return [];
  const isBase = (currency || base) === base;
  const usedRate = isBase ? 1 : Number(rate);
  if (!isBase && (!(usedRate > 0))) {
    throw httpError(400, "An exchange rate is required for a foreign-currency opening balance");
  }
  const cents = isBase ? toCents(Math.abs(amount)) : toBaseCents(Math.abs(amount), usedRate);
  const foreign = toCents(Math.abs(amount));
  const debitBank = amount > 0;
  return assertBalanced([
    line({
      accountId: debitBank ? bankLedgerAccountId : systemAccounts.opening_balance_equity,
      debit: cents,
      currency,
      foreignAmount: foreign,
      rate: usedRate,
      bankAccountId: debitBank ? bankAccountId : "",
      description,
    }),
    line({
      accountId: debitBank ? systemAccounts.opening_balance_equity : bankLedgerAccountId,
      credit: cents,
      currency,
      foreignAmount: -foreign,
      rate: usedRate,
      bankAccountId: debitBank ? "" : bankAccountId,
      description,
    }),
  ]);
}

/**
 * Company opening balances (Settings). `items` are already in base minor units.
 * The balancing figure goes to 3200 Opening balance equity.
 */
function openingBalanceLines(items, { systemAccounts, baseCurrency }) {
  const base = baseCurrency || "ZAR";
  const lines = [];
  let debit = 0;
  let credit = 0;
  for (const item of items || []) {
    const d = Number(item.debit) || 0;
    const c = Number(item.credit) || 0;
    if (!item.accountId || (d > 0 && c > 0) || (d === 0 && c === 0) || d < 0 || c < 0) {
      throw httpError(400, "Each opening balance line needs an account and either a debit or a credit");
    }
    if (!Number.isInteger(d) || !Number.isInteger(c)) throw httpError(400, "Opening balances must be integer cents");
    debit += d;
    credit += c;
    lines.push(line({
      accountId: item.accountId,
      debit: d,
      credit: c,
      currency: base,
      foreignAmount: d - c,
      rate: 1,
      description: item.description || "Opening balance",
    }));
  }
  const plug = debit - credit;
  if (plug > 0) {
    lines.push(line({
      accountId: systemAccounts.opening_balance_equity,
      credit: plug,
      currency: base,
      foreignAmount: -plug,
      rate: 1,
      description: "Opening balance equity",
    }));
  } else if (plug < 0) {
    lines.push(line({
      accountId: systemAccounts.opening_balance_equity,
      debit: -plug,
      currency: base,
      foreignAmount: -plug,
      rate: 1,
      description: "Opening balance equity",
    }));
  }
  return lines.length ? assertBalanced(lines) : [];
}

/**
 * Credit note published: the inverse of invoiceLines for the credited items
 * (Dr income and VAT, Cr 1100 debtors) at the original invoice rate.
 */
function creditNoteLines(creditNote, ctx) {
  return swapLines(invoiceLines(creditNote, ctx)).map((l) => ({
    ...l,
    description: l.description || creditNote.creditNoteNumber || "Credit note",
  }));
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
  creditNoteLines,
  paymentLines,
  paymentBankLines,
  expenseLines,
  expenseBankLines,
  transferPairLines,
  transferInTransitLines,
  bankOpeningLines,
  openingBalanceLines,
  swapLines,
  applyResidual,
  assertBalanced,
};
