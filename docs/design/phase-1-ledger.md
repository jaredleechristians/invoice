# Phase 1: General ledger foundation (design note)

Status: decisions taken 12 Nov 2026 (section 11). No code until the PR is approved.
Base: v1.3.1 (`main` @ f62e362). Roadmap: Phase 1 of the accounting roadmap.

## 1. Goals and non-goals

Goals
- A double-entry ledger under everything the app already does: every invoice, payment, expense, bank match and transfer posts a balanced journal entry, in the company's base currency, automatically.
- A base currency per company, selectable in Settings (default ZAR), locked once the ledger has entries.
- A chart of accounts per company (SA small-business template, editable).
- Manual journals and an optional opening balances entry.
- Ledger stays correct when documents are edited, voided, soft-deleted or restored (reversals, never edits).

Non-goals (Phase 1)
- Financial reports (TB, IS, BS, GL detail), period locks, year-end close: Phase 3. Phase 1 only ships a minimal trial balance endpoint used by tests and checks.
- Credit notes, agreements, time entries, recurring invoices: Phase 2.
- Supplier bills and creditors: Phase 4 (the creditors account exists but nothing posts to it).
- VAT input tracking and VAT201: Phase 5. Phase 1 posts output VAT from invoices (the data already exists) and posts expenses gross.
- Phase 5 VAT/VAT201 and SARS outputs assume a ZAR base. A company with a non-ZAR base keeps its books in that currency, but VAT figures would need converting to ZAR for SARS (see 3.1).
- Backlog: multiple VAT rates per line, FX revaluation (unrealised), recurring journals.
- No backfill. Production (robot-invoice) was checked read-only on 12 Nov 2026: one company with 0 invoices, payments, expenses, bank lines, bank accounts, quotes and customers. The ledger starts empty at go-live (see section 7).

## 2. How it fits the current code

Today the documents are the books: `reports.js` computes everything from invoices/payments/expenses, per currency, with no FX conversion. Relevant facts the design relies on:

| Area | Code | What matters for posting |
|---|---|---|
| Invoices | `lib/invoices.js` | Draft until finalize (`createInvoice` with `draft:false`, `updateInvoice` with `finalize`). Published invoices stay editable (items, vatRate, currency before payments, `exchangeRate`, issueDate). `voidInvoice` only when no active payments. `deleteInvoice` = soft delete, only when no payments. `exchangeRate` = ZAR per 1 unit on invoice date, optional today (becomes required for foreign invoices, and is re-defined as base per 1 unit). |
| Totals | `lib/money.js` `documentTotals` | Prices are VAT-exclusive: `subtotal` + `taxTotal` (single `vatRate`, `taxable` per line) = `total`. Floats rounded to 2dp. |
| Lines | `lib/documents.js` `normalizeLines` | Lines carry `productId` (optional). |
| Payments | `lib/payments.js` | Always in the invoice currency. Written inside `applyPaymentChange` (a Firestore transaction). Void, soft delete, restore (`lib/restore.js`). Bank-linked payments carry `transactionId`, `bankAccountId` and forex fields from `computeForex` (`zarReceived`, `invoiceRate`, `zarAtInvoiceRate`, `forexGainZar`, `forexFlag`). |
| Expenses | `lib/expenses.js` | Amount + currency + category, no VAT split, no exchange rate. Batch writes, soft delete, restore. Linked to a bank line via `transactionId`. |
| Bank | `lib/bankTransactions.js`, `lib/bankLinks.js`, `lib/bankAccounts.js` | Lines import as `unreconciled`; `reconcile` actions: `match_invoice` (creates payment), `match_payment`, `create_expense`, `match_expense`, `transfer` (optional pair), `ignore`. `undo` (optionally deletes the created payment/expense). `releaseTransaction` unlinks when a payment/expense is voided/deleted. Bank accounts have `currency`, `openingBalance`, `openingDate`. |
| Settings | `lib/companies.js` | `vatRegistered`, `vatRate` (15), `taxYearEndMonth` (2), `defaultCurrency` (document default, not a base currency), currencies ZAR/USD/EUR/GBP. Everything currency-related assumes ZAR as home currency today (`computeForex`, `zarReceived`, "rand received"). |
| Other writers | `lib/assistantActions.js`, `lib/importLocal.js`, `lib/quotes.js` `convertQuote`, `routes/mcp.js` | All go through the lib functions above, so posting in the lib layer covers UI, API keys, MCP and the assistant. Quotes never post. |
| Rules | `firestore.rules` | Members read company subcollections; all writes are server-only (Admin SDK). |
| Tests | `backend/tests/*`, `tests/helpers/fakeFirestore.js` | Fake Firestore supports transactions, batches and `array-contains`. |

