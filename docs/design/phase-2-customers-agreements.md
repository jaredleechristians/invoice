# Phase 2: Customers, agreements and time (design note)

Status: draft for review, 12 Nov 2026. Docs PR is not a merge request for production.
Base: v1.6.1 on `main` (production is on 1.6.1). Phase 1 ledger is live.
Roadmap: Phase 2 of the accounting roadmap — customers, agreements and time. Build on the existing customers collection; do not replace it.

## 1. Goals and non-goals

Goals
- Credit notes that reduce what a customer owes and post reversals to the ledger (same posting rules as Phase 1: immutable journals, corrections are reversals, posted in the same Firestore transaction as the document write).
- Customer payment terms and optional credit limits, used when creating invoices and on age analysis.
- A proper debtors age analysis that includes credit notes and credit limits. Aged receivables already exist in Reports; this phase extends them rather than replacing them.
- Internal time entries, entered by hand or through the assistant, plus ad hoc billable hours outside any agreement that can be invoiced once and then marked billed.
- Agreements (the retainer feature): a period, hours, fee, rates and a rollover policy, linked to a recurring billable service.
- Recurring invoices, agreement periods (hours used and remaining), and hours reports.
- Payment reminders as drafts or a list only. The app must never send email automatically without explicit approval in the app.

Non-goals (Phase 2)
- Jira or GitHub sync, linking agreements to Jira projects, or pulling worklogs. Those stay on the backlog.
- Task management and CRM inside the app.
- Automatic email sending of invoices, statements or reminders.
- Replacing or migrating the existing `customers` collection, statements, or company-level payment terms.
- Financial statements, period locks and year-end (Phase 3), supplier bills (Phase 4), VAT201 (Phase 5).
- Paystack/Wise payment links (still backlog).

## 2. How it fits the current code

Customers already exist (`lib/customers.js`, `/dashboard/customers`). Fields today: name, email, phone, address, notes, taxNumber, optional default currency. Invoices snapshot customer details on the document. Statements (`lib/statements.js`) list invoices and payments per customer and currency. None of that is replaced; Phase 2 adds fields and new collections beside it.

Company payment terms already exist (`company.paymentTermsDays`, default 30) and are used to set an invoice due date when none is given. Phase 2 adds an optional per-customer override.

Aged receivables already exist: `agingBucket` / `AGING_BUCKETS` (`current`, `1-30`, `31-60`, `61-90`, `90+`) in `lib/status.js`, `agedReceivables` and `outstandingInvoices` in `lib/reports.js` (as of a date, payments up to that date), the Reports “Aged receivables” tab, dashboard overdue figures, and MCP `get_receivables`. Phase 2 must subtract published credit notes from outstanding and can show credit limits next to the totals. It does not invent a second ageing scheme.

Invoice outstanding today is `total - paidAmount` (`lib/status.js`). Voiding an invoice requires no active payments and reverses the ledger on the void date; deleting a published invoice reverses on the original issue date. Credit notes are a different document: they leave the original invoice in place, reduce its outstanding, and post their own journal (a reversal of the invoiced income, not a void).

Ledger posting (Phase 1) already covers invoices, payments, expenses, bank matches, transfers, manual journals and openings. Credit notes go through the same `planPost` / `planReverse` / `sourceKey` path, with source type `credit_note`. Time, agreements and recurring invoices in later slices post only when an invoice is published, the same way a manually created invoice does.

Products and services already support a catalogue used on invoice lines. Agreements link to a recurring billable service in that catalogue (or a service created for the agreement). Recurring invoices are invoices, not a new money document.

The assistant may propose writes (never finalize, void or delete). Time entries can be added manually or proposed by the assistant. Publishing a credit note, a recurring invoice or a reminder email is never an unattended assistant action.

## 3. Data model (Firestore, company-scoped)

All new collections sit under `companies/{companyId}/…`. Members can read them; only the API writes (`firestore.rules` already allows member reads on ordinary subcollections and denies client writes). No new single-field composite indexes (Firestore rejects those). Add composites only when a query needs two or more fields.

