const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function buildOpenRouterChatUrl(hostname) {
  const base = String(hostname || "").replace(/\/+$/, "");
  if (!base) return "";
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  if (/\/api$/i.test(base)) return `${base}/v1/chat/completions`;
  return `${base}/api/v1/chat/completions`;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_API_HOSTNAME = (
  process.env.OPENAI_API_HOSTNAME || "https://openrouter.ai/api"
).replace(/\/+$/, "");
const OPENAI_MODEL = process.env.OPENAI_MODEL || "openrouter/free";
const CHAT_TIMEOUT_MS = Number(process.env.OPENAI_CHAT_TIMEOUT_MS || 55_000);
const OPENAI_CHAT_URL = buildOpenRouterChatUrl(OPENAI_API_HOSTNAME);

function extractAssistantMessage(data) {
  const choice = data?.choices?.[0] || {};
  const message = choice.message || {};
  if (typeof message.content === "string") return message;
  return message;
}

async function chatCompletion({ messages, tools }) {
  if (!OPENAI_CHAT_URL) {
    const err = new Error("OPENAI_API_HOSTNAME is not configured");
    err.status = 503;
    throw err;
  }
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": BROWSER_UA,
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "Invoice",
  };
  if (OPENAI_API_KEY) headers.Authorization = `Bearer ${OPENAI_API_KEY}`;

  const body = {
    model: OPENAI_MODEL,
    stream: false,
    temperature: 0.2,
    messages,
  };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }

  const upstream = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    const err = new Error(`Chat upstream HTTP ${upstream.status}: ${text.slice(0, 300)}`);
    err.status = upstream.status === 502 || upstream.status === 504 ? 504 : upstream.status;
    throw err;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const err = new Error("Invalid JSON from chat upstream");
    err.status = 502;
    throw err;
  }

  return extractAssistantMessage(data);
}

module.exports = {
  chatCompletion,
  OPENAI_MODEL,
  OPENAI_CHAT_URL,
};