## 3. Data model (Firestore, company-scoped)

### 3.1 Base currency

- New setting `company.baseCurrency` (Settings > Tax and currency), one of the supported currencies, default `ZAR`. Separate from `defaultCurrency`, which stays the default for new documents.
- Every journal line stores its amount in the base currency (minor units), plus the original currency, original amount and rate. Rates are always **base per 1 unit of the foreign currency** (for a ZAR base, the current ZAR-per-unit `exchangeRate`).
- A document in the base currency has rate 1 and needs no exchange rate. "Foreign" below always means "not the base currency".
- FX gains and losses are measured in the base currency.
- Locked once any journal entry exists (API returns 409 and the field is read-only in Settings). Changing it after that would need a re-translation of the whole ledger, which is out of scope.
- The existing ZAR-specific forex fields generalise to base terms in 1.6.0: `zarReceived` -> `baseReceived`, `zarAtInvoiceRate` -> `baseAtInvoiceRate`, `forexGainZar` -> `forexGainBase`, and `computeForex` compares the received currency with `baseCurrency` instead of `"ZAR"` (flag `non_base_account`). UI copy "rand received" becomes "amount received in <base>". Production is empty, so no data migration; readers fall back to the old field names for safety.
- Phase 5 implication: VAT201 and SARS outputs are in ZAR. For a ZAR base (the expected case) they come straight from the ledger. For a non-ZAR base, Phase 5 would need to convert VAT amounts to ZAR at the document rate (and the documents would need a ZAR rate as well). Phase 5 will either support that or only allow VAT reporting for ZAR-base companies.

### `companies/{companyId}/accounts/{accountId}`

```
code: "1100"              // unique per company, 4 digits
name: "Trade debtors"
type: "asset" | "liability" | "equity" | "income" | "expense"
subtype: "bank" | "receivable" | "payable" | "vat" | "fx" | "clearing"
       | "retained_earnings" | "opening_balance" | "current_asset" | ... (display/grouping)
systemKey: "debtors" | "creditors" | "vat" | "fx" | "retained_earnings"
         | "opening_balance_equity" | "undeposited_funds" | "expense_clearing"
         | "transfers_in_transit" | "default_income" | "default_expense" | null
bankAccountId: "<bankAccounts id>" | null   // one ledger account per Settings bank account
currency: "ZAR" | "USD" | ...                // base currency except foreign bank accounts
active: true                                  // archive instead of delete
createdAt, updatedAt, createdBy
```

- System accounts can be renamed/recoded but not archived or retyped.
- An account with posted lines can't be deleted, only archived (archived accounts reject new postings).
- `companies/{id}.ledger = { goLiveDate, systemAccounts: { debtors: "<id>", ... } }` caches system account ids so posting needs one read.

### `companies/{companyId}/journals/{entryId}`

One document per entry, lines embedded (an entry never has more than a few hundred lines; Firestore writes it atomically).

```
number: "JNL-000123"         // per-company sequence (counters/journals)
date: "2026-11-12"           // accounting date (document date)
kind: "auto" | "manual" | "opening" | "reversal"
source: { type: "invoice"|"payment"|"payment_bank"|"expense"|"expense_bank"|"transfer"|"bank_opening"|"manual"|"opening",
          id, number, event: "post"|"void"|"delete"|"edit"|"restore"|"undo", version }
sourceKey: "invoice:abc123:v2"   // idempotency key; also the doc id (see 5.3)
memo: "INV-0042 Acme Ltd"
lines: [{
  accountId, debit, credit,        // base-currency minor units (cents), exactly one > 0
  currency: "USD",                 // original currency of the line
  foreignAmount: 200000,           // signed minor units in that currency (debit +, credit -)
  rate: 18.25,                     // base per 1 unit (1 for base-currency lines)
  customerId, bankAccountId,       // sub-ledger tags (debtors, bank)
  description
}]
accountIds: ["..."]              // denormalised for array-contains queries
baseCurrency: "ZAR"               // copied from the company for each entry
totalCents: 3650000              // sum of debits (= sum of credits), base minor units
reversesId: null | "<entryId>"   // on a reversal
reversedById: null | "<entryId>" // set on the original when reversed (the only mutable field)
createdAt, createdBy
```

