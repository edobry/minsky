/**
 * Markdown to Telegram-HTML conversion for the principal channel (mt#3465).
 *
 * Agent output is written in Markdown because that is what every other surface
 * renders. Telegram renders nothing unless a `parse_mode` is set, so the
 * principal was reading literal `**bold**` and `#` on their phone.
 *
 * ## Why HTML and not MarkdownV2
 *
 * MarkdownV2 requires escaping eighteen characters -- `_ * [ ] ( ) ~ ` > # + -
 * = | { } . !` -- anywhere they appear as literal text, and agent output is
 * full of them (`mt#3465`, `file_name.ts`, `a-b`, `1.`). Miss one and Telegram
 * returns 400 and the message is LOST.
 *
 * HTML mode needs three: `<`, `>`, `&`. Verbatim from the Bot API docs: "All
 * `<`, `>` and `&` symbols that are not a part of a tag or an HTML entity must
 * be replaced with the corresponding HTML entities." None of the three occurs
 * in a SHA, a task id, or a file path -- exactly the content the original
 * plain-text decision was protecting.
 *
 * HTML also has full feature parity for everything this channel emits: it
 * supports nesting (the docs show `<b>bold <i>italic bold ...</i> bold</b>`)
 * and carries `<u>`, `<s>`, `<tg-spoiler>`, `<blockquote>`, and
 * `<pre><code class="language-x">`.
 *
 * ## Emphasis is asterisk-only, on purpose
 *
 * `_underscore_` emphasis is NOT honoured. Agent output is dense with
 * snake_case identifiers (`file_name`, `parse_mode`, `MAX_REPLY_CHARS`), and
 * treating `_` as emphasis turns `some_var_name` into `some<i>var</i>name`.
 * Every LLM-authored Markdown this channel carries uses `**`/`*`, so the
 * restriction costs nothing real and removes a large corruption class.
 *
 * @see core.telegram.org/bots/api#html-style -- the supported tag list
 * @see mt#3465
 */

import { escapeHtmlText } from "../html/escape";

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const UNORDERED_ITEM_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_ITEM_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;
const HORIZONTAL_RULE_RE = /^\s*([-*_])\1{2,}\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const FENCE_RE = /^\s*```(\S*)\s*$/;

/**
 * Sentinel wrapping a placeholder index.
 *
 * A private-use codepoint: it cannot occur in agent prose, and it is never
 * produced by escaping -- so a placeholder can neither collide with real
 * content nor be corrupted by the escape pass that runs between stashing and
 * restoring. Written as an escape rather than a literal so the source stays
 * ASCII and readable.
 */
const MARK = String.fromCharCode(0xe000);

/**
 * Escape for use INSIDE a double-quoted attribute value (PR #2505 R1).
 *
 * Body escaping is not sufficient here: a `"` inside `href` or the language
 * class closes the attribute early, which yields malformed markup, a 400, and
 * a lost message — and in the `href` case lets link text inject further
 * attributes. `&quot;` is one of the four named entities the Bot API documents
 * as supported ("&lt;, &gt;, &amp; and &quot;").
 *
 * Telegram-specific, so it deliberately does NOT consume `escapeHtmlAttribute`
 * from `../html/escape` (mt#4832). That escaper also emits `&#39;` for `'`, and
 * the Bot API documents exactly four supported entities — the apostrophe is not
 * among them. The shared TEXT escaper is byte-for-byte what this needs, so that
 * half is shared and only this wrapper stays local.
 */
function escapeTelegramAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/g, "&quot;");
}

/**
 * Convert Markdown to the HTML subset Telegram accepts.
 *
 * Total, never throwing: any construct not recognized degrades to escaped
 * plain text. A converter that can fail is worse than unstyled text on a
 * channel whose job is to reach the principal.
 */