### 3.1 Customers (existing documents, new optional fields)

```
paymentTermsDays: number | null   // 0–365; null/absent = use company.paymentTermsDays
creditLimit: number | null        // >= 0, in the customer's default currency
                                  // (company defaultCurrency if the customer has none)
```

Existing customers keep working with no migration: missing terms means the company default; missing credit limit means no limit. Soft delete is unchanged.

### 3.2 Credit notes — `companies/{companyId}/creditNotes/{id}`

A credit note is its own numbered document, always linked to one published invoice in 1.7.0.

```
creditNoteNumber: "CN-000001"     // counters/creditNotes, prefix default "CN-"
draft, voided, voidedAt, voidedBy, voidReason
invoiceId                         // required; same company
customerId, customerName, customerSnapshot, billTo
currency                          // must match the invoice
exchangeRate                      // copied from the invoice (base per 1 foreign unit)
issueDate
items[]                           // same shape as invoice lines (accountId, qty, unitPrice, taxable, …)
vatRate, subtotal, taxTotal, total
reason, notes, footer
issuer                            // snapshot on publish, same as invoices
ledger: { entryId, version, … }   // Phase 1 ledger pointer
appliedToInvoiceId                // the invoice it reduces (same as invoiceId in 1.7.0)
createdAt, updatedAt, createdBy, deletedAt, deletedBy
```

Invoice documents gain `creditedAmount` (sum of published, non-void, non-deleted credit notes). Outstanding becomes `total - paidAmount - creditedAmount`. A credit note may not push that below zero. Voiding or deleting the invoice is blocked while an active credit note exists (void or delete the credit notes first), just as payments already block void.

Numbering follows `lib/numbering.js`: a `creditNotes` sequence, default prefix `CN-`, optional company `creditNotePrefix`, numbers allocated at publish, never reused after soft delete.

### 3.3 Time entries — `companies/{companyId}/timeEntries/{id}` (1.8.0)

Internal time, not a money document. Posted to the ledger only if and when it is invoiced.

```
date, minutes (or hours), person (uid or free-text name)
customerId                        // optional
description, notes
billable: false                   // internal default; true only for ad hoc billable hours
agreementId, periodId             // optional; used when the entry is against an agreement
invoiceId, billedAt               // set when included on a published invoice; prevents double billing
source: "manual" | "assistant"
createdAt, updatedAt, createdBy, deletedAt
```

Ad hoc billable hours are time entries with `billable: true` and no `agreementId`. They can be selected onto an invoice line and are then marked billed. Unbilled billable entries stay available to invoice.

### 3.4 Agreements — `companies/{companyId}/agreements/{id}` (1.9.0)

The retainer feature. Linked to a recurring billable service (a product/service).

```
customerId
name, status: "draft" | "active" | "paused" | "ended"
startDate, endDate?               // open-ended allowed
period: "month" | "quarter"       // length of each agreement period
hours, fee, currency, rate        // included hours and the period fee
overageRate                       // rate for hours above the allowance (open decision)
rolloverPolicy                    // open decision; stored once agreed
serviceId                         // product/service used on the recurring invoice
createdAt, updatedAt, createdBy, deletedAt
```

### 3.5 Agreement periods — `companies/{companyId}/agreementPeriods/{id}` (1.9.0)

One document per period of an agreement.

```
agreementId, startsOn, endsOn
hoursAllowed, hoursRolledIn, hoursUsed, hoursRemaining, hoursExpired
recurringInvoiceId                // once the period's invoice exists
status: "open" | "closed"
```

Hours used come from time entries (and any manual adjustments) linked to the period. Remaining and rollover are computed when the period closes, according to the agreed policy.

### 3.6 Recurring invoice series — `companies/{companyId}/recurringInvoices/{id}` (1.9.0)

A schedule that creates ordinary invoices (drafts, unless Jared chooses auto-publish).

