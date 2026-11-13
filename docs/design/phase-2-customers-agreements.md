# Phase 2: Customers, agreements and time (design note)

Status: decisions recorded, 13 Nov 2026 (Amazon SES system sender; WhatsApp channel on the backlog). Docs PR is not a merge request for production.
Base: v1.6.1 on `main` (production is on 1.6.1). Phase 1 ledger is live. 1.7.0 is implemented in PR #18 (not merged).
Roadmap: Phase 2 of the accounting roadmap — customers, agreements and time. Build on the existing customers collection; do not replace it.

## 1. Goals and non-goals

Goals
- Credit notes that reduce what a customer owes and post reversals to the ledger (same posting rules as Phase 1: immutable journals, corrections are reversals, posted in the same Firestore transaction as the document write).
- Customer payment terms and optional credit limits, used when creating invoices and on age analysis.
- A proper debtors age analysis that includes credit notes and credit limits. Aged receivables already exist in Reports; this phase extends them rather than replacing them.
- Internal time entries, entered by hand or through the assistant, plus ad hoc billable hours outside any agreement that can be invoiced once and then marked billed.
- Agreements (the retainer feature): a period, hours, fee, rates and a rollover policy, linked to a recurring billable service.
- Recurring invoices, agreement periods (hours used and remaining), and hours reports.
- Payment reminders: an overdue list, a manual send, and optional automatic email on a company schedule. Automatic sending is a company setting and defaults to **off**, so nothing emails a customer until Jared turns it on. Each send is logged against the invoice; the same schedule step is never sent twice.

Non-goals (Phase 2)
- Jira or GitHub sync, linking agreements to Jira projects, or pulling worklogs. Those stay on the backlog.
- Task management and CRM inside the app.
- Automatic email sending of invoices or statements (reminders are the exception, and only once the company setting is turned on).
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

The assistant may propose writes (never finalize, void or delete). Time entries can be added manually or proposed by the assistant. Publishing a credit note, a recurring invoice or a reminder email is never an unattended assistant action. Auto-publish of a recurring invoice (when the agreement allows it) is an app/scheduler action, not an assistant action.

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
date, minutes                     // minutes is the stored unit; hours = minutes / 60
personUid?, personName            // uid and/or free-text name
customerId?                       // optional; required to invoice ad hoc hours
description, notes
billable: false                   // internal default; true only for ad hoc billable hours
rate?                             // optional unit rate used when invoicing ad hoc hours
currency?                         // rate currency; defaults to the customer's / company currency
agreementId, periodId             // optional; used from 1.9.0 when the entry is against an agreement
invoiceId, billedAt               // invoiceId is set when the entry is on a draft or published invoice
                                  // billedAt is set when that invoice is published; prevents double billing
