#!/usr/bin/env bun
/**
 * Telegram chat-id discovery for the reviewer alert sink (mt#2419).
 *
 * Reads the bot token INTERNALLY from the Pulumi stack config
 * (`secrets:minsky-reviewer-telegram-bot-token`, passphrase-encrypted in the
 * gitignored infra/Pulumi.prod.yaml) via a captured subprocess — the token is
 * NEVER printed, logged, or passed on a command line. Calls Telegram
 * `getUpdates` and prints ONLY the discovered chat id(s) + non-secret labels.
 *
 * Telegram has no API to look up a user's chat id directly (verified against
 * core.telegram.org/bots/api, 2026-06-10): the operator must send the bot one
 * message first; the id then appears in getUpdates as `message.chat.id`.
 *
 * Usage (run from a checkout whose infra/ has the stack config — i.e. the
 * main workspace, where the operator ran `pulumi config set`):
 *
 *   bun scripts/reviewer-alerts/discover-chat-id.ts [--infra-dir <path>]
 *
 * Exit codes: 0 = chat id(s) printed, 1 = actionable failure (message text
 * explains: no updates yet / webhook set / bad token / pulumi error).
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractChats, redactSecret, classifyGetUpdatesFailure } from "./lib";

const SECRET_KEY = "secrets:minsky-reviewer-telegram-bot-token";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

function readToken(infraDir: string): string {
  // stdin inherited so a Pulumi passphrase prompt works; stdout captured so
  // the decrypted token never reaches the terminal/transcript.
  const proc = Bun.spawnSync(["pulumi", "-C", infraDir, "config", "get", SECRET_KEY], {
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    fail(
      `could not read ${SECRET_KEY} from Pulumi config ` +
        `(${proc.stderr.toString().trim() || `exit ${proc.exitCode}`}). ` +
        `Run: pulumi -C infra config set --secret ${SECRET_KEY}  (masked prompt), then retry.`
    );
  }
  const token = proc.stdout.toString().trim();
  if (!token) {
    fail(
      `Pulumi config ${SECRET_KEY} is empty. Run the masked 'pulumi config set --secret' step first.`
    );
  }
  return token;
}

async function main(): Promise<void> {
  const argIdx = process.argv.indexOf("--infra-dir");
  const infraDir =
    argIdx !== -1 && process.argv[argIdx + 1]
      ? resolve(String(process.argv[argIdx + 1]))
      : resolve(dirname(fileURLToPath(import.meta.url)), "../../infra");

  const token = readToken(infraDir);

  let res: Response;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(redactSecret(token, `network error calling Telegram getUpdates: ${msg}`));
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    fail(`Telegram getUpdates returned non-JSON (HTTP ${res.status}).`);
  }

  const parsed = body as { ok?: boolean; description?: string };
  if (!res.ok || parsed.ok !== true) {
    fail(redactSecret(token, classifyGetUpdatesFailure(res.status, parsed.description)));
  }

  const chats = extractChats(body);
  if (chats.length === 0) {
    fail(
      "no updates found. Open Telegram, send your bot any message (e.g. 'hi'), then re-run. " +
        "(Telegram only exposes a chat id after the user has messaged the bot.)"
    );
  }

  console.log("Discovered chat(s):");
  for (const c of chats) {
    console.log(`  chat_id=${c.chatId}  type=${c.type}  label=${redactSecret(token, c.label)}`);
  }
  if (chats.length === 1) {
    console.log(`\nTELEGRAM_CHAT_ID=${chats[0]?.chatId}`);
  } else {
    console.log("\nMultiple chats found — pick the private chat with your own account.");
  }
}

main().catch((err) => {
  // Last-resort guard: no token interpolation can reach here un-redacted
  // because every throwing path above already redacts, but belt-and-suspenders.
  fail(err instanceof Error ? err.message : String(err));
});