```
customerId, agreementId?          // agreement retainers use this; standalone recurring is allowed
serviceId, items[], currency, vatRate, notes
frequency, nextIssueDate, paymentTermsDays?
autoPublish: false                // default; see open decisions
active, createdAt, updatedAt, createdBy
```

Generated invoices are normal `invoices` with `recurringInvoiceId` / `agreementPeriodId` so they can be traced. They post to the ledger only when published, through the existing invoice posting path.

### 3.7 Payment reminders (1.10.0, after the open decision)

A reminder is a list row and, if useful, a draft document the user can review. It is never emailed unless the user explicitly approves a send in the app. No collection is created until that decision is taken. 1.7.0 does not implement reminders.

## 4. Credit notes and the ledger (1.7.0)

On publish, in the same transaction as the document write:
- Allocate `CN-…` if needed.
- Recompute the invoice's `creditedAmount` from all active credit notes including this one; reject if outstanding would go negative.
- Post journal lines that reverse the credited portion of the invoice: Dr income (per line account / default income), Dr 2100 VAT if the credit includes tax, Cr 1100 debtors, at the invoice's rate, in base minor units. Residual cents follow the Phase 1 rule. `sourceKey` is `credit_note:<id>:v<n>`.
- Foreign credit notes use the original invoice rate (the credit unwinds that invoice, it does not strike a new FX rate).

Void (owner/admin) reverses the journal on the void date and un-applies the amount from the invoice. Soft delete of a published, non-void credit note reverses on the original issue date, same as invoices. Restore re-posts if the invoice is still there and the amount still fits.

Unallocated or multi-invoice credit notes are out of 1.7.0 (see open decisions). A credit note always targets one published invoice of the same customer and currency.

Payments still cannot overpay an invoice; the cap is the remaining outstanding after credits. Credit notes cannot exceed remaining outstanding after payments.

## 5. Terms, credit limits and age analysis (1.7.0)

