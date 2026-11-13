# Invoice

South African invoicing app: Nuxt 4 + Nuxt UI frontend, Express 5 API, Firestore, Gotenberg PDFs.

Two modes:

- **Anonymous editor** (`/`): single-invoice editor stored in the browser, PDF via Gotenberg. No sign-in.
- **Accounting dashboard** (`/dashboard`): Google sign-in, multi-tenant (companies), a simple Wave-style accounting app.

## Dashboard features

Everything is scoped per company. All writes go through the API (server-side checks); `firestore.rules` allows members to read their company's data and denies all client writes.

| Area | What is built |
| --- | --- |
| Company settings | Name, logo (≤300 KB), address/legal/tax details, invoice, quote and credit note prefixes and next numbers, default currency, enabled currencies (ZAR, USD, EUR, GBP), payment terms, quote validity, multiple plain-text bank accounts (optionally tagged per currency), optional VAT (off by default) |
| Members | List, invite by link (optionally bound to an email), change role (owner/admin/member), remove, leave. At least one owner always remains; only owners grant owner. |
| Customers | Create, edit, delete, default currency, tax number, optional payment terms and credit limit, statements per currency |
| Products and services | Catalogue (price, currency, taxable, active) usable on invoice and quote lines |
| Invoices | Draft → finalize (number assigned at finalize), edit, duplicate, void, delete (only when there are no payments or credit notes), PDF/HTML, ZAR/USD per invoice |
| Quotes | Own number sequence (`QUO-`), sent/accepted/declined/expired, convert to a draft invoice (once), duplicate, PDF |
| Payments | Date, method, reference, note; partial payments; void (kept for audit) or delete; always in the invoice currency; overpayment rejected |
| Credit notes | Linked to one published invoice; draft → publish (own CN- number); reduce outstanding and post a ledger reversal; void/delete/restore; PDF/HTML |
| Expenses | Date, vendor, category, amount, currency, notes, optional receipt (PDF/image ≤700 KB stored in Firestore); categories with defaults, rename and delete (blocked when used) |
| Reports | Date range; per currency, no FX conversion: income by month, invoiced by month, income by customer, outstanding invoices, aged receivables (as of range end, net of credit notes, with credit limits), expenses by category, cash-basis P&L; CSV export |
| Home | Outstanding, overdue, this month's income and expenses per currency |
| AI assistant | Answers questions from live data and can **propose** new customers, products, expenses, draft invoices/quotes, payments and simple field updates. Every write is shown as a confirmation card and only saved when the user presses Confirm. Never finalizes, voids or deletes. |

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

- `members`, `invites`, `counters`, `customers`, `products`, `invoices`, `quotes`, `payments`, `creditNotes`, `expenses`, `expenseCategories`, `expenseReceipts`, `auditLog`, `assistantActions` (pending assistant proposals; server-only)

Deletes are soft: the document stays with `deletedAt`/`deletedBy` (and an audit entry), and every list, get, report, statement, assistant and MCP tool skips it. Invoice and quote numbers are never reused. Owners and admins can undo with `POST /companies/:id/restore/:kind/:id` (kind: invoice, quote, customer, product, expense, payment, expenseCategory, bankAccount, creditNote). Deleted bank imports can't be restored; import the file again. Removing a member or revoking an invite is still a real delete.

Deploy `firestore.rules` and `firestore.indexes.json` with the Firebase CLI when you go live.

## Company assistant: how writes work

1. The model gets read tools plus `propose_*` write tools (`backend/lib/assistantActions.js`). Members whose role can't write get only the read tools.
2. A `propose_*` call never touches business data. The server resolves names (customer, product, invoice), validates the input and stores a pending proposal in `assistantActions` (30-minute expiry). If anything is ambiguous or missing (several matching customers, no currency the user actually mentioned, no amount or date, which unpaid invoice a payment is for), it returns a clarifying question for the model to ask instead.
3. The chat panel shows the proposal as a card with **Confirm** and **Cancel**. Confirm (`POST /companies/:id/assistant/actions/:actionId/confirm`) can only be used once, only by the person who asked, and only with a role that can write. It then runs the normal service function with the same validation and permission checks. Audit entries are tagged `via: "assistant"` with the `assistantActionId`.
4. There are no finalize, void or delete tools. Invoices and quotes are always created as drafts.

