const GOTENBERG_HOSTNAME = (
  process.env.GOTENBERG_HOSTNAME || ""
).replace(/\/+$/, "");

const GOTENBERG_CONVERT_URL = GOTENBERG_HOSTNAME
  ? `${GOTENBERG_HOSTNAME}/forms/chromium/convert/html`
  : "";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

async function htmlToPdfBuffer(html, { filename = "document.pdf" } = {}) {
  if (!GOTENBERG_CONVERT_URL) {
    const err = new Error("GOTENBERG_HOSTNAME is not configured");
    err.status = 503;
    throw err;
  }
  const form = new FormData();
  const blob = new Blob([html], { type: "text/html" });
  form.append("files", blob, "index.html");
  form.append("printBackground", "true");
  form.append("preferCssPageSize", "true");

  const upstream = await fetch(GOTENBERG_CONVERT_URL, {
    method: "POST",
    body: form,
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(120_000),
  });

  const buffer = Buffer.from(await upstream.arrayBuffer());
  if (!upstream.ok) {
    const err = new Error(
      `Gotenberg error ${upstream.status}: ${buffer.toString("utf8").slice(0, 200)}`
    );
    err.status = 502;
    throw err;
  }
  return { buffer, filename };
}

module.exports = { htmlToPdfBuffer, GOTENBERG_CONVERT_URL };
