/**
 * Extract and repair assistant JSON so invoice updates still apply when the
 * model returns messy JSON (literal newlines in strings, fences, prose, etc.).
 */

function stripFences(text) {
  const trimmed = String(text || "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced?.[1] || trimmed).trim();
}

function extractBalanced(text, fromIndex = 0) {
  const start = text.indexOf("{", fromIndex);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth += 1;
    if (c === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Escape raw control chars that appear inside JSON string literals. */
function escapeControlCharsInStrings(jsonText) {
  let out = "";
  let inString = false;
  let escape = false;

  for (let i = 0; i < jsonText.length; i++) {
    const c = jsonText[i];
    if (inString) {
      if (escape) {
        out += c;
        escape = false;
        continue;
      }
      if (c === "\\") {
        out += c;
        escape = true;
        continue;
      }
      if (c === '"') {
        out += c;
        inString = false;
        continue;
      }
      if (c === "\n") {
        out += "\\n";
        continue;
      }
      if (c === "\r") {
        out += "\\r";
        continue;
      }
      if (c === "\t") {
        out += "\\t";
        continue;
      }
      out += c;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    out += c;
  }
  return out;
}

function lightRepair(jsonText) {
  return escapeControlCharsInStrings(jsonText)
    .replace(/,\s*([}\]])/g, "$1")
    .replace(/^\uFEFF/, "");
}

function tryParse(jsonText) {
  const attempts = [jsonText, lightRepair(jsonText)];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt);
    } catch {
      /* try next */
    }
  }
  return null;
}

function looksLikeInvoice(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    (typeof obj.invoiceNumber === "string" ||
      Array.isArray(obj.items) ||
      obj.billTo ||
      obj.billFrom ||
      obj.banking)
  );
}

function parseAssistantPayload(content) {
  const trimmed = String(content || "").trim();
  if (!trimmed) return { message: "", invoice: null };

  const candidate = stripFences(trimmed);
  const blob = extractBalanced(candidate) || candidate;
  let parsed = tryParse(blob);

  // Fallback: locate an "invoice" object even if the wrapper is broken.
  if (!parsed) {
    const invoiceKey = candidate.search(/"invoice"\s*:/);
    if (invoiceKey !== -1) {
      const afterColon = candidate.indexOf(":", invoiceKey);
      const invoiceBlob = extractBalanced(candidate, afterColon);
      const invoiceObj = invoiceBlob ? tryParse(invoiceBlob) : null;
      if (looksLikeInvoice(invoiceObj)) {
        const msgMatch = candidate.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        return {
          message: msgMatch
            ? JSON.parse(`"${msgMatch[1]}"`)
            : "Updated.",
          invoice: invoiceObj,
        };
      }
    }
    return { message: trimmed, invoice: null };
  }

  if (looksLikeInvoice(parsed) && !("message" in parsed) && !("invoice" in parsed)) {
    return { message: "Updated.", invoice: parsed };
  }

  return {
    message:
      String(parsed.message || parsed.reply || "").trim() || "Updated.",
    invoice: looksLikeInvoice(parsed.invoice)
      ? parsed.invoice
      : looksLikeInvoice(parsed)
        ? parsed
        : null,
  };
}

module.exports = { parseAssistantPayload };
