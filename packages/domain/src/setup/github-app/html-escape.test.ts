/**
 * Tests for the setup provisioners' HTML escaper (mt#4815).
 *
 * The provisioner tests cover this through the served pages; these cover the
 * two properties that are easy to break in a later edit and invisible from a
 * page assertion — the `&`-first ordering, and `"` being in the set at all.
 */

import { describe, test, expect } from "bun:test";
import { escapeHtml } from "./html-escape";

describe("escapeHtml", () => {
  test("escapes the four characters that matter in content and in a quoted attribute", () => {
    expect(escapeHtml('&<>"')).toBe("&amp;&lt;&gt;&quot;");
  });

  test("escapes `&` first, so entities are not double-escaped", () => {
    // The wrong order yields "&amp;lt;" — the ampersand of the entity the
    // previous replacement just introduced gets escaped again.
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
    expect(escapeHtml("&")).toBe("&amp;");
  });

  test('`"` is escaped — this is what separates it from the Telegram escaper', () => {
    // `notify/markdown-to-telegram-html`'s escapeHtml is deliberately `& < >`
    // only. Reusing it for an href would leave this case unescaped, which is
    // precisely the attribute breakout mt#4815 fixes.
    expect(escapeHtml('https://github.com/apps/x" onmouseover="alert(1)')).toBe(
      "https://github.com/apps/x&quot; onmouseover=&quot;alert(1)"
    );
  });

  test("coerces non-strings rather than throwing", () => {
    // The callers read these off a `JSON.parse`d API response through a bare
    // `as` cast, so a declared `number` is an assertion, not a guarantee.
    expect(escapeHtml(12345)).toBe("12345");
    expect(escapeHtml(undefined)).toBe("undefined");
    expect(escapeHtml(null)).toBe("null");
    expect(escapeHtml({ toString: () => "<x>" })).toBe("&lt;x&gt;");
  });

  test("leaves an ordinary value untouched", () => {
    expect(escapeHtml("https://github.com/apps/minsky-ai")).toBe(
      "https://github.com/apps/minsky-ai"
    );
  });

  test("`'` is NOT escaped, which is safe only because the templates use double quotes", () => {
    // Recorded as a deliberate boundary rather than an oversight: if a caller
    // ever writes href='...', this escaper is insufficient for it.
    expect(escapeHtml("it's")).toBe("it's");
  });
});
