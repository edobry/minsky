/**
 * Tests for the Markdown-to-Telegram-HTML converter (mt#3465).
 *
 * The load-bearing cases are the ESCAPING and NON-conversion ones. A converter
 * that renders bold correctly but mangles `some_var_name`, or emits an
 * unescaped `<`, produces a 400 from Telegram and the principal gets silence —
 * which is a worse outcome than the literal `**bold**` this replaces.
 */

import { describe, expect, test } from "bun:test";
import { escapeHtmlText } from "../html/escape";
import { markdownToTelegramHtml } from "./markdown-to-telegram-html";

describe("escapeHtmlText, under the Telegram text contract", () => {
  test("escapes exactly the three characters HTML mode reserves", () => {
    expect(escapeHtmlText(`a < b > c & d "e" 'f'`)).toBe(`a &lt; b &gt; c &amp; d "e" 'f'`);
  });

  test("escapes the ampersand first so entities are not double-escaped", () => {
    // Naive ordering yields &amp;lt; here.
    expect(escapeHtmlText("&<")).toBe("&amp;&lt;");
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

/**
 * The spec's acceptance tests, written literally rather than assumed covered
 * by adjacent cases.
 */
describe("markdownToTelegramHtml — acceptance", () => {
  test("AT1: a mixed reply round-trips with SHAs, refs and paths byte-identical", () => {
    const sha = "9f797d8df1c2b3a45e6f7089abcdef0123456789";
    const source = [
      "**Done** — see mt#3243 and `src/cockpit/principal_channel_poller.ts`.",
      "",
      "```sh",
      `git show ${sha}`,
      "```",
    ].join("\n");

    const html = markdownToTelegramHtml(source);

    // The literal content classes must survive untouched.
    expect(html).toContain(sha);
    expect(html).toContain("mt#3243");
    expect(html).toContain("principal_channel_poller.ts");
    // ...and the formatting must actually have been applied.
    expect(html).toContain("<b>Done</b>");
    expect(html).toContain(`<pre><code class="language-sh">`);
  });

  test("AT3: truncating mid-emphasis still yields parseable output", () => {
    // The design truncates the MARKDOWN and then converts, so a cut through a
    // `**` pair can never produce a half-open tag. Prove it at the seam.
    const full = `${"word ".repeat(40)}**bold text that gets cut here**`;
    for (let cut = full.length - 20; cut < full.length; cut += 1) {
      const html = markdownToTelegramHtml(full.slice(0, cut));
      const open = html.match(/<b>/g)?.length ?? 0;
      const close = html.match(/<\/b>/g)?.length ?? 0;
      expect(`cut${cut}:${open}`).toBe(`cut${cut}:${close}`);
    }
  });
});

/**
 * PR #2505 R1 — three real defects the reviewer caught. Each of these produced
 * markup Telegram would answer with a 400, which on this channel means the
 * principal receives nothing.
 */
describe("markdownToTelegramHtml — attribute and marker edge cases", () => {
  test("escapes a double quote in a URL so it cannot close the href attribute", () => {
    const html = markdownToTelegramHtml(`[x](https://e.example/a"b)`);
    expect(html).toBe(`<a href="https://e.example/a&quot;b">x</a>`);
    // The attribute must still have exactly one closing quote before `>`.
    expect(html.match(/href="[^"]*"/)?.[0]).toBe(`href="https://e.example/a&quot;b"`);
  });

  test("escapes a double quote in a fence language so it cannot close the class attribute", () => {
    const html = markdownToTelegramHtml('```a"b\nx\n```');
    expect(html).toBe(`<pre><code class="language-a&quot;b">x</code></pre>`);
  });

  test("keeps balanced parentheses inside a URL", () => {
    // The Wikipedia shape: `[^)\s]+` truncated this at the first `)`.
    const html = markdownToTelegramHtml("[Foo](https://en.wikipedia.org/wiki/Foo_(bar))");
    expect(html).toBe(`<a href="https://en.wikipedia.org/wiki/Foo_(bar)">Foo</a>`);
  });

  test("leaves spaced asterisks literal instead of reading them as emphasis", () => {
    // Arithmetic, globs and footnote markers all produce this shape.
    expect(markdownToTelegramHtml("a * b * c")).toBe("a * b * c");
    expect(markdownToTelegramHtml("2 * 3 * 4 = 24")).toBe("2 * 3 * 4 = 24");
    expect(markdownToTelegramHtml("run rm * then ls *")).toBe("run rm * then ls *");
  });

  test("still renders emphasis when the markers hug their content", () => {
    // The hug rule must not cost the feature it guards.
    expect(markdownToTelegramHtml("*i* and **b** and ***bi***")).toBe(
      "<i>i</i> and <b>b</b> and <b><i>bi</i></b>"
    );
  });

  test("renders single-character emphasis", () => {
    // `\S(?:...)?` must admit a one-char body, not require two.
    expect(markdownToTelegramHtml("*x* and **y**")).toBe("<i>x</i> and <b>y</b>");
  });

  test("leaves spaced tildes literal but still renders hugged strikethrough", () => {
    expect(markdownToTelegramHtml("a ~~ b ~~ c")).toBe("a ~~ b ~~ c");
    expect(markdownToTelegramHtml("~~gone~~")).toBe("<s>gone</s>");
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

  /**
   * PR #2505 R2 asked whether regex-based emphasis "can mis-nest or overrun,
   * risking invalid HTML and Telegram 400s". Answering it with an argument
   * would not settle anything — Telegram rejects unbalanced markup, and
   * balance is the property that matters. So: assert it over the adversarial
   * inputs, including deliberately overlapping and unterminated markers.
   */
  test("every adversarial marker arrangement still produces balanced tags", () => {
    const cases = [
      "**a *b** c*",
      "*a **b* c**",
      "***a**",
      "**a***",
      "*",
      "**",
      "***",
      "****",
      "a*b*c",
      "**a*b**c*",
      "~~a~~b~~",
      "**~~a~~**",
      "*a\nb*",
      "**a**b**c**",
      "[a](x)*b*",
      "`a`*b*`c`",
      "**[l](u)**",
      "*[l](u)*",
      "[*l*](u)",
      "* * *",
      "**  **",
      "*x**y*",
      "a ** b ** c",
      "**a **b** c**",
      "[](u)",
      "[a](u",
      "**a\n**b",
      "> *q*\n> **r**",
      "```\n**a**\n```",
      "| *a* | **b** |\n| --- | --- |",
    ];

    for (const source of cases) {
      const html = markdownToTelegramHtml(source);
      for (const tag of ["b", "i", "s", "a", "code", "pre", "blockquote"]) {
        const open = html.match(new RegExp(`<${tag}(\\s[^>]*)?>`, "g"))?.length ?? 0;
        const close = html.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
        // Label the assertion with the input so a failure names the case.
        expect(`${JSON.stringify(source)} ${tag}:${open}`).toBe(
          `${JSON.stringify(source)} ${tag}:${close}`
        );
      }
    }
  });

  test("no placeholder sentinel survives into the output", () => {
    // A leaked sentinel would ship an invisible private-use character to the
    // principal's phone and mean a stash was never restored.
    const html = markdownToTelegramHtml("`a` and `b` and [l](https://e.example) and `c`");
    expect(html).not.toContain(String.fromCharCode(0xe000));
  });
});
