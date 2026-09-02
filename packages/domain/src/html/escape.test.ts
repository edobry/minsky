/**
 * Tests for the shared HTML escapers (mt#4832).
 *
 * Folds in the coverage mt#4815 wrote for the setup provisioners' local helper
 * (`setup/github-app/html-escape.test.ts`, deleted by this task), with one
 * deliberate flip: that file recorded `'` as an explicit NON-escaped boundary,
 * and the shared attribute escaper closes it. The rest carries over unchanged.
 *
 * The properties worth pinning are the ones that are easy to break in a later
 * edit and invisible from a page assertion: the `&`-first ordering, and exactly
 * which characters each context escaper covers.
 */

import { describe, test, expect } from "bun:test";
import { escapeHtmlText, escapeHtmlAttribute } from "./escape";

describe("escapeHtmlText", () => {
  test("escapes the three characters HTML reserves in element content", () => {
    expect(escapeHtmlText("a < b > c & d")).toBe("a &lt; b &gt; c &amp; d");
  });

  test("leaves both quote characters alone — that is what makes it text-only", () => {
    // The contract the Telegram converter depends on. Widening this would
    // change its output for every message carrying a quote or apostrophe.
    expect(escapeHtmlText(`a < b > c & d "e" 'f'`)).toBe(`a &lt; b &gt; c &amp; d "e" 'f'`);
  });

  test("escapes `&` first, so entities are not double-escaped", () => {
    // The wrong order yields "&amp;lt;" — the ampersand of the entity the
    // previous replacement just introduced gets escaped again.
    expect(escapeHtmlText("<")).toBe("&lt;");
    expect(escapeHtmlText("&lt;")).toBe("&amp;lt;");
    expect(escapeHtmlText("&")).toBe("&amp;");
  });

  test("coerces non-strings rather than throwing", () => {
    // Callers read these off a `JSON.parse`d API response through a bare `as`
    // cast, so a declared `number` is an assertion, not a guarantee.
    expect(escapeHtmlText(12345)).toBe("12345");
    expect(escapeHtmlText(undefined)).toBe("undefined");
    expect(escapeHtmlText(null)).toBe("null");
    expect(escapeHtmlText({ toString: () => "<x>" })).toBe("&lt;x&gt;");
  });
});

describe("escapeHtmlAttribute", () => {
  test("escapes the three text characters plus both quotes", () => {
    expect(escapeHtmlAttribute(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  test("closes a double-quoted attribute breakout", () => {
    // Reusing the text escaper for an href would leave this unescaped, which is
    // precisely the attribute breakout mt#4815 fixed.
    expect(escapeHtmlAttribute('https://github.com/apps/x" onmouseover="alert(1)')).toBe(
      "https://github.com/apps/x&quot; onmouseover=&quot;alert(1)"
    );
  });

  test("closes a SINGLE-quoted attribute breakout — the case mt#4815 left open", () => {
    // mt#4815's local helper escaped `"` but not `'`, safe only because every
    // template it served used double quotes. `minsky-reviewer[bot]` raised this
    // as non-blocking on PR #3527; the shared escaper is where it belongs.
    expect(escapeHtmlAttribute("https://github.com/apps/x' onmouseover='alert(1)")).toBe(
      "https://github.com/apps/x&#39; onmouseover=&#39;alert(1)"
    );
  });

  test("uses the numeric reference, not `&apos;`", () => {
    // `&apos;` is XML/HTML5-only; `&#39;` is valid in every HTML version, and is
    // what both pre-existing five-character implementations already emitted.
    expect(escapeHtmlAttribute("it's")).toBe("it&#39;s");
  });

  test("escapes `&` first, so entities are not double-escaped", () => {
    expect(escapeHtmlAttribute("&quot;")).toBe("&amp;quot;");
    expect(escapeHtmlAttribute("&")).toBe("&amp;");
  });

  test("coerces non-strings rather than throwing", () => {
    expect(escapeHtmlAttribute(12345)).toBe("12345");
    expect(escapeHtmlAttribute(undefined)).toBe("undefined");
    expect(escapeHtmlAttribute(null)).toBe("null");
    expect(escapeHtmlAttribute({ toString: () => "<x>" })).toBe("&lt;x&gt;");
  });

  test("leaves an ordinary value untouched", () => {
    expect(escapeHtmlAttribute("https://github.com/apps/minsky-ai")).toBe(
      "https://github.com/apps/minsky-ai"
    );
  });

  test("is a strict superset of the text escaper", () => {
    // The property that makes it safe to use in element content as well, which
    // is what every migrated call site in this task relies on.
    for (const input of ["plain", "a & b", "<script>", "tag > other", "no quotes here"]) {
      expect(escapeHtmlAttribute(input)).toBe(escapeHtmlText(input));
    }
  });
});