export function markdownToTelegramHtml(markdown: string): string {
  const blocks: string[] = [];
  const lines = markdown.split("\n");
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    // Fenced code -- consumed verbatim, so no inline rule may touch its body.
    const fence = line.match(FENCE_RE);
    if (fence) {
      const language = fence[1] ?? "";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? "")) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      out.push(stash(blocks, renderCodeBlock(body.join("\n"), language)));
      continue;
    }

    // Tables have no Telegram equivalent. A monospace block is the only form
    // that preserves column alignment on a phone.
    if (TABLE_ROW_RE.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW_RE.test(lines[i] ?? "")) {
        rows.push((lines[i] ?? "").trim());
        i += 1;
      }
      i -= 1;
      out.push(stash(blocks, renderCodeBlock(rows.join("\n"), "")));
      continue;
    }

    if (HORIZONTAL_RULE_RE.test(line)) {
      out.push("—");
      continue;
    }

    const quote = line.match(BLOCKQUOTE_RE);
    if (quote) {
      const quoted: string[] = [quote[1] ?? ""];
      i += 1;
      while (i < lines.length) {
        const next = (lines[i] ?? "").match(BLOCKQUOTE_RE);
        if (!next) break;
        quoted.push(next[1] ?? "");
        i += 1;
      }
      i -= 1;
      out.push(`<blockquote>${quoted.map(renderInline).join("\n")}</blockquote>`);
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      // No heading tag exists in Telegram's set; bold on its own line is the
      // closest structural signal.
      out.push(`<b>${renderInline(heading[2] ?? "")}</b>`);
      continue;
    }

    const ordered = line.match(ORDERED_ITEM_RE);
    if (ordered) {
      out.push(`${ordered[1] ?? ""}${ordered[2] ?? ""}. ${renderInline(ordered[3] ?? "")}`);
      continue;
    }

    const unordered = line.match(UNORDERED_ITEM_RE);
    if (unordered) {
      out.push(`${unordered[1] ?? ""}• ${renderInline(unordered[2] ?? "")}`);
      continue;
    }

    out.push(renderInline(line));
  }

  return restore(out.join("\n"), blocks);
}

function renderCodeBlock(body: string, language: string): string {
  const escaped = escapeHtmlText(body);
  // Nested pre+code is how the docs specify a language: "Use nested pre and
  // code tags, to define programming language for pre entity."
  return language.length > 0
    ? `<pre><code class="language-${escapeTelegramAttribute(language)}">${escaped}</code></pre>`
    : `<pre>${escaped}</pre>`;
}

/**
 * Apply inline rules to one line of text.
 *
 * Order is load-bearing: code spans are stashed FIRST so their contents are
 * never read as emphasis (`` `a_*b*_c` `` must stay literal), then the
 * remainder is escaped, then tags are inserted. Escaping before tag insertion
 * is what keeps the tags themselves from being escaped.
 */
function renderInline(text: string): string {
  const spans: string[] = [];

  // 1. Code spans, verbatim.
  let working = text.replace(/`([^`]+)`/g, (_match, code: string) =>
    stash(spans, `<code>${escapeHtmlText(code)}</code>`)
  );

  // 2. Links -- captured before escaping so the URL is not mangled, and stashed
  //    so the label's own emphasis still renders inside the anchor.
  //
  //    The URL alternation admits ONE level of balanced parentheses (PR #2505
  //    R1): `[^)\s]+` stopped at the first `)`, which truncates the very common
  //    Wikipedia/MSDN shape `.../Foo_(bar)` into a broken href and leaves a
  //    stray `)` in the text. Deeper nesting is vanishingly rare in URLs and
  //    still degrades to a truncated-but-well-formed anchor.
  working = working.replace(
    /\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g,
    (_match, label: string, href: string) =>
      stash(spans, `<a href="${escapeTelegramAttribute(href)}">${renderInline(label)}</a>`)
  );

  // 3. Everything left is literal text.
  working = escapeHtmlText(working);

  // 4. Emphasis, longest marker first so `**` is not eaten by `*`.
  //
  //    Each marker must HUG non-whitespace (PR #2505 R1). Without that,
  //    `a * b * c` -- arithmetic, a glob, a footnote marker -- matched as
  //    emphasis and ate the literal asterisks, rendering `a <i> b </i> c`.
  //    Requiring `\S` immediately inside both markers is the rule CommonMark
  //    uses, and it makes spaced asterisks literal again.
  working = working.replace(/\*\*\*(\S(?:[^*\n]*\S)?)\*\*\*/g, "<b><i>$1</i></b>");
  working = working.replace(/\*\*(\S(?:[^*]*\S)?)\*\*/g, "<b>$1</b>");
  working = working.replace(/(?<!\*)\*(\S(?:[^*\n]*\S)?)\*(?!\*)/g, "<i>$1</i>");
  working = working.replace(/~~(\S(?:[^~]*\S)?)~~/g, "<s>$1</s>");

  return restore(working, spans);
}

function stash(store: string[], rendered: string): string {
  store.push(rendered);
  return `${MARK}${store.length - 1}${MARK}`;
}

function restore(text: string, store: string[]): string {
  if (store.length === 0) return text;
  return text.replace(new RegExp(`${MARK}(\\d+)${MARK}`, "g"), (whole, index: string) => {
    const replacement = store[Number(index)];
    return replacement === undefined ? whole : replacement;
  });
}
