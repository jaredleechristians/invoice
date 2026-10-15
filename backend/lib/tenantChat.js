const { chatCompletion } = require("./openrouter");
const {
  TOOL_DEFS,
  runTool,
  buildTenantSystemPrompt,
  auditTools,
} = require("./tenantAssistant");
const { companyRef } = require("./companies");
const { getDb } = require("./firebase");

async function runTenantChat({
  companyId,
  uid,
  email,
  messages,
}) {
  const db = getDb();
  const companySnap = await companyRef(db, companyId).get();
  const companyName = companySnap.exists ? companySnap.data().name : "Company";

  const thread = [
    {
      role: "system",
      content: buildTenantSystemPrompt(companyName),
    },
    ...messages.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content ?? ""),
    })),
  ];

  for (let step = 0; step < 6; step++) {
    const assistantMsg = await chatCompletion({
      messages: thread,
      tools: TOOL_DEFS,
    });

    thread.push(assistantMsg);

    const toolCalls = assistantMsg.tool_calls || [];
    if (!toolCalls.length) {
      const content =
        typeof assistantMsg.content === "string"
          ? assistantMsg.content
          : JSON.stringify(assistantMsg.content || "");
      return { message: content.trim(), steps: step + 1 };
    }

    for (const call of toolCalls) {
      const name = call.function?.name;
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        args = {};
      }
      await auditTools({ companyId, uid, email, toolName: name, args });
      const result = await runTool(companyId, name, args);
      thread.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  return {
    message:
      "I hit the tool step limit. Please ask a simpler question or try again.",
    steps: 6,
  };
}

module.exports = { runTenantChat };