Models that don't emit native tool calls can reply with `{"tool": "...", "arguments": {...}}` instead (JSON fallback). Empty replies are retried.

**Model:** with `openrouter/free`, native tool calls worked in most of our trials. But some replies were empty, and once the model filled in ZAR for "a 500 expense" (the server now rejects that and asks). For reliable data entry, set `OPENAI_MODEL` to a paid model with solid function calling, e.g. `openai/gpt-4.1-mini`, `google/gemini-2.5-flash` or `anthropic/claude-haiku-4.5`.


## API keys

Personal keys for scripts and integrations: **Settings > API keys**. Any member can create keys for themselves; owners and admins see and can revoke every key in the company.

- A key works for one company and acts as the person who made it. Their membership and role are checked on every request, so removing someone stops their keys.
- **Read only**: GET requests only. **Read & write**: everything the key owner's role allows, including publish, void and delete (deletes are soft). Keys can never change company settings or bank accounts (their details print on invoices), members or invites, use the assistant, or manage keys.
- Invoices created with a key are drafts unless the request sends `finalize: true`. Writes are audit-logged with `via: "api_key"` and the `apiKeyId`.
- Format `inv_live_<43 chars>`. The full key is shown once. The server stores only an HMAC-SHA256 hash (keyed with `API_KEY_PEPPER`) and a short prefix. Optional expiry: 30, 90 or 365 days. 120 requests per key per minute (`API_KEY_RATE_LIMIT`).
- Server setup: set `API_KEY_PEPPER` (at least 32 characters, e.g. `openssl rand -hex 32`). Without it, keys are disabled. Changing it invalidates all keys.

```bash
curl -H "Authorization: Bearer inv_live_YOUR_KEY" \
  https://invoice.robotweb.dev/api/tenant/companies/YOUR_COMPANY_ID/invoices
```

The company id is shown next to each key in Settings.

## MCP server

The API serves an [MCP](https://modelcontextprotocol.io) endpoint for AI assistants (Claude, ChatGPT, Cursor and others): **`https://invoice.robotweb.dev/mcp`**. It uses Streamable HTTP, is stateless and sends JSON responses. You sign in with an API key; there is no OAuth.

**Add it as a custom connector:** URL `https://invoice.robotweb.dev/mcp`, header `Authorization: Bearer inv_live_YOUR_KEY`. The key decides the company and what the assistant may do. For example, in Cursor's `mcp.json`:

```json
{
  "mcpServers": {
    "invoice": {
      "url": "https://invoice.robotweb.dev/mcp",
      "headers": { "Authorization": "Bearer inv_live_YOUR_KEY" }
    }
  }
}
```

**Tools.** Every key gets the read tools:
`get_company`, `list_customers`, `get_customer`, `get_customer_statement`, `list_invoices`, `get_invoice`, `list_credit_notes`, `get_credit_note`, `list_quotes`, `list_products`, `get_receivables` (outstanding per customer and aged buckets), `get_reports` (income, expenses and profit by month, category and customer), `list_expenses`, `list_expense_categories`, `list_payments`, `list_bank_accounts`, `list_bank_transactions`, `get_bank_transaction_suggestions`.

**Read & write** keys also get:
`create_customer`, `create_draft_invoice`, `update_draft_invoice`, `create_draft_credit_note`, `publish_invoice`, `void_invoice`, `record_expense`, `record_payment` (published invoices only), `void_payment`, `reconcile_bank_transaction` (match an invoice, payment or expense, create an expense, mark a transfer, or ignore), `undo_bank_transaction`, `delete_invoice`, `delete_quote`, `delete_customer`, `delete_product`, `delete_expense`, `delete_payment`, `delete_bank_import` (all soft deletes), `restore_record`.

Void and delete need an owner or admin key, as in the app. No tools change settings, bank accounts, members, invites or API keys. Lists return `{ total, offset, items, nextOffset }` (25 rows by default, 100 at most). Writes are audit-logged with `via: "mcp"` and the `apiKeyId`. The key's rate limit applies.

Quick check with curl:

```bash
curl -s https://invoice.robotweb.dev/mcp \
  -H "Authorization: Bearer inv_live_YOUR_KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
