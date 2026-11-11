# Invoice

South African invoicing app: Nuxt 4 + Nuxt UI frontend, Express 5 API, Firestore, Gotenberg PDFs.

Two modes:

- **Anonymous editor** (`/`): single-invoice editor stored in the browser, PDF via Gotenberg. No sign-in.
- **Accounting dashboard** (`/dashboard`): Google sign-in, multi-tenant (companies), a simple Wave-style accounting app.

## Dashboard features

Everything is scoped per company. All writes go through the API (server-side checks); `firestore.rules` allows members to read their company's data and denies all client writes.

| Area | What is built |
| --- | --- |
| Company settings | Name, logo (≤300 KB), address/legal/tax details, invoice and quote prefixes and next numbers, default currency, enabled currencies (ZAR, USD, EUR, GBP), payment terms, quote validity, multiple plain-text bank accounts (optionally tagged per currency), optional VAT (off by default) |
| Members | List, invite by link (optionally bound to an email), change role (owner/admin/member), remove, leave. At least one owner always remains; only owners grant owner. |
| Customers | Create, edit, delete, default currency, tax number, statements per currency |
| Products and services | Catalogue (price, currency, taxable, active) usable on invoice and quote lines |
| Invoices | Draft → finalize (number assigned at finalize), edit, duplicate, void, delete (only when there are no payments), PDF/HTML, ZAR/USD per invoice |
| Quotes | Own number sequence (`QUO-`), sent/accepted/declined/expired, convert to a draft invoice (once), duplicate, PDF |
| Payments | Date, method, reference, note; partial payments; void (kept for audit) or delete; always in the invoice currency; overpayment rejected |
| Expenses | Date, vendor, category, amount, currency, notes, optional receipt (PDF/image ≤700 KB stored in Firestore); categories with defaults, rename and delete (blocked when used) |
| Reports | Date range; per currency, no FX conversion: income by month, invoiced by month, income by customer, outstanding invoices, aged receivables (as of range end), expenses by category, cash-basis P&L; CSV export |
| Home | Outstanding, overdue, this month's income and expenses per currency |
| AI assistant | Read-only; can list invoices and read a financial summary. It never creates or changes money records. |

Out of scope for now (the model leaves room): Paystack/Wise integrations, recurring invoices, emailing invoices, bank feeds.

### Design decisions

- **Numbering:** `companies/{id}/counters/{invoices|quotes}`, allocated inside a Firestore transaction. Drafts have no number. If the admin lowers "next number", numbers already in use are skipped.
- **Issuer snapshot:** a finalized invoice freezes the company details and bank accounts for its currency. Drafts and quotes render the live settings.
- **Totals:** `paidAmount` on an invoice is recomputed from its payments in a transaction on every payment change. A paid invoice's currency is locked, and its total can't drop below the amount paid.
- **VAT:** off unless the company is VAT registered. When it's off, documents show no VAT lines.
- **No row caps:** list and report queries page through Firestore in batches of 500 (`backend/lib/db.js`).
- **Multi-currency:** amounts are never summed across currencies. Every total is grouped by currency.

## Running locally

Requirements: Docker. You don't need Node on the host.

```bash
cp .env.example .env    # fill in OPENAI_* / GOTENBERG_HOSTNAME
```

**With real Firebase:** set `FIREBASE_PROJECT_ID`, `FIREBASE_SERVICE_ACCOUNT_JSON` and the `NUXT_PUBLIC_FIREBASE_*` values, then:

```bash
docker compose up --build
```

**With Firebase emulators (no credentials):**

```bash
docker compose -f docker-compose.yml -f docker-compose.emulators.yml up --build
```

This uses the `demo-invoice` project with the Auth and Firestore emulators. Data is kept in `./.emulator-data` (git-ignored).

- App: http://localhost:3000/dashboard
- Emulator UI: http://localhost:4000

Google sign-in shows the emulator's fake account picker.

**Tests and builds:**

```bash
# backend unit and HTTP tests (in-memory Firestore fake)
docker run --rm -v "$PWD/backend":/app -v invoice_test_nm:/app/node_modules -w /app node:22-alpine sh -c "npm install && npm test"

# frontend production build
docker run --rm -v "$PWD/frontend":/app -v invoice_web_build_nm:/app/node_modules -w /app node:22-alpine sh -c "npm ci --legacy-peer-deps && npm run build"
```

Production: `docker compose -f docker-compose.prod.yml up --build`.

## Environment variables

See `.env.example`. New on this branch (local development only):

| Variable | Used by | Purpose |
| --- | --- | --- |
| `FIRESTORE_EMULATOR_HOST` | API | Use the Firestore emulator. Together with `FIREBASE_PROJECT_ID`, no service account is needed. |
| `FIREBASE_AUTH_EMULATOR_HOST` | API | Verify ID tokens against the Auth emulator |
| `NUXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` | Web | Connect the browser Auth SDK to the emulator, e.g. `http://localhost:9099` |

Leave all three unset in production.

## Firestore layout

`companies/{companyId}` with these subcollections:

- `members`, `invites`, `counters`, `customers`, `products`, `invoices`, `quotes`, `payments`, `expenses`, `expenseCategories`, `expenseReceipts`, `auditLog`

Deploy `firestore.rules` and `firestore.indexes.json` with the Firebase CLI when you go live.
