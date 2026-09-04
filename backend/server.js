const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { parseAssistantPayload } = require("./parseAssistant");

const PORT = Number(process.env.PORT || 8787);

// Loaded from .env via Docker Compose (OpenRouter):
// OPENAI_API_KEY, OPENAI_API_HOSTNAME, OPENAI_MODEL, GOTENBERG_HOSTNAME
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_API_HOSTNAME = (
  process.env.OPENAI_API_HOSTNAME || "https://openrouter.ai/api"
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

/** OpenRouter chat completions URL from a base like https://openrouter.ai/api. */
function buildOpenRouterChatUrl(hostname) {
  const base = String(hostname || "").replace(/\/+$/, "");
  if (!base) return "";
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  if (/\/api$/i.test(base)) return `${base}/v1/chat/completions`;
  return `${base}/api/v1/chat/completions`;
}

const OPENAI_CHAT_URL = buildOpenRouterChatUrl(OPENAI_API_HOSTNAME);

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

  return `Invoice assistant for a South African editor (ZAR display, no VAT).

Reply with ONLY JSON (no markdown): {"message":"short reply","invoice":null|object}
"invoice" is a PARTIAL patch merged onto the live form; omit unchanged fields.
Schema: invoiceNumber, issueDate, dueDate, notes, legal, billTo{name,details}, billFrom{name,details}, banking{bank,accountName,accountNumber,branchCode,reference}, items[{description,note,qty,unitPrice}].
qty/unitPrice must be numbers. Escape newlines as \\n. Today: ${todayLabel}.

FULL BRIEF vs SHORT UPDATE:
- If the latest user message includes multiple sections (e.g. Bill From, Bill To, line items, dates, notes, banking), treat it as a FULL CREATE/REPLACE: include EVERY provided section in one invoice patch (billTo, billFrom, items, issueDate, dueDate, invoiceNumber, notes, banking as given). Do not stop after the first section.
- If the message is a short single change, patch ONLY that section.
- In "message", briefly confirm what was applied. If anything important is still missing, ask for it in one short sentence; otherwise say it looks complete.
- CLARIFY with invoice:null when required details are missing or ambiguous. ANSWER with invoice:null for questions.

CREATE/UPDATE rules:
- Line items: copy user lines exactly; replace the full items array when setting items; never invent services or keep Current demo lines.
- Parse "Name – Qty: 1 – Unit Price: R12,500.00" → {description, note:"", qty:1, unitPrice:12500}. Strip R/$/commas. Ignore totals/tax/SWIFT/currency.
- Relative due dates from today; "due on receipt" → "On receipt". Tax → keep ex-VAT and mention that.
- Match banking.reference to invoiceNumber when either is set.

Examples:
Full brief → include billTo, billFrom, items, dates, notes, banking together in one invoice object.
Short → {"message":"Updated bill to Acme.","invoice":{"billTo":{"name":"Acme Pty Ltd","details":"Cape Town"}}}
Clarify → {"message":"Who should I bill, and what are the line items or total?","invoice":null}

Never reply with only "Done". Never put invoice JSON inside message.`;
}

function extractChatContent(data) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};

  const fromParts = (value) => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") {
            return part.text || part.content || part.output_text || "";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return "";
  };

  const candidates = [
    fromParts(message.content),
    fromParts(message.reasoning_content),
    fromParts(message.reasoning),
    fromParts(choice.text),
    fromParts(choice.content),
    fromParts(data?.output_text),
    fromParts(data?.content),
  ];

  return candidates.map((c) => String(c || "").trim()).find(Boolean) || "";
}

// Stay under typical Cloudflare ~100s proxy limits.
const CHAT_TIMEOUT_MS = Number(process.env.OPENAI_CHAT_TIMEOUT_MS || 55_000);

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
      // Recommended by OpenRouter when calling their API directly.
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Invoice",
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const upstream = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: OPENAI_MODEL,
        stream: false,
        temperature: 0.1,
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
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      const looksLikeCf =
        upstream.status === 502 ||
        upstream.status === 504 ||
        /cloudflare|timeout|gateway/i.test(text);
      return res.status(upstream.status === 502 || upstream.status === 504 ? 504 : upstream.status).json({
        error: looksLikeCf
          ? "Chat upstream timed out or returned a gateway error (often Cloudflare). Try a shorter request or again in a moment."
          : `Chat upstream HTTP ${upstream.status}`,
        detail: text.slice(0, 500),
      });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "Invalid JSON from chat upstream",
        detail: text.slice(0, 500),
      });
    }

    const content = extractChatContent(data);
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
    const timedOut =
      err?.name === "TimeoutError" ||
      err?.name === "AbortError" ||
      /aborted|timeout/i.test(String(err?.message || ""));
    res.status(timedOut ? 504 : 502).json({
      error: timedOut
        ? `Chat request timed out after ${Math.round(CHAT_TIMEOUT_MS / 1000)}s. The model may be slow — try again with a shorter prompt.`
        : `OpenAI proxy error: ${err.message}`,
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`API          http://0.0.0.0:${PORT}/`);
  console.log(`PDF proxy    POST /api/pdf → ${GOTENBERG_CONVERT_URL}`);
  console.log(`Chat proxy   POST /api/chat → ${OPENAI_CHAT_URL} (${OPENAI_MODEL})`);
});