- Money in the ledger is integer minor units of the base currency (no float drift); converted from the 2dp document values once at posting. All four supported currencies have 2 decimals.
- Posted entries are immutable. A correction is a reversal (same lines, debit/credit swapped, `reversesId` set) plus, if needed, a new entry with the next `version`.
- Source documents get `ledger: { entryId, version }` (and `bankEntryId` for bank links) so the current live entry is one read away.

### Indexes (`firestore.indexes.json`)
- journals: `date ASC`
- journals: `source.type ASC, source.id ASC, date ASC`
- journals: `accountIds ARRAY_CONTAINS, date ASC`
- accounts: none (small; read whole collection with `fetchAll`).

Running balances are computed on read for Phase 1 (small volumes). Phase 3 can add monthly balance snapshots if the trial balance gets slow.

### Security rules
- Add explicit `match /accounts/{id}` and `match /journals/{id}` blocks: `read: if isMember(companyId)`, `write: if false`. (The catch-all already allows member reads; the explicit blocks document intent and make it easy to restrict to an accountant role in Phase 5.)
- `counters/journals` stays covered by the existing catch-all (server-only writes).

## 4. Chart of accounts (SA small-business template)

Seeded on first use (like `expenses.listCategories` seeds categories) and for every new company. Editable in Settings > Accounts.

| Code | Name | Type | System key |
|---|---|---|---|
| 1000-1099 | One per Settings bank account (e.g. 1001 FNB Cheque, 1002 Wise USD) | asset (bank) | bankAccountId |
| 1100 | Trade debtors | asset | debtors |
| 1150 | Undeposited funds | asset (clearing) | undeposited_funds |
| 1160 | Transfers in transit | asset (clearing) | transfers_in_transit |
| 1200 | Prepayments and deposits | asset | |
| 1300 | Computer equipment | asset | |
| 1310 | Accumulated depreciation | asset (contra) | |
| 2000 | Trade creditors | liability | creditors (unused until Phase 4) |
| 2050 | Expenses awaiting bank match | liability (clearing) | expense_clearing |
| 2100 | VAT control | liability | vat |
| 2200 | Shareholder / director loan | liability | |
| 2300 | SARS income tax | liability | |
| 2400 | Accruals | liability | |
| 3000 | Share capital | equity | |
| 3100 | Retained earnings | equity | retained_earnings |
| 3200 | Opening balance equity | equity | opening_balance_equity |
| 4000 | Sales: services | income | default_income |
| 4100 | Sales: products | income | |
| 4200 | Interest received | income | |
| 4800 | Other income | income | |
| 4900 | Exchange differences (realised) | income (gain +, loss -) | fx |
| 5000-5450 | One per default expense category: Advertising & marketing, Bank charges, Contractors, Equipment (small items), Hosting & domains, Office & supplies, Professional fees, Software & subscriptions, Telephone & internet, Travel | expense | |
| 5500 | Salaries and wages | expense | |
| 5600 | Rent | expense | |
| 5700 | Depreciation | expense | |
| 5800 | Interest paid | expense | |
| 5900 | Other expenses (also "Uncategorised") | expense | default_expense |

## 5. Posting

### 5.1 Where it happens
- New module `backend/lib/ledger/`:
  - `accounts.js`: CRUD, seeding, archive, system account resolution.
  - `rules.js`: pure functions `(doc, context) -> lines[]`, one per document type. No Firestore. All the accounting lives here and is unit-tested directly.
  - `post.js`: `postEntry(tx, companyId, { sourceKey, date, lines, ... })`, `reverseEntry(tx, ...)`; asserts balance, active accounts, allocates the number inside the same transaction.
  - `journals.js`: manual journals, list/get, trial balance.
- Posting runs inside the same Firestore transaction as the document write. Writes that are not transactional today move to `db.runTransaction`:
  - `invoices.js`: create (when published), update, finalize, void, delete.
  - `expenses.js`: create, update, delete (batch -> transaction).
  - `bankTransactions.js`: `finish`, `markTransfer`, `undo`; `bankLinks.releaseTransaction`.
  - `restore.js`: invoice, expense, payment restore.
  - `payments.js` already uses `applyPaymentChange`; posting is added inside it.
  - `numbering.allocateNumber` gets a variant that takes an existing `tx`, so the invoice number and the journal post commit together.
