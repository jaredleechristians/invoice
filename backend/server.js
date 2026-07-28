const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { parseAssistantPayload } = require("./parseAssistant");

const PORT = Number(process.env.PORT || 8787);

// Loaded from .env via Docker Compose:
// OPENAI_API_KEY, OPENAI_API_HOSTNAME, GOTENBERG_HOSTNAME
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_API_HOSTNAME = (
  process.env.OPENAI_API_HOSTNAME || ""
).replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "openrouter/free";

const GOTENBERG_HOSTNAME = (
  process.env.GOTENBERG_HOSTNAME || ""
).replace(/\/+$/, "");

if (!GOTENBERG_HOSTNAME) {
  console.warn("GOTENBERG_HOSTNAME is not set");
}
if (!OPENAI_API_HOSTNAME) {
  console.warn("OPENAI_API_HOSTNAME is not set");
}
if (!OPENAI_API_KEY) {
  console.warn("OPENAI_API_KEY is not set");
}

const GOTENBERG_CONVERT_URL = `${GOTENBERG_HOSTNAME}/forms/chromium/convert/html`;
const OPENAI_CHAT_URL = `${OPENAI_API_HOSTNAME}/api/chat/completions`;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});

const app = express();
app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    gotenbergHostname: GOTENBERG_HOSTNAME,
    openaiApiHostname: OPENAI_API_HOSTNAME,
    model: OPENAI_MODEL,
    openaiAuthConfigured: Boolean(OPENAI_API_KEY),
  });
});

app.post("/api/pdf", upload.any(), async (req, res) => {
  try {
    const form = new FormData();

    for (const file of req.files || []) {
      const blob = new Blob([file.buffer], {
        type: file.mimetype || "application/octet-stream",
      });
      form.append("files", blob, file.originalname || "index.html");
    }

    const passthrough = [
      "paperWidth",
      "paperHeight",
      "marginTop",
      "marginBottom",
      "marginLeft",
      "marginRight",
      "printBackground",
      "preferCssPageSize",
      "emulatedMediaType",
    ];
    for (const key of passthrough) {
      if (req.body?.[key] != null) form.append(key, String(req.body[key]));
    }

    const upstream = await fetch(GOTENBERG_CONVERT_URL, {
      method: "POST",
      body: form,
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(120_000),
    });

    const buffer = Buffer.from(await upstream.arrayBuffer());
    if (!upstream.ok) {
      res.status(upstream.status);
      res.setHeader(
        "Content-Type",
        upstream.headers.get("content-type") || "text/plain"
      );
      return res.send(buffer);
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      upstream.headers.get("content-disposition") ||
        'attachment; filename="invoice.pdf"'
    );
    res.send(buffer);
  } catch (err) {
    console.error("PDF proxy error:", err);
    res.status(502).type("text/plain").send(`Gotenberg proxy error: ${err.message}`);
  }
});

