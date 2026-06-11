#!/usr/bin/env bun
/**
 * Live verification of the reviewer Telegram alert channel (mt#2419).
 *
 * Thin wrapper over the existing instrumented smoke
 * (services/reviewer/scripts/smoke-alert-sink.ts — PASS only on a real 2xx
 * from Telegram). Reads the bot token INTERNALLY from the Pulumi stack config
 * and injects it into the smoke subprocess via its ENVIRONMENT — the token is
 * never printed and never appears in argv (so not visible in `ps` or shell
 * history). Prints only the smoke's own PASS/FAIL JSON (which is token-free).
 *
 * Usage (from a checkout whose infra/ has the stack config):
 *
 *   bun scripts/reviewer-alerts/verify-send.ts <chat-id> [--infra-dir <path>]
 *
 * Exit code mirrors the smoke: 0 = PASS/SKIP, 1 = FAIL.
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_KEY = "secrets:minsky-reviewer-telegram-bot-token";

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const positional = process.argv.slice(2).filter((a, i, all) => {
  if (a === "--infra-dir") return false;
  if (all[i - 1] === "--infra-dir") return false;
  return true;
});
const chatId = positional[0];
if (!chatId || !/^-?\d+$/.test(chatId)) {
  fail("usage: bun scripts/reviewer-alerts/verify-send.ts <numeric-chat-id> [--infra-dir <path>]");
}

const argIdx = process.argv.indexOf("--infra-dir");
const infraDir =
  argIdx !== -1 && process.argv[argIdx + 1]
    ? resolve(String(process.argv[argIdx + 1]))
    : resolve(repoRoot, "infra");

// stdin inherited so a Pulumi passphrase prompt works; stdout captured so the
// decrypted token never reaches the terminal/transcript.
const read = Bun.spawnSync(["pulumi", "-C", infraDir, "config", "get", SECRET_KEY], {
  stdin: "inherit",
  stdout: "pipe",
  stderr: "pipe",
});
if (read.exitCode !== 0) {
  fail(
    `could not read ${SECRET_KEY} from Pulumi config ` +
      `(${read.stderr.toString().trim() || `exit ${read.exitCode}`}). ` +
      `Run: pulumi -C infra config set --secret ${SECRET_KEY}  (masked prompt), then retry.`
  );
}
const token = read.stdout.toString().trim();
if (!token) {
  fail(`Pulumi config ${SECRET_KEY} is empty.`);
}

// The token rides the subprocess ENVIRONMENT (never argv, never printed); the
// smoke's own output is token-free by design (PASS/FAIL JSON only).
const smoke = Bun.spawnSync(
  ["bun", resolve(repoRoot, "services/reviewer/scripts/smoke-alert-sink.ts")],
  {
    cwd: repoRoot,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      ALERT_SINK_TYPE: "telegram",
      TELEGRAM_BOT_TOKEN: token,
      TELEGRAM_CHAT_ID: chatId,
    },
  }
);

process.exit(smoke.exitCode ?? 1);