- New invoices: if the customer has `paymentTermsDays`, that sets the default due date; otherwise the company default. An explicit due date on the invoice still wins.
- Credit limit is optional. It is shown on the customer and on aged receivables (outstanding vs limit, per the customer's currency). Publishing an invoice that would take that currency's outstanding over the limit **warns** in the UI and on the API response, but does not block. This is a 1.7.0 default so work can start; Jared can tighten it to a hard block later.
- Age analysis stays on Reports (and `get_receivables`): same buckets, as-of date, split by currency, now net of credit notes, with optional credit-limit columns. No new ageing report is invented.

## 6. Time, agreements, recurring invoices and hours (later slices)

1.8.0 ships time entries and ad hoc billable hours only. Internal time is non-billable by default so it cannot be invoiced by accident. The assistant can propose time entries; a person confirms them. Billing an ad hoc entry sets `invoiceId` / `billedAt` and the entry cannot be billed again. Unticking billed or voiding/deleting the invoice clears the mark (open to the same restore rules as other documents).

1.9.0 ships agreements, periods, recurring invoices and hours reports. Several billing rules are open (section 9). Until Jared answers, no agreement or recurring-invoice code is written that assumes a rollover, overage or auto-publish behaviour.

Hours reports (1.9.0) show, per customer/agreement/period: allowed, used, remaining, rolled, expired, and billed hours. Time used against an agreement counts toward the period; ad hoc billable hours are reported separately.

## 7. API, UI and MCP

1.7.0
- Customer create/update accept `paymentTermsDays` and `creditLimit`.
- Credit note CRUD, publish, void, PDF/HTML, restore kind `creditNote`.
- Invoice outstanding and statements include credits. Invoice UI shows credited amount and an “Issue credit note” action.
- Reports aged receivables and outstanding invoices subtract credits and can show the limit.
- MCP: read `list_credit_notes` / `get_credit_note`; write keys can `create_draft_credit_note` (never auto-publish). `get_receivables` stays and includes credits.

1.8.0 / 1.9.0 add time, agreement and recurring resources on the same pattern (draft-safe assistant tools, API keys follow role permissions). Reminder tools wait for 1.10.0.

## 8. Testing

Backend tests run in `node:22-alpine` on the Mac, as today (`node --test` against the in-memory FakeFirestore). 1.7.0 should cover: customer terms defaulting the invoice due date; credit limit warning without a hard block; publishing a full and a partial credit note; ledger lines (debtors, income, VAT) and a trial-balance still at zero; outstanding, ageing, statements and payments caps after a credit; void/delete/restore of a credit note; rejecting a credit that exceeds remaining outstanding; rejecting void of an invoice that still has a credit note. Later slices add time, billing-once, and (once decided) agreement/recurring cases.

## 9. Open decisions (need Jared)

Short questions, with a recommended default. 1.7.0 does not depend on these except where noted.

1. **Rollover of unused agreement hours?**
   Recommended default: unused hours roll into the next period only, capped at one period's allowance; hours older than that expire. Alternatives: no rollover, or unlimited roll.

2. **How is overage billed?**
   Recommended default: when a period closes, hours above the allowance (after rollover) are added as a separate line (or a follow-up invoice) at the agreement's overage rate, or at the standard rate if no overage rate is set. Do not auto-bill mid-period.

3. **Recurring invoices: draft or auto-publish?**
   Recommended default: always generate drafts for review, never auto-publish. Matches how the assistant and API keys treat new invoices today.

4. **What do payment reminders do?**
   Recommended default: a list of overdue invoices (using the customer's terms) plus an optional draft reminder you can review. Nothing is emailed unless the user explicitly approves a send in the app. There is no automatic schedule that sends mail on its own.

5. **Credit limit: warn or block publish?**
   Recommended default (used in 1.7.0 so the slice can ship): warn on the invoice and on ageing, allow the owner/admin to publish anyway. Can be changed to a hard block later.

6. **Must a credit note always link to one invoice?**
   Recommended default (used in 1.7.0): yes, same customer and currency, applied immediately to that invoice. Unallocated or multi-invoice credits can wait.

7. **How do agreement periods line up?**
   Recommended default: anniversary periods from the agreement's start date (start 15 Jan → 15 Jan–14 Feb for a monthly agreement), not necessarily calendar months.

## 10. Slice plan

| Slice | Scope | Notes |
| --- | --- | --- |
| **1.7.0** | Credit notes (ledger reversals, apply to one invoice, void/delete/restore, PDF). Customer payment terms and credit limits. Debtors age analysis extended (credits + limits). Statements include credits. | Uses the defaults in questions 5 and 6. No reminders. No catch-up/backfill (production may already have invoices after 1.6.1; credits only apply when a user issues one). |
| **1.8.0** | Time entries (internal, manual or assistant). Ad hoc billable hours, invoice them, mark billed so they cannot be billed twice. | Does not depend on the agreement decisions. |
| **1.9.0** | Agreements, recurring invoices, agreement periods (hours used and remaining), hours reports. | Starts once questions 1, 2, 3 and 7 are answered. Until then the design is documented, not coded. |
| **1.10.0** | Payment reminders as drafts or a list only. | Starts once question 4 is answered. No automatic email send without in-app approval. |

Do not merge or deploy a slice until Jared authorises it. Firestore rules do not need new match blocks for these collections (the existing catch-all already allows member reads and denies client writes); any new composite indexes must be real composites, not single-field ones.

## 11. Decisions already taken (memory / this brief)

- Build on existing customers; do not replace them.
- The retainer feature is called **Agreements**, and an agreement links to a recurring billable service.
- Time tracking in this phase is internal time entries only (manual or assistant). Jira/GitHub sync, task management and CRM are out of scope.
- Ad hoc billable hours outside an agreement can be entered manually, invoiced, and marked billed.
- Payment reminders are drafts or a list only; no automatic email without explicit approval in the app.
- Production is on 1.6.1. Phase 1 ledger posting is already live.
