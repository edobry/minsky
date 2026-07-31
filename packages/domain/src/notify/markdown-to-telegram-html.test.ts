/**
 * Tests for the Markdown-to-Telegram-HTML converter (mt#3465).
 *
 * The load-bearing cases are the ESCAPING and NON-conversion ones. A converter
 * that renders bold correctly but mangles `some_var_name`, or emits an
 * unescaped `<`, produces a 400 from Telegram and the principal gets silence —
 * which is a worse outcome than the literal `**bold**` this replaces.
 */

import { describe, expect, test } from "bun:test";
import { escapeHtml, markdownToTelegramHtml } from "./markdown-to-telegram-html";

describe("escapeHtml", () => {
  test("escapes exactly the three characters HTML mode reserves", () => {
    expect(escapeHtml(`a < b > c & d "e" 'f'`)).toBe(`a &lt; b &gt; c &amp; d "e" 'f'`);
  });

  test("escapes the ampersand first so entities are not double-escaped", () => {
    // Naive ordering yields &amp;lt; here.
    expect(escapeHtml("&<")).toBe("&amp;&lt;");
  });
});

describe("markdownToTelegramHtml — inline", () => {
  test("renders bold and italic", () => {
    expect(markdownToTelegramHtml("**b** and *i*")).toBe("<b>b</b> and <i>i</i>");
  });

  test("renders bold-italic without the inner marker leaking", () => {
    expect(markdownToTelegramHtml("***x***")).toBe("<b><i>x</i></b>");
  });

  test("renders strikethrough", () => {
    expect(markdownToTelegramHtml("~~gone~~")).toBe("<s>gone</s>");
  });

  test("renders inline code, escaping its contents", () => {
    expect(markdownToTelegramHtml("`a < b`")).toBe("<code>a &lt; b</code>");
  });

  test("renders links, preserving the URL verbatim", () => {
    expect(markdownToTelegramHtml("[hi](https://x.example/a_b?c=1&d=2)")).toBe(
      `<a href="https://x.example/a_b?c=1&amp;d=2">hi</a>`
    );
  });
});

/**
 * The corruption class the asterisk-only rule exists to prevent. Agent output
 * is dense with snake_case; underscore emphasis would rewrite identifiers.
 */
describe("markdownToTelegramHtml — underscores are never emphasis", () => {
  test("leaves a snake_case identifier alone", () => {
    expect(markdownToTelegramHtml("call parse_mode on send_message")).toBe(
      "call parse_mode on send_message"
    );
  });

  test("leaves a doubly-underscored name alone", () => {
    expect(markdownToTelegramHtml("MAX_REPLY_CHARS and __dunder__")).toBe(
      "MAX_REPLY_CHARS and __dunder__"
    );
  });

  test("leaves a filename with underscores alone", () => {
    expect(markdownToTelegramHtml("see telegram_transport_test.ts")).toBe(
      "see telegram_transport_test.ts"
    );
  });
});

describe("markdownToTelegramHtml — escaping of literal text", () => {
  test("escapes angle brackets and ampersands in prose", () => {
    expect(markdownToTelegramHtml("if 5 < 6 && 7 > 2")).toBe("if 5 &lt; 6 &amp;&amp; 7 &gt; 2");
  });

  test("escapes HTML the agent wrote as literal text, rather than passing it through", () => {
    // Critical: unescaped, Telegram would either render this as markup or 400
    // on a tag it does not support.
    expect(markdownToTelegramHtml("use <script>alert(1)</script>")).toBe(
      "use &lt;script&gt;alert(1)&lt;/script&gt;"
    );
  });

  test("escapes a generic type that looks like a tag", () => {
    expect(markdownToTelegramHtml("Promise<string> is returned")).toBe(
      "Promise&lt;string&gt; is returned"
    );
  });
});

describe("markdownToTelegramHtml — blocks", () => {
  test("renders a fenced block with its language", () => {
    expect(markdownToTelegramHtml("```ts\nconst a = 1;\n```")).toBe(
      `<pre><code class="language-ts">const a = 1;</code></pre>`
    );
  });

  test("renders a fenced block without a language as bare pre", () => {
    expect(markdownToTelegramHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  test("does not apply inline rules inside a fenced block", () => {
    // The body is code: asterisks and underscores must survive verbatim.
    expect(markdownToTelegramHtml("```\na * b * c _d_\n```")).toBe("<pre>a * b * c _d_</pre>");
  });

  test("escapes inside a fenced block", () => {
    expect(markdownToTelegramHtml("```\nif (a<b && c>d)\n```")).toBe(
      "<pre>if (a&lt;b &amp;&amp; c&gt;d)</pre>"
    );
  });

  test("renders a heading as bold, since Telegram has no heading tag", () => {
    expect(markdownToTelegramHtml("## Section")).toBe("<b>Section</b>");
  });

  test("renders consecutive quote lines as ONE blockquote", () => {
    expect(markdownToTelegramHtml("> a\n> b")).toBe("<blockquote>a\nb</blockquote>");
  });

  test("renders a bullet list with a bullet prefix", () => {
    expect(markdownToTelegramHtml("- one\n- two")).toBe("• one\n• two");
  });

  test("keeps ordered-list numbering", () => {
    expect(markdownToTelegramHtml("1. one\n2. two")).toBe("1. one\n2. two");
  });

  test("renders a table as a monospace block so columns stay aligned", () => {
    const table = "| a | b |\n| --- | --- |\n| 1 | 2 |";
    expect(markdownToTelegramHtml(table)).toBe("<pre>| a | b |\n| --- | --- |\n| 1 | 2 |</pre>");
  });

  test("renders a horizontal rule as a dash line", () => {
    expect(markdownToTelegramHtml("---")).toBe("—");
  });
});

describe("markdownToTelegramHtml — robustness", () => {
  test("leaves an unmatched marker as literal text rather than emitting a stray tag", () => {
    // A truncated reply can end mid-emphasis; an unbalanced tag is a 400.
    expect(markdownToTelegramHtml("**unclosed bold")).toBe("**unclosed bold");
  });

  test("an unterminated fence still closes its block", () => {
    expect(markdownToTelegramHtml("```\nbody")).toBe("<pre>body</pre>");
  });

  test("handles empty input", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });

  test("every produced tag is balanced across a mixed document", () => {
    const doc = [
      "# Title",
      "",
      "Some **bold** and `code_x` and a [link](https://e.example).",
      "",
      "- item *one*",
      "",
      "```py",
      "x = 1 < 2",
      "```",
      "",
      "> quoted",
    ].join("\n");
    const html = markdownToTelegramHtml(doc);

    for (const tag of ["b", "i", "code", "pre", "a", "blockquote"]) {
      const open = html.match(new RegExp(`<${tag}(\\s[^>]*)?>`, "g"))?.length ?? 0;
      const close = html.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
      expect(`${tag}:${open}`).toBe(`${tag}:${close}`);
    }
  });

  test("no placeholder sentinel survives into the output", () => {
    // A leaked sentinel would ship an invisible private-use character to the
    // principal's phone and mean a stash was never restored.
    const html = markdownToTelegramHtml("`a` and `b` and [l](https://e.example) and `c`");
    expect(html).not.toContain(String.fromCharCode(0xe000));
  });
});
