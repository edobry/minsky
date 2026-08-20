#!/usr/bin/env bun
/**
 * Live verification that Telegram ACCEPTS the HTML this channel now emits
 * (mt#3465).
 *
 * Why this cannot be a unit test: Telegram validates `parse_mode: HTML`
 * server-side and answers markup it cannot parse with a 400. Every unit test
 * here stubs `fetch`, so all of them would pass against a converter that emits
 * markup Telegram rejects — and the failure mode on the real channel is the
 * principal receiving NOTHING. Only a real send exercises the validator.
 *
 * The sample deliberately covers every construct the converter can emit, plus
 * the content classes that break naive escaping: snake_case identifiers, a
 * generic type that looks like a tag, a bare ampersand, and a URL with query
 * parameters.
 *
 * This sends ONE real message to the configured principal chat — which is also
 * the point: the rendered result is what the principal asked to see.
 *
 * Usage:
 *
 *   bun scripts/principal-channel/verify-html-render.ts [--dry-run]
 *
 * `--dry-run` prints the converted HTML and sends nothing.
 *
 * Exit codes: 0 = Telegram accepted it (or dry-run), 1 = rejected/unconfigured.
 */

import {
  resolvePrincipalChannel,
  createRealPrincipalChannelDeps,
} from "@minsky/domain/notify/principal-channel";
import { markdownToTelegramHtml } from "@minsky/domain/notify/markdown-to-telegram-html";
import { sendTelegramMessage } from "@minsky/domain/notify/telegram-transport";

const SAMPLE = [
  "# mt#3465 render check",
  "",
  "This is **bold**, this is *italic*, this is ***both***, this is ~~struck~~.",
  "",
  "Inline `code_span` and a bare identifier parse_mode stay literal.",
  "A generic Promise<string> and a bare & must arrive escaped.",
  "",
  "- bullet *one*",
  "- bullet two",
  "",
  "1. first",
  "2. second",
  "",
  "> a quoted line",
  "> and its continuation",
  "",
  "```ts",
  "const ok = 1 < 2 && 3 > 2;",
  "```",
  "",
  "| col | value |",
  "| --- | --- |",
  "| a | 1 |",
  "",
  "A [link](https://core.telegram.org/bots/api?a=1&b=2) closes it out.",
].join("\n");

async function main(): Promise<void> {
  const html = markdownToTelegramHtml(SAMPLE);

  if (process.argv.includes("--dry-run")) {
    console.log(html);
    console.log(`\nSKIP: --dry-run, nothing sent (${html.length} chars)`);
    return;
  }

  const resolution = await resolvePrincipalChannel(createRealPrincipalChannelDeps());
  if (!resolution.configured) {
    // Not a failure of the code under test — say so distinctly.
    console.log(`SKIP: principal channel not configured (${resolution.reason})`);
    return;
  }

  const { token, chatId } = resolution.config;
  const result = await sendTelegramMessage({
    token,
    chatId,
    text: html,
    parseMode: "HTML",
    // Deliberately OMITTED: the fallback would mask a rejection by quietly
    // delivering plain text, and this probe exists to detect exactly that.
    // A 400 must surface as a failure here.
  });

  if (!result.ok) {
    console.error(`FAIL: Telegram rejected the rendered HTML — ${result.detail}`);
    process.exit(1);
  }

  console.log(
    JSON.stringify({ status: "PASS", messageId: result.messageId, htmlChars: html.length }, null, 2)
  );
}

await main();