- If posting fails (unbalanced, archived account, missing FX rate), the whole document write fails with a 400/409 and a clear message. No half-posted state.

### 5.2 Account mapping
- Products: new optional `incomeAccountId` (default 4000 services / 4100 products by `kind`). On save, `normalizeLines` copies the product's account onto the line as `accountId`, so posting never re-reads products and old documents keep their mapping. Lines without a product use 4000.
- Expense categories: new `accountId`. Default categories map to the template accounts above; new categories default to 5900 and can be changed in Settings. `normalizeExpense` stores `accountId` on the expense.
- Bank accounts: creating a Settings bank account creates its ledger account (10xx, same currency) in the same transaction; renaming syncs the name; deleting archives it (deletion is already refused when the account has lines).
- Rate: foreign-currency documents post at the document `exchangeRate` (base per unit on the document date; for a ZAR base this is the s25D spot rate). A foreign-currency invoice can't be published without an exchange rate (decision 2): `assertFinalizable` returns 400, and once published the rate can only change before payments exist. Expenses get a new optional `exchangeRate`; when created from a bank line in a base-currency account it is derived from the line, otherwise it is required for a foreign expense.

### 5.3 Idempotency
- `sourceKey` = `<type>:<id>:v<version>` (reversals: `<sourceKey>:rev`). The journal doc id is derived from it, and posting uses `tx.create`, so a retried request or double click can't post twice (the second create fails and the call returns the existing entry).
- Version increments on every re-post of the same document (edit, restore).

### 5.4 Posting rules

Amounts are in the base currency; foreign lines also carry currency, foreign amount and rate. Rounding: each line is converted and rounded to minor units; any residual cent goes to the largest income line so the entry balances exactly.

| Event (code path) | Entry | Date |
|---|---|---|
| Invoice published (`createInvoice` with `draft:false`, `updateInvoice` finalize, `import-local`). Foreign invoices need `exchangeRate` first. | Dr 1100 Debtors `total` (tag customerId). Cr income account per line group `subtotal`. Cr 2100 VAT `taxTotal` (if > 0). | issueDate |
| Draft saved / edited, quote created/converted | none | |
| Published invoice edited (items, vatRate, issueDate, customer, accounts) | Reverse current entry, post v+1. No entry if nothing ledger-relevant changed. | reversal on the original issueDate, new entry on the new issueDate (decision 3) |
| Invoice `exchangeRate` changed | Blocked with 409 once payments exist (same as the existing currency rule). Before payments: reverse and re-post. | issueDate |
| Invoice voided (`voidInvoice`) | Reverse the invoice entry. | void date (decision 3) |
| Invoice soft-deleted (`deleteInvoice`, published only) | Reverse the invoice entry. | original issueDate (decision 3) |
| Invoice restored (`restoreRecord`) | Post v+1. | issueDate |
| Payment recorded, not via bank (`recordPayment`) | Dr 1150 Undeposited funds, Cr 1100 Debtors, both at the invoice rate (tag customerId). | paidAt |
| Bank line matched to invoice (`match_invoice`) | Payment entry above, then the bank entry below, in the same transaction. | line date |
| Bank entry (`match_invoice` / `match_payment`), same currency as invoice | Dr Bank account, Cr 1150 Undeposited (`baseAtInvoiceRate`, or the amount itself for a base-currency invoice). | line date |
| Bank entry, foreign invoice into a base-currency account | Dr Bank `baseReceived`. Cr 1150 `baseAtInvoiceRate`. Difference `forexGainBase` to 4900 (Cr gain / Dr loss). Exactly the generalised `computeForex`. The invoice always has a rate (required at publish), so the reconcile dialog no longer needs to ask for one. | line date |
| Bank entry, foreign invoice into a same-currency foreign account (e.g. USD into Wise USD) | Dr Bank (USD, base amount at invoice rate), Cr 1150. No FX until the money is converted. | line date |
| Payment voided / soft-deleted (`voidPayment`, `deletePayment`) | Reverse the payment entry; `releaseTransaction` reverses the bank entry. | void date / original paidAt for delete |
| Payment restored | Post v+1 payment entry (bank link was cleared on delete). | paidAt |
| Bank match undone (`undo`) | Reverse the bank entry; with `deleteCreated:true` the payment/expense delete also reverses its own entry. | original line date |
| Expense saved (`createExpense`) | Dr expense account (category), Cr 2050 Expenses awaiting bank match until it is matched to a bank line (decision 4). Gross, no VAT split until Phase 5. | expense date |
| Expense edited (amount, date, category, currency, rate) | Reverse and post v+1. | expense date |
| Expense soft-deleted / restored | Reverse / post v+1; delete also releases the bank line (reverses the bank entry). | expense date |
| Bank line to expense (`create_expense`, `match_expense`) | Expense entry (if created), then bank entry Dr 2050, Cr Bank. Foreign expense paid from a base-currency account: rate = line amount / expense amount. | line date |
| Transfer with a pair (`transfer` + `pairTransactionId`) | Dr receiving bank, Cr sending bank. Cross-currency (e.g. Wise USD to FNB ZAR with a ZAR base): Cr the foreign account at its average base cost (base balance / foreign balance on that date), Dr the receiving account the base amount received, difference to 4900 as realised FX. Between two non-base accounts both sides are valued at the sending account's average cost. | line date |
| Transfer without a pair | Each side posts against 1160 Transfers in transit; it nets to zero once the other side is imported and marked. | line date |
| Ignored line | none (use only for duplicates and non-business lines; anything real should be an expense or transfer). | |
| Unreconciled line | none. The bank ledger account = opening balance + reconciled lines. | |
| Bank account opening balance (`openingBalance`/`openingDate` in Settings) | Dr Bank, Cr 3200 Opening balance equity (reverse and re-post when changed). | openingDate (or go-live date) |
| Credit notes (Phase 2) | Dr income per line, Dr 2100 VAT, Cr 1100 Debtors. Source type reserved now. | |

