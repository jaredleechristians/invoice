const express = require("express");
const cors = require("cors");
const multer = require("multer");

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

const SYSTEM_PROMPT = `You are an invoice assistant for a South African invoice editor.
You can answer questions and update invoice fields when the user asks.

Always respond with ONLY a single JSON object (no markdown fences) using this shape:
{
  "message": "short natural-language reply for the user",
  "invoice": null
}

Rules:
- If the user asks to change the invoice, set "invoice" to the FULL updated invoice object (merge their request into the current invoice).
- If no field changes are needed, set "invoice" to null.
- Keep amounts excluding VAT. Do not add VAT calculations.
- Preserve existing values unless the user asks to change them.
- Line items use: description, note, qty, unitPrice (numbers).
- banking uses: bank, accountName, accountNumber, branchCode, reference.
- billTo / billFrom use: name, details (details may include newlines).
- Dates can stay in human-readable form (e.g. "27 Jul 2026").
- Be concise in "message".`;

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
            SYSTEM_PROMPT +
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

    res.json({
      content,
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