source: "manual" | "assistant"
createdAt, updatedAt, createdBy, deletedAt
```

Ad hoc billable hours are time entries with `billable: true` and no `agreementId`. They can be selected onto an invoice line (`items[].timeEntryId`) and are then marked billed. Unbilled billable entries stay available to invoice. Putting an entry on a draft invoice reserves it (`invoiceId` set, `billedAt` empty) so it cannot be added to a second invoice. Voiding or deleting the invoice, or removing the line from the invoice, clears the mark. Restoring a published invoice sets the mark again if the amount still belongs on that invoice.

### 3.4 Agreements — `companies/{companyId}/agreements/{id}` (1.9.0)

The retainer feature. Linked to a recurring billable service (a product/service).

```
customerId
name, status: "draft" | "active" | "paused" | "ended"
startDate, endDate?               // open-ended allowed
period: "month" | "quarter"       // calendar months, or calendar quarters (Jan–Mar, Apr–Jun, …)
hours, fee, currency, rate        // included hours and the period fee (standard rate)
overageRate?                      // rate for hours above the allowance; if unset, use `rate`
rolloverPolicy: {
  mode: "expire" | "rollover"     // configured per agreement
  limitHours: number | null       // only when mode is "rollover"; null / blank = no cap
}
serviceId                         // product/service used on the recurring invoice
autoPublish: false                // per agreement: recurring invoices are drafts unless this is true
createdAt, updatedAt, createdBy, deletedAt
```

### 3.5 Agreement periods — `companies/{companyId}/agreementPeriods/{id}` (1.9.0)

One document per calendar period of an agreement. Periods follow calendar months (or calendar quarters). They do not run as anniversary windows from the start date.

```
agreementId, startsOn, endsOn     // inclusive dates
daysInPeriod, daysInFullPeriod    // for proration (equal when the period is a full month or quarter)
prorated: boolean
hoursAllowed                      // agreement.hours, or the prorated allowance for a partial first/last period
hoursRolledIn                     // unused hours brought from the previous period (not prorated)
hoursUsed, hoursRemaining, hoursExpired, hoursOverage
fee                               // agreement.fee, or the prorated fee for a partial first/last period
recurringInvoiceId                // the invoice for this period's fee (overage from the *previous* period may also be a line on it)
status: "open" | "closed"
```

Hours used come from time entries (and any manual adjustments) linked to the period. Remaining, rollover, expiry and overage are computed when the period closes, according to the agreement's policy.

### 3.6 Recurring invoice series — `companies/{companyId}/recurringInvoices/{id}` (1.9.0)

A schedule that creates ordinary invoices. Draft vs auto-publish is taken from the linked agreement (`agreements.autoPublish`). Standalone recurring invoices (no agreement) default to drafts.

```
customerId, agreementId?          // agreement retainers use this; standalone recurring is allowed
serviceId, items[], currency, vatRate, notes
frequency, nextIssueDate, paymentTermsDays?
autoPublish: false                // copied from the agreement when linked; otherwise default false
active, createdAt, updatedAt, createdBy
```

Generated invoices are normal `invoices` with `recurringInvoiceId` / `agreementPeriodId` so they can be traced. They post to the ledger only when published, through the existing invoice posting path.

### 3.7 Payment reminders (1.10.0)

Company setting, default **off**. Until it is turned on, nothing is emailed automatically. The overdue list and a manual send are still available.

```
paymentReminders: {
  enabled: false                  // default off
  steps: [                        // days relative to the invoice due date
    { days: -3 },                 // suggested defaults once enabled: 3 days before,
    { days: 0 },                  // on the due date,
    { days: 7 },                  // 7 days after,
    { days: 14 },                 // 14 days after
  ]
}
```

Negative `days` is before the due date, `0` is on the due date, positive is after (overdue). The suggested steps above are a starting point when the setting is first turned on; Jared can change them.

Each send is logged on the invoice so the same step cannot be sent twice:

```
// companies/{companyId}/invoices/{invoiceId}/reminderLog/{stepDays}
stepDays, sentAt, sentBy          // "schedule" or the user's uid
via: "schedule" | "manual"
```

A manual send of a scheduled step records that step and prevents the scheduler from sending it again. A one-off manual send that is not a scheduled step is also logged, with a distinct key, and does not block other steps.

The app still shows an overdue list (using the customer's terms). Publishing or sending a reminder email is never an unattended assistant action. Automatic reminder email (when enabled) is an app/scheduler action. Invoices and statements are not auto-emailed.

1.7.0 and 1.8.0 do not implement reminders. Automatic reminders cannot be turned on until the system mailer is configured (including a product domain and verified from-address), the company has a reply-to address, and a test send has succeeded (section 3.8).

### 3.8 Outgoing email (1.10.0)

The app does not send email today. Member invites are a copy-the-link flow ("Invites aren't emailed yet"). Invoices and statements are downloaded as PDF/HTML; emailing them is still out of scope. Sign-in is Google via Firebase Auth; the app does not send its own auth mail. There is no mailer in the backend yet.

One system sender for all companies. Amazon SES is the system email provider, behind a small swappable **mailer adapter** interface so the reminder code does not depend on SES APIs directly. A later adapter (or the same interface with a different `MAIL_PROVIDER`) can be added without rewriting scheduling or templates. Nothing about the product name, domain, or provider is hardcoded.

Env / config (names are indicative):
- `MAIL_PROVIDER=ses` — selects the SES adapter (the production default).
- AWS region and credentials — region plus access keys in env, or an instance/task role. Never stored in Firestore or sent to the client.
- `MAIL_FROM_ADDRESS` — the single verified system from-address, the same for every company.
- `APP_NAME` — the product name used in email branding (subject, footer, and similar). This is the app's own product identity, not a host-company brand.

The From header uses the **company name** as the display name and `MAIL_FROM_ADDRESS` as the address, for example `"Acme" <MAIL_FROM_ADDRESS>`. Product branding in the body and footer comes from `APP_NAME`. **Reply-To** is a `replyToEmail` field in company settings, defaulting to the owner's email. Owners and admins can change it in Settings.

A **test send** button in Settings (to an address the user types) uses that From, Reply-To, and `APP_NAME` branding. A successful test send is recorded for the company (`mailVerifiedAt`).

The app will have its own product name and domain. A product domain is needed before reminders go live, so `MAIL_FROM_ADDRESS` can be a verified address on that domain. SES setup prerequisites:
- Verify the product domain in SES, with DKIM signing enabled.
- Move the AWS account out of the SES sandbox so mail can go to any recipient, not only verified addresses.
- Handle bounces and complaints through SNS, and suppress those addresses so they are not mailed again.

Do not hardcode any current hosting domain into the mailer or the email templates. Companies do not set up their own SMTP or SES accounts. A custom sending domain per company is backlog, not 1.10.0. The same system mailer can later be reused to email invoices or invites; that is also not part of 1.10.0.

`paymentReminders.enabled` stays default **off**. It cannot be set to true until (1) the system mailer is configured in env (`MAIL_PROVIDER`, AWS region/credentials, `MAIL_FROM_ADDRESS`, `APP_NAME`), (2) the from-address is verified on the product domain and the account is out of the SES sandbox, (3) the company has a reply-to address (the setting, or the owner-email default), and (4) a test send for that company has succeeded. If env credentials are later removed, automatic sending cannot stay on. Manual reminder send uses the same mailer and is also blocked until those conditions are met.

**Channels (backlog).** The adapter should be designed as a **channel** abstraction (email now; other channels later), not an SES-only send call. Amazon SES sends email only. WhatsApp is not part of SES. A WhatsApp channel can later be added through **AWS End User Messaging Social**, behind the same channel interface. That is backlog, not 1.10.0. It needs a Meta business verification and approved message templates before it can go live.

## 4. Credit notes and the ledger (1.7.0)

On publish, in the same transaction as the document write:
- Allocate `CN-…` if needed.
- Recompute the invoice's `creditedAmount` from all active credit notes including this one; reject if outstanding would go negative.
- Post journal lines that reverse the credited portion of the invoice: Dr income (per line account / default income), Dr 2100 VAT if the credit includes tax, Cr 1100 debtors, at the invoice's rate, in base minor units. Residual cents follow the Phase 1 rule. `sourceKey` is `credit_note:<id>:v<n>`.
- Foreign credit notes use the original invoice rate (the credit unwinds that invoice, it does not strike a new FX rate).

Void (owner/admin) reverses the journal on the void date and un-applies the amount from the invoice. Soft delete of a published, non-void credit note reverses on the original issue date, same as invoices. Restore re-posts if the invoice is still there and the amount still fits.

Unallocated or multi-invoice credit notes are out of 1.7.0. A credit note always targets one published invoice of the same customer and currency.

Payments still cannot overpay an invoice; the cap is the remaining outstanding after credits. Credit notes cannot exceed remaining outstanding after payments.

## 5. Terms, credit limits and age analysis (1.7.0)

- New invoices: if the customer has `paymentTermsDays`, that sets the default due date; otherwise the company default. An explicit due date on the invoice still wins.
- Credit limit is optional. It is shown on the customer and on aged receivables (outstanding vs limit, per the customer's currency). Publishing an invoice that would take that currency's outstanding over the limit **warns** in the UI and on the API response, but does not block. Owners and admins can still publish. This is the decided behaviour (and is what PR #18 implements).
- Age analysis stays on Reports (and `get_receivables`): same buckets, as-of date, split by currency, now net of credit notes, with optional credit-limit columns. No new ageing report is invented.

## 6. Time, agreements, recurring invoices and hours

### 6.1 Time entries and ad hoc billable hours (1.8.0)

1.8.0 ships time entries and ad hoc billable hours only. Internal time is non-billable by default so it cannot be invoiced by accident. The assistant can propose time entries; a person confirms them. Billing an ad hoc entry sets `invoiceId` / `billedAt` and the entry cannot be billed again. Removing the line, or voiding or deleting the invoice, clears the mark (restore of a published invoice sets it again).

Agreement-linked time waits for 1.9.0. 1.8.0 may store `agreementId` / `periodId` as empty and should not assume rollover or overage behaviour.

### 6.2 Agreements, periods, recurring invoices and hours reports (1.9.0)

**Period alignment.** Periods follow calendar months. A monthly agreement uses 1 Jan–31 Jan, 1 Feb–28/29 Feb, and so on. A quarterly agreement uses calendar quarters: 1 Jan–31 Mar, 1 Apr–30 Jun, 1 Jul–30 Sep, 1 Oct–31 Dec.

**Prorated first (and last) period.** If `startDate` is not the first day of the calendar period, the first period runs from `startDate` through the last day of that month (or quarter). If `endDate` is set and is not the last day of a calendar period, the last period runs from the first day of that month or quarter (or `startDate`, if later) through `endDate`. Full periods in between use the full allowance and fee.

Allowance and fee are prorated by inclusive day count:

```
fraction      = daysInPeriod / daysInFullCalendarPeriod
hoursAllowed  = round to 2 decimal places (agreement.hours × fraction)
fee           = roundMoney(agreement.fee × fraction)
```

`daysInPeriod` includes both `startsOn` and `endsOn`. `daysInFullCalendarPeriod` is the number of days in that calendar month or quarter.

Example: start 15 Jan 2026, monthly, 10 hours, fee R10,000. January has 31 days. The first period is 15–31 Jan (17 days). fraction = 17/31. hoursAllowed = 10 × 17/31 = 5.48 hours. fee = 10,000 × 17/31 = R5,483.87.

Hours rolled in from the previous period are added in full; they are not prorated. Only that period's own allowance and fee are prorated.

**Rollover.** Configured per agreement. `mode: "expire"` — unused hours (`hoursAllowed + hoursRolledIn − hoursUsed`, if positive) expire when the period closes. `mode: "rollover"` — unused hours roll into the next period as `hoursRolledIn`. If `limitHours` is set, rolled hours are capped at that limit and the rest expire. If `limitHours` is null or blank, there is no cap.

**Overage.** Hours used above `hoursAllowed + hoursRolledIn` are overage. They are **not** billed when the period closes. They are added as a line on the **next** recurring invoice (the following period's invoice), at `overageRate`, or at the standard `rate` if no overage rate is set. If the agreement has ended and no further period invoice is scheduled, generate one more invoice for the overage only, using that agreement's draft / auto-publish setting.

**Recurring invoices.** Each agreement has `autoPublish` (default false). Generated invoices are drafts unless that agreement's setting is true. Auto-publish is an app/scheduler action, not an assistant action.

**Hours reports.** Per customer, agreement and period: allowed, used, remaining, rolled in, expired, overage, and billed hours. Time used against an agreement counts toward the period; ad hoc billable hours are reported separately.

## 7. API, UI and MCP

1.7.0
- Customer create/update accept `paymentTermsDays` and `creditLimit`.
- Credit note CRUD, publish, void, PDF/HTML, restore kind `creditNote`.
- Invoice outstanding and statements include credits. Invoice UI shows credited amount and an “Issue credit note” action.
- Reports aged receivables and outstanding invoices subtract credits and can show the limit.
- MCP: read `list_credit_notes` / `get_credit_note`; write keys can `create_draft_credit_note` (never auto-publish). `get_receivables` stays and includes credits.

1.8.0 adds time entries (CRUD, filters, invoice-from-unbilled-hours) and MCP `list_time_entries` / `get_time_entry` / `create_time_entry`. The assistant proposes time entries; it does not invoice them. 1.9.0 adds agreement and recurring resources on the same pattern (draft-safe assistant tools, API keys follow role permissions). Reminder tools wait for 1.10.0.

## 8. Testing

Backend tests run in `node:22-alpine` on the Mac, as today (`node --test` against the in-memory FakeFirestore). 1.7.0 should cover: customer terms defaulting the invoice due date; credit limit warning without a hard block; publishing a full and a partial credit note; ledger lines (debtors, income, VAT) and a trial-balance still at zero; outstanding, ageing, statements and payments caps after a credit; void/delete/restore of a credit note; rejecting a credit that exceeds remaining outstanding; rejecting void of an invoice that still has a credit note. 1.8.0 adds time entries, invoicing ad hoc hours, and the once-only billed mark (including void/delete/restore of the invoice). 1.9.0 covers proration, rollover, overage-on-the-next-invoice, and draft vs auto-publish. 1.10.0 covers the reminder schedule (default off), logging, no duplicate steps, manual send, the SES mailer adapter (`MAIL_PROVIDER=ses`, AWS region/credentials, `MAIL_FROM_ADDRESS`, `APP_NAME`), company reply-to and test send, bounce/complaint suppression, and refusing to enable automatic reminders until the product domain/from-address are configured, the account is out of the SES sandbox, reply-to is set, and a test send has succeeded.

## 9. Decisions (answered 13 Nov 2026)

1. **Rollover of unused agreement hours?**
   Configurable per agreement. Mode is either **expire** or **roll over**. Roll over has an optional limit in hours; a blank limit means no limit.

2. **How is overage billed?**
   Add overage as a line on the **next** recurring invoice, at the overage rate, or the standard rate if none is set. Do not bill overage at period close.

3. **Recurring invoices: draft or auto-publish?**
   A setting on each agreement. Default remains drafts (`autoPublish: false`) unless the agreement turns auto-publish on.

4. **What do payment reminders do?**
   Reminders can email automatically on a company schedule (days before or after the due date). The setting defaults to **off**, so nothing emails customers until it is turned on. Each send is logged against the invoice; the same step is never sent twice. Also include a manual send and the overdue list. Invoices and statements stay manual. Mail is sent by Amazon SES, behind a swappable mailer adapter, from one system address (`MAIL_PROVIDER=ses`, AWS region and credentials, `MAIL_FROM_ADDRESS`, and `APP_NAME` in env). The From display name is the company name. Product branding in the email comes from `APP_NAME`. Reply-To is a company setting that defaults to the owner's email. Companies do not set up their own SMTP or SES. A product domain (verified in SES with DKIM, account out of the sandbox, bounces/complaints via SNS with suppression) is needed before reminders go live; do not hardcode a hosting domain. Automatic reminders cannot be enabled until a reply-to is set and a test send has succeeded. A custom sending domain per company is backlog. A WhatsApp channel (AWS End User Messaging Social, Meta verification and approved templates) is also backlog, behind the same channel abstraction. SES itself sends email only.

5. **Credit limit: warn or block publish?**
   Warn; owners and admins can still publish. This is what PR #18 already does. No change to 1.7.0.

6. **Must a credit note always link to one invoice?**
   Yes in 1.7.0: same customer and currency, applied immediately to that invoice. Unallocated or multi-invoice credits can wait. No change to 1.7.0.

7. **How do agreement periods line up?**
   Calendar months (and calendar quarters when the agreement period is quarterly). A start date in the middle of a month gives a prorated first period; see section 6.2 for the day-count formula and a worked example.

## 10. Slice plan

| Slice | Scope | Notes |
| --- | --- | --- |
| **1.7.0** | Credit notes (ledger reversals, apply to one invoice, void/delete/restore, PDF). Customer payment terms and credit limits. Debtors age analysis extended (credits + limits). Statements include credits. | PR #18. Uses decided behaviour for questions 5 and 6. No reminders. No catch-up/backfill (credits only apply when a user issues one). |
| **1.8.0** | Time entries (internal, manual or assistant). Ad hoc billable hours, invoice them, mark billed so they cannot be billed twice. | Does not depend on agreement code. |
| **1.9.0** | Agreements, recurring invoices, agreement periods (hours used and remaining, proration, rollover, overage on the next invoice), hours reports. | Decisions 1, 2, 3 and 7 are recorded above. |
| **1.10.0** | Payment reminders: overdue list, manual send, company schedule default off, log each send, no duplicate steps. Amazon SES behind a swappable mailer adapter, configured from env (`MAIL_PROVIDER=ses`, AWS region and credentials, `MAIL_FROM_ADDRESS`, `APP_NAME`). From display name is the company name. Reply-To is a company setting defaulting to the owner's email. Test send in Settings. Prerequisites: verified product domain with DKIM, SES out of sandbox, SNS bounce/complaint handling with suppression. Automatic reminders stay disabled until reply-to is set and a test send has succeeded. Custom sending domain per company, and a WhatsApp channel via AWS End User Messaging Social (Meta verification and approved templates), are backlog. | Decision 4 is recorded above. The app does not send email today (invites are copy-link; invoices are not emailed). SES sends email only. |

Do not merge or deploy a slice until Jared authorises it. Firestore rules do not need new match blocks for these collections (the existing catch-all already allows member reads and denies client writes); any new composite indexes must be real composites, not single-field ones.

## 11. Decisions already taken (memory / this brief)

- Build on existing customers; do not replace them.
- The retainer feature is called **Agreements**, and an agreement links to a recurring billable service.
- Time tracking in this phase is internal time entries only (manual or assistant). Jira/GitHub sync, task management and CRM are out of scope.
- Ad hoc billable hours outside an agreement can be entered manually, invoiced, and marked billed.
- Credit limits warn; owners and admins can still publish (1.7.0 / PR #18).
- Production is on 1.6.1. Phase 1 ledger posting is already live.