Invariants after every API call (checked in tests):
- every entry balances in base minor units;
- 1100 Debtors per customer and currency (foreign amount) = `listReceivables` outstanding;
- 1150 Undeposited funds = active payments without a bank link;
- 2050 = active expenses without a bank link;
- each bank ledger account = `openingBalance` + reconciled lines (foreign accounts compared in their own currency).

## 6. Manual journals and opening balances

Manual journals (`POST /companies/:id/journals`, owner/admin via `canManageSettings`):
- At least two lines, base currency only, must balance, active accounts only.
- Can't post to the control and clearing accounts that sub-ledgers own: debtors, creditors, undeposited funds, expense clearing, transfers in transit. Bank accounts are allowed with a warning (it breaks reconciliation if the line is later imported).
- Immutable; corrected with `POST /journals/:id/reverse` and a new journal.
- Audit-logged (`journal.create`, `journal.reverse`).

Opening balances (optional):
- `company.ledger.goLiveDate` is set automatically when 1.5.0 (the first release that posts) is deployed. No fixed date (decision 1).
- Bank opening balances come from Settings bank accounts automatically.
- Settings > Accounts > Opening balances lets an owner enter balances for any other balance sheet account as at the go-live date (e.g. share capital, shareholder loan, equipment). One `kind:"opening"` entry; the balancing figure goes to 3200 Opening balance equity for the accountant to clear. Editing it reverses and re-posts.
- Open customer invoices from before go-live aren't expected (the app is empty), so debtors opening balances aren't supported in Phase 1.

## 7. No backfill: the ledger starts empty

Production was checked read-only on 12 Nov 2026: no invoices, payments, expenses, bank lines or bank accounts exist. So:
- No backfill script, no dry-run, no rollback. The ledger starts empty at go-live and every document from then on posts live.
- The only starting balances are the optional opening balances in section 6.
- No need to hold off capturing (decision 1). Anything captured before 1.5.0 is picked up by a one-off catch-up that runs on the 1.5.0 deploy: it posts every published, non-deleted document that has no `ledger.entryId`, re-using `rules.js` and idempotent through `sourceKey`, then checks the invariants in 5.4. With the app as small as it is, this is a handful of documents, not a backfill project. Foreign invoices captured before then without a rate are listed for a rate to be added before they post.

## 8. API, UI and MCP

API (under `/companies/:companyId`):
- `GET/POST /accounts`, `PATCH /accounts/:id`, `POST /accounts/:id/archive` (`canManageSettings` for writes).
- `GET /journals?accountId&from&to&sourceType&sourceId`, `GET /journals/:id`, `POST /journals`, `POST /journals/:id/reverse`.
- `GET /ledger/trial-balance?asOf=` (minimal; the full report is Phase 3).
- `PUT /ledger/opening-balances`.

