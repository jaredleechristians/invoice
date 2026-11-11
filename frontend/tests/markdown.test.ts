import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "../app/utils/markdown.ts";

test("bold, lists and line breaks", () => {
  assert.equal(renderMarkdown("Good news: **no one owes you money**."), "<p>Good news: <strong>no one owes you money</strong>.</p>");
  assert.equal(renderMarkdown("Owing:\n- Acme: R1,200\n- Beta: $50\n\nDone"), "<p>Owing:</p><ul><li>Acme: R1,200</li><li>Beta: $50</li></ul><p>Done</p>");
  assert.equal(renderMarkdown("1. One\n2. Two"), "<ol><li>One</li><li>Two</li></ol>");
  assert.equal(renderMarkdown("a\nb"), "<p>a<br>b</p>");
  assert.equal(renderMarkdown("use `INV-*` *now*"), "<p>use <code>INV-*</code> <em>now</em></p>");
  assert.equal(renderMarkdown("file_name_here"), "<p>file_name_here</p>");
});

test("no raw HTML or unsafe links", () => {
  const out = renderMarkdown('<img src=x onerror=alert(1)> <script>alert(1)</script> [x](javascript:alert(1)) **<b>hi</b>**');
  assert.doesNotMatch(out, /<img|<script|<b>|javascript:/);
  assert.match(out, /&lt;img/);
  assert.equal(renderMarkdown("[Open](/dashboard/invoices)"), '<p><a href="/dashboard/invoices">Open</a></p>');
  assert.equal(renderMarkdown("[Site](https://a.co/?a=1&b=2)"), '<p><a href="https://a.co/?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Site</a></p>');
  assert.equal(renderMarkdown('[x](https://a.co/"onmouseover=1)'), '<p><a href="https://a.co/&quot;onmouseover=1" target="_blank" rel="noopener noreferrer">x</a></p>');
});
