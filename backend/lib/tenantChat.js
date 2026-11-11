const openrouter = require("./openrouter");
const { TOOL_DEFS, runTool, buildTenantSystemPrompt, auditTools } = require("./tenantAssistant");
const { WRITE_TOOL_DEFS, WRITE_TOOL_NAMES, proposeAction } = require("./assistantActions");
const { canWriteRecords } = require("./permissions");
const { companyRef } = require("./companies");
const { getDb } = require("./firebase");

const MAX_STEPS = 6;
const READ_TOOL_NAMES = new Set(TOOL_DEFS.map((t) => t.function.name));

/**
 * Structured JSON fallback for models that don't emit native tool calls:
 * the reply is (or contains, in a code fence) {"tool": "...", "arguments": {...}}.
 */
function parseJsonToolCall(content) {
  if (typeof content !== "string" || !content.includes("{")) return null;
  const candidates = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(content))) candidates.push(m[1]);
  const first = content.indexOf("{");
  const last = content.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(content.slice(first, last + 1));
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw.trim());
      const name = obj?.tool || obj?.name || obj?.function?.name;
      const args = obj?.arguments ?? obj?.args ?? obj?.parameters ?? obj?.function?.arguments ?? {};
      if (typeof name === "string" && (READ_TOOL_NAMES.has(name) || WRITE_TOOL_NAMES.has(name))) {
        return { name, args: typeof args === "string" ? JSON.parse(args || "{}") : args };
      }
    } catch {
      /* not JSON */
    }
  }
  return null;
}

function parseArgs(raw) {
  if (raw && typeof raw === "object") return raw;
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

/** Run one tool call. Write tools only create proposals (never business writes). */
async function dispatchTool({ companyId, uid, email, role, name, args, actions, userText }) {
  await auditTools({ companyId, uid, email, toolName: name, args });
  if (WRITE_TOOL_NAMES.has(name)) {
    const out = await proposeAction({ companyId, uid, role, tool: name, args, userText });
    if (out.action) {
      actions.push(out.action);
      return { status: "awaiting_user_confirmation", summary: out.action.title, note: "Nothing is saved until the user presses Confirm on the card." };
    }
    return out;
  }
  if (READ_TOOL_NAMES.has(name)) return runTool(companyId, name, args);
  return { error: `Unknown tool: ${name}` };
}

async function runTenantChat({ companyId, uid, email, role, messages, complete = (opts) => openrouter.chatCompletion(opts) }) {
  const db = getDb();
  const companySnap = await companyRef(db, companyId).get();
  const companyName = companySnap.exists ? companySnap.data().name : "Company";
  const canWrite = canWriteRecords(role);
  const tools = canWrite ? [...TOOL_DEFS, ...WRITE_TOOL_DEFS] : TOOL_DEFS;

  const thread = [
    { role: "system", content: buildTenantSystemPrompt(companyName, { canWrite }) },
    ...messages.slice(-30).map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "").slice(0, 8000) })),
  ];
  const actions = [];
  let emptyRetries = 0;
  // What the user typed recently (their own words, not the model's), for "did they say the currency?" checks.
  const userText = messages.filter((m) => m.role !== "assistant").slice(-6).map((m) => String(m.content ?? "")).join("\n");

  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await complete({ messages: thread, tools });
    const native = Array.isArray(msg?.tool_calls) ? msg.tool_calls : [];
    const content = typeof msg?.content === "string" ? msg.content : "";

    if (native.length) {
      thread.push({ role: "assistant", content: content || null, tool_calls: native });
      for (const call of native) {
        const name = call.function?.name;
        const result = await dispatchTool({ companyId, uid, email, role, name, args: parseArgs(call.function?.arguments), actions, userText });
        thread.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const fallback = parseJsonToolCall(content);
    if (fallback) {
      if (!canWrite && WRITE_TOOL_NAMES.has(fallback.name)) {
        thread.push({ role: "assistant", content });
        thread.push({ role: "user", content: "TOOL RESULT: This user cannot add or change records. Explain that to them." });
        continue;
      }
      const result = await dispatchTool({ companyId, uid, email, role, name: fallback.name, args: fallback.args, actions, userText });
      thread.push({ role: "assistant", content });
      thread.push({ role: "user", content: `TOOL RESULT for ${fallback.name}: ${JSON.stringify(result)}\nNow answer the user in plain language (no JSON).` });
      continue;
    }

    if (!content.trim() && emptyRetries < 2) {
      emptyRetries += 1;
      continue; // free models occasionally return nothing; retry
    }

    let message = content.trim();
    if (!message) message = actions.length ? "I've prepared that for you. Please check the card and press Confirm to save it." : "Sorry, I didn't get a response. Please try again.";
    return { message, actions, steps: step + 1 };
  }

  return {
    message: actions.length
      ? "I've prepared the changes below. Please check them and press Confirm to save."
      : "I hit the tool step limit. Please ask a simpler question or try again.",
    actions,
    steps: MAX_STEPS,
  };
}

module.exports = { runTenantChat, parseJsonToolCall, dispatchTool };
