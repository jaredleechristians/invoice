// Small, safe markdown for chat replies. Everything is HTML-escaped first, then
// only a fixed set of tags is produced: p, br, strong, em, code, ul/ol/li, a.
// Links allow http(s), mailto and in-app paths only. No raw HTML passes through.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function unescapeHtml(s: string): string {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function safeHref(url: string): string | null {
  const u = url.trim();
  if (/^(https?:\/\/|mailto:)/i.test(u)) return u;
  if (/^\/(?!\/)/.test(u)) return u;
  return null;
}

function inline(text: string): string {
  // Code spans first so their content is left alone.
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = escapeHtml(s);
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    const href = safeHref(unescapeHtml(url));
    if (!href) return label;
    const external = !href.startsWith("/");
    return `<a href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${escapeHtml(codes[Number(i)] ?? "")}</code>`);
}

export function renderMarkdown(src: string): string {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.type}>`);
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const type = ul ? "ul" : "ol";
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((ul || ol)![1]);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    flushList();
    if (h) {
      flushPara();
      out.push(`<p><strong>${inline(h[1])}</strong></p>`);
      continue;
    }
    para.push(line);
  }
  flushPara();
  flushList();
  return out.join("");
}