UI: Settings > Accounts (list, edit, archive, mapping for categories and products), a "Ledger" tab on invoice/payment/expense views showing the entries, manual journal form, opening balances form.

MCP / API keys: read-only tools `list_accounts`, `list_journals`, `get_trial_balance`. No write tools for journals in Phase 1. Existing write tools post automatically through the lib layer.

## 9. Testing

- Unit tests for `ledger/rules.js` (pure): every rule's output balances; rounding residuals; mapping fallbacks.
- Golden scenarios (fake Firestore, `backend/tests/ledger.test.js`), each asserting exact entries and the invariants in 5.4:
  1. (ZAR base, as are 2-10) ZAR invoice with 15% VAT, partial then full payment, matched to FNB lines.
  2. USD invoice (rate 18.00) paid into a ZAR account at 18.25 (gain) and at 17.50 (loss); `computeForex` figures match the FX line.
  3. USD invoice paid into Wise USD, then transferred to FNB ZAR (average-cost FX on conversion).
  4. Published invoice edited, voided, deleted and restored.
  5. Payment voided, deleted, restored; bank `undo` with `deleteCreated` true and false.
  6. Expense created from a bank line, edited, deleted; expense matched later; foreign expense.
  7. Transfer with and without a pair.
  8. Bank opening balance, opening balances entry, manual journal (unbalanced and control-account journals rejected).
  9. Idempotency: replaying the same request posts nothing new.
  10. Failure atomicity: a posting error leaves the document unchanged.
  11. Non-ZAR base (e.g. USD base): ZAR invoice posts at its rate, FX measured in USD; base currency change refused once an entry exists; foreign invoice publish refused without a rate.
- Existing tests keep passing (posting is additive). Emulator smoke test via `docker-compose.emulators.yml` before each deploy.

## 10. Slice plan

| Release | Scope | Ships to prod? |
|---|---|---|
| 1.4.0 | Base currency setting (default ZAR, locked once entries exist). Chart of accounts: `accounts` collection, template seeding, system accounts, Settings > Accounts page, product and category mapping fields, bank account <-> ledger account link, rules and indexes. No posting. | Yes |
| 1.5.0 | Posting engine (`ledger/rules.js`, `post.js`), transactional writes, invoices (publish, edit, void, delete, restore), payments (record, void, delete, restore), expenses, reversals, idempotency, Ledger tab on documents, trial balance endpoint, MCP read tools, exchange rate required to publish foreign invoices, catch-up of documents captured before deploy, golden tests 1, 4, 5, 6, 9, 10, 11. Sets `goLiveDate` on deploy. | Yes; ledger is live from here |
| 1.6.0 | Bank entries (match invoice/payment/expense, undo), `computeForex` and forex fields generalised to the base currency, FX differences, transfers (paired, in transit, cross-currency), bank opening balances, manual journals and reversal, opening balances entry, golden tests 2, 3, 7, 8. | Yes |

Each slice: branch off `main`, PR, tests green, built on the Mac, deployed only when approved.

Note: between 1.5.0 and 1.6.0, payments sit in 1150 Undeposited funds and expenses in 2050 until bank entries arrive; 1.6.0 then posts bank entries for lines reconciled in the meantime (idempotent via `sourceKey`), which is a small catch-up, not a backfill. 1.5.0 and 1.6.0 ship separately (decision 5).

## 11. Decisions (Jared, 12 Nov 2026)

1. **Go-live:** the ledger goes live with the deployment that first includes posting (1.5.0). No fixed date, and no need to hold off capturing; a one-off catch-up on that deploy posts anything captured before (section 7).
2. **Foreign invoices:** an exchange rate is required before a foreign-currency invoice can be published.
3. **Reversal dates:** voids reverse on the void date; deletes and edits reverse on the original date.
4. **Unmatched expenses:** expenses with no bank line sit in 2050 Expenses awaiting bank match until matched. This is the default (not explicitly confirmed) and can change.
5. **Releases:** 1.5.0 and 1.6.0 ship separately, with the small catch-up for bank lines reconciled in between.
6. **Chart of accounts:** use the 4-digit template in section 4.
7. **Base currency:** selectable per company in Settings (default ZAR) instead of hard-coded ZAR; locked once any journal entry exists. Ledger amounts, rates and FX are all in base terms; VAT/SARS outputs in Phase 5 assume ZAR (section 3.1).