function formatInvoiceDate(date) {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function buildSystemPrompt() {
  const now = new Date();
  const todayLabel = formatInvoiceDate(now);
  const in7 = formatInvoiceDate(addDays(now, 7));
  const in14 = formatInvoiceDate(addDays(now, 14));
  const in30 = formatInvoiceDate(addDays(now, 30));

  return `You are an invoice assistant for a South African invoice editor (amounts display as ZAR; no VAT on this invoice).

CRITICAL: Respond with ONLY one valid JSON object. No markdown fences. No prose outside JSON.
Escape newlines in strings as \\n.

Response shape:
{
  "message": "short reply for the user",
  "invoice": null
}

"invoice" is either null (Q&A / no edits) or a PARTIAL patch. The editor merges the patch onto the live form; omitted fields are preserved.

Schema:
- invoiceNumber, issueDate, dueDate, notes, legal: strings
- billTo / billFrom: { name, details }
- banking: { bank, accountName, accountNumber, branchCode, reference }
- items: [{ description, note, qty, unitPrice }] with qty/unitPrice as numbers

Today's date for calculations: ${todayLabel}

=== Step 1: Decide intent ===
A) CREATE — user wants a new invoice built from their description.
   Signals: "create", "generate", "make an invoice", "invoice <name> for…", "new invoice", or a full brief with customer + work + amounts even without the word create.
B) UPDATE — user wants to change the current invoice.
   Signals: "change", "update", "set", "add a line", "remove", "rename bill to", "move due date", tweaks to existing fields.
C) ANSWER — questions only, no form changes → "invoice": null.

If the message mixes both (e.g. create then also set a note), apply create fields first, then any extra updates in the same patch.

=== Step 2: Shared field mapping (create and update) ===
- Customer / client name → billTo.name; address, email, VAT, PO, etc. → billTo.details ("" if unknown).
- Seller / "from" changes → billFrom (rare); otherwise leave billFrom alone.
- Work / services → items[].description; period, horse name, location, etc. → note.
- Lump sum ("totaling 1500", "charge 950") → one item, qty 1, unitPrice = that number.
- Unit rates ("10 hours at 75/hour", "3 sessions at 120 each") → qty = count, unitPrice = rate.
- Separate cost components ("labour … and materials …") → separate line items unless user says to combine.
- Strip $, R, commas, and words like "dollars"; store plain numbers. Do not FX-convert.
- Relative due dates from today (${todayLabel}) unless user gives an explicit issue date:
  - "due in N days" / "Net N" → dueDate = issueDate + N days (same style, e.g. "${in14}")
  - "due on receipt" → dueDate "On receipt"; may add payment terms to notes
  - explicit calendar dates → use that human-readable form
- On create, set issueDate to ${todayLabel} unless the user specifies otherwise.
- "unpaid" / paid status → NO status field; put e.g. "Status: Unpaid" in notes.
- Tax / VAT / "plus applicable tax" → do NOT add tax lines or inflate totals; say in message that this invoice is ex-VAT.
- invoiceNumber changes → banking.reference should match (or omit banking; editor syncs).
- Clearing a string → set it to "".

=== Step 3: What to include in the patch ===
CREATE:
- Always include: billTo, items (FULL replacement array — wipe old demo lines), issueDate, dueDate.
- Include notes only if useful (terms, unpaid, extras).
- Do NOT touch billFrom, banking (except reference if number changes), or legal unless asked.

UPDATE:
- Include ONLY fields the user asked to change.
- Adding/removing/replacing lines → send the full resulting items array (start from Current invoice items).
- Do not resend unchanged unit prices, footer, banking, etc.

=== Examples ===

Create:
User: "Create an invoice for John Smith for website design totaling $1,500, due in 14 days."
{"message":"Created invoice for John Smith — website design R1,500, due ${in14}.","invoice":{"billTo":{"name":"John Smith","details":""},"issueDate":"${todayLabel}","dueDate":"${in14}","items":[{"description":"Website design","note":"","qty":1,"unitPrice":1500}]}}

Create (multi-line):
User: "Generate an invoice for ABC Construction for July maintenance: 10 hours labour at $75/hour and materials $320."
{"message":"Created invoice for ABC Construction with labour and materials.","invoice":{"billTo":{"name":"ABC Construction","details":""},"issueDate":"${todayLabel}","dueDate":"${todayLabel}","items":[{"description":"Labour — July maintenance","note":"10 hours","qty":10,"unitPrice":75},{"description":"Materials — July maintenance","note":"","qty":1,"unitPrice":320}]}}

Create (tax + Net 30 — ignore tax):
User: "Invoice Acme Ltd for monthly IT support. Charge $950 plus tax, due in 30 days."
{"message":"Created invoice for Acme Ltd (R950 ex-VAT; this editor does not add tax), due ${in30}.","invoice":{"billTo":{"name":"Acme Ltd","details":""},"issueDate":"${todayLabel}","dueDate":"${in30}","items":[{"description":"Monthly IT support","note":"","qty":1,"unitPrice":950}]}}

Create (sessions + unpaid + due on receipt):
User: "Invoice Sarah Johnson for 3 consulting sessions at $120 each. Mark unpaid and due on receipt."
{"message":"Created invoice for Sarah Johnson — 3 sessions at R120, unpaid, due on receipt.","invoice":{"billTo":{"name":"Sarah Johnson","details":""},"issueDate":"${todayLabel}","dueDate":"On receipt","notes":"Status: Unpaid. Payment due on receipt.","items":[{"description":"Consulting session","note":"","qty":3,"unitPrice":120}]}}

Update (partial):
User: "Change bill to TKP Trading, Bassonia."
{"message":"Updated bill to TKP Trading.","invoice":{"billTo":{"name":"TKP Trading","details":"Bassonia"}}}

Update (add a line — return full items list based on Current invoice):
User: "Add a race win line for Frangipani at 3000."
{"message":"Added Race Win — Frangipani.","invoice":{"items":[{"description":"(keep every existing Current invoice item unchanged)"},{"description":"Race Win","note":"Frangipani","qty":1,"unitPrice":3000}]}}

Update (dates only):
User: "Make it due in 7 days from today."
{"message":"Set due date to ${in7}.","invoice":{"dueDate":"${in7}"}}

Answer only:
User: "What is the total?"
{"message":"<state the total from Current invoice>","invoice":null}

Be concise in message. Never embed the invoice JSON inside message.`;
}

app.post("/api/chat", async (req, res) => {
  try {
    const { messages = [], invoice = null } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }

    const apiKey = OPENAI_API_KEY || "";
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": BROWSER_UA,
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const payload = {
      model: OPENAI_MODEL,
      stream: false,
      messages: [
        {
          role: "system",
          content:
            buildSystemPrompt() +
            "\n\nCurrent invoice JSON:\n" +
            JSON.stringify(invoice ?? {}, null, 2),
        },
        ...messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content ?? ""),
        })),
      ],
    };

    const upstream = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120_000),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      return res
        .status(upstream.status)
        .type("application/json")
        .send(text || JSON.stringify({ error: `OpenAI HTTP ${upstream.status}` }));
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Invalid JSON from OpenAI API", raw: text });
    }

    const content =
      data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text ?? "";

    const parsed = parseAssistantPayload(String(content || ""));

    res.json({
      content,
      message: parsed.message,
      invoice: parsed.invoice,
      model: data.model || OPENAI_MODEL,
      raw: data,
    });
  } catch (err) {
    console.error("Chat proxy error:", err);
    res.status(502).json({ error: `OpenAI proxy error: ${err.message}` });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API          http://0.0.0.0:${PORT}/`);
  console.log(`PDF proxy    POST /api/pdf → ${GOTENBERG_CONVERT_URL}`);
  console.log(`Chat proxy   POST /api/chat → ${OPENAI_CHAT_URL} (${OPENAI_MODEL})`);
});
