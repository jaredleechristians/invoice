/**
 * MCP over Streamable HTTP (stateless, JSON responses) at /mcp.
 * Auth: `Authorization: Bearer inv_live_...` (API keys only).
 */
const express = require("express");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { firebaseConfigured, getDb } = require("../lib/firebase");
const apiKeys = require("../lib/apiKeys");
const { withAuditContext } = require("../lib/audit");
const { buildMcpServer } = require("../lib/mcp");

const router = express.Router();

const rpcError = (res, status, message) =>
  res.status(status).json({ jsonrpc: "2.0", error: { code: -32001, message }, id: null });

async function authenticate(req) {
  if (!firebaseConfigured()) throw Object.assign(new Error("Server is not configured"), { status: 503 });
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!apiKeys.looksLikeApiKey(token)) throw Object.assign(new Error("Send an API key: Authorization: Bearer inv_live_..."), { status: 401 });
  const { user, apiKey } = await apiKeys.authenticateKey(token);
  const snap = await getDb().collection("companies").doc(apiKey.companyId).collection("members").doc(user.uid).get();
  if (!snap.exists) throw Object.assign(new Error("The key's owner is no longer a member of this company"), { status: 403 });
  return { companyId: apiKey.companyId, uid: user.uid, email: user.email, role: snap.data().role, apiKey };
}

router.post("/", async (req, res) => {
  let ctx;
  try {
    ctx = await authenticate(req);
  } catch (err) {
    if (err.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="invoice"');
    return rpcError(res, err.status || 500, err.message);
  }
  const server = buildMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  try {
    await withAuditContext({ via: "mcp", apiKeyId: ctx.apiKey.id }, async () => {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    });
  } catch (err) {
    console.error("[mcp]", err);
    if (!res.headersSent) rpcError(res, 500, "Internal error");
  }
});

// Stateless server: no SSE stream or sessions to resume or end.
router.get("/", (_req, res) => rpcError(res.setHeader("Allow", "POST"), 405, "Method not allowed"));
router.delete("/", (_req, res) => rpcError(res.setHeader("Allow", "POST"), 405, "Method not allowed"));

module.exports = router;
