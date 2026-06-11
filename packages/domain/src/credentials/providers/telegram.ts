/**
 * Telegram bot-token provider (mt#2419) — reviewer alert sink.
 *
 * Unlike the other providers (which persist to the local config.yaml via
 * ConfigWriter), this provider OWNS its storage: the token's source of truth
 * is the Pulumi stack config (`secrets:minsky-reviewer-telegram-bot-token`,
 * passphrase-encrypted in the gitignored infra/Pulumi.prod.yaml), because the
 * DEPLOYED reviewer consumes it via IaC-managed Railway env vars
 * (infra/index.ts `defineVariables("reviewer", ...)`). Storing it locally
 * would create a second token copy nothing reads (mt#2431 closure rationale).
 *
 * The cockpit credentials widget auto-discovers this provider (mt#2164), so
 * the masked web form is the entry surface — the token never passes through
 * chat, argv, or shell history. `store` pipes the value to
 * `pulumi config set --secret` via STDIN.
 *
 * Validation: Telegram Bot API `getMe`. Post-store test: `getUpdates`
 * reachability + a chat-visibility hint for the discovery step.
 */
import { existsSync } from "fs";
import { join, resolve } from "path";
import type { CredentialProvider, CredentialCheckResult } from "../types";

export const TELEGRAM_PULUMI_SECRET_KEY = "secrets:minsky-reviewer-telegram-bot-token";

/**
 * Resolve the infra/ directory (Pulumi project home) from the server's cwd.
 * `existsFn` is injectable for hermetic tests (no real fs).
 */
export function resolveInfraDir(
  cwd: string = process.cwd(),
  existsFn: (path: string) => boolean = existsSync
): string | null {
  // Walk up a few levels so a cockpit server started from a subdirectory of
  // the repo still finds infra/. The Pulumi.yaml probe is the ground truth.
  let dir = resolve(cwd);
  // 6 levels (PR #1672 R1 non-blocking): generous for servers started from
  // nested subdirectories while still bounded.
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "infra");
    if (existsFn(join(candidate, "Pulumi.yaml"))) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Pulumi env for spawned commands. The stack's passphrase is the empty string
 * (documented in docs/deploy-minsky-railway.md; revisit in mt#2442) — an
 * explicit override in the caller's environment wins.
 */
function pulumiEnv(): Record<string, string | undefined> {
  return {
    ...process.env,
    PULUMI_CONFIG_PASSPHRASE: process.env["PULUMI_CONFIG_PASSPHRASE"] ?? "",
  };
}

async function callGetMe(token: string): Promise<CredentialCheckResult> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 401) {
    return {
      ok: false,
      detail: "401 Unauthorized — bot token invalid or revoked",
      unauthorized: true,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: `non-JSON response (HTTP ${response.status})` };
  }
  const data = body as { ok?: boolean; result?: { username?: string; first_name?: string } };
  if (!response.ok || data.ok !== true) {
    return { ok: false, detail: `Telegram getMe failed (HTTP ${response.status})` };
  }
  const name = data.result?.username ?? data.result?.first_name ?? "bot";
  return { ok: true, detail: `telegram:@${name}` };
}

async function callGetUpdatesSummary(token: string): Promise<CredentialCheckResult> {
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  } catch (error) {
    return {
      ok: false,
      detail: `network error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (response.status === 401) {
    return {
      ok: false,
      detail: "401 Unauthorized — stored token no longer valid",
      unauthorized: true,
    };
  }
  if (response.status === 409) {
    // A Telegram webhook is registered on the bot; getUpdates is blocked.
    // The token works — flag as a scope-style gap so discovery issues are
    // visible at add-time rather than at discover-chat-id time.
    return {
      ok: true,
      scopeGap: true,
      detail:
        "token valid, but a Telegram webhook is set on this bot — chat-id discovery (getUpdates) is blocked until it is deleted",
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, detail: `non-JSON response (HTTP ${response.status})` };
  }
  const data = body as { ok?: boolean; result?: Array<{ message?: { chat?: { id?: unknown } } }> };
  if (!response.ok || data.ok !== true) {
    return { ok: false, detail: `Telegram getUpdates failed (HTTP ${response.status})` };
  }
  const chatCount = new Set(
    (data.result ?? [])
      .map((u) => u.message?.chat?.id)
      .filter((id) => id !== undefined)
      .map(String)
  ).size;
  if (chatCount === 0) {
    // Self-disambiguating hint (2026-06-11 retro): name the exact bot this
    // token belongs to — "your bot" is ambiguous when the operator has
    // several or messaged the wrong one. Best-effort getMe; generic fallback.
    let botHint = "your bot";
    const me = await callGetMe(token);
    if (me.ok && me.detail.startsWith("telegram:@")) {
      botHint = me.detail.slice("telegram:".length);
    }
    return {
      ok: true,
      scopeGap: true,
      detail: `token valid; no chats visible yet — send ${botHint} one message so chat-id discovery can find you`,
    };
  }
  return { ok: true, detail: `token valid; ${chatCount} chat(s) visible to discovery` };
}

/** Store the token into the Pulumi stack config (value via STDIN — never argv). */
async function storeInPulumi(token: string): Promise<{ location: string }> {
  const infraDir = resolveInfraDir();
  if (!infraDir) {
    throw new Error(
      "Could not locate the Pulumi project (infra/Pulumi.yaml) from the server's working " +
        "directory. Start the cockpit from the Minsky repo root."
    );
  }
  const proc = Bun.spawnSync(
    ["pulumi", "-C", infraDir, "config", "set", "--secret", TELEGRAM_PULUMI_SECRET_KEY],
    {
      stdin: Buffer.from(`${token}\n`),
      stdout: "pipe",
      stderr: "pipe",
      env: pulumiEnv(),
    }
  );
  if (proc.exitCode !== 0) {
    const err = proc.stderr.toString().trim();
    // The token rides stdin, so stderr cannot embed it; still, never echo stdout.
    throw new Error(`pulumi config set failed: ${err || `exit ${proc.exitCode}`}`);
  }
  return { location: `pulumi stack config (${TELEGRAM_PULUMI_SECRET_KEY})` };
}

/**
 * Read the stored token back from the Pulumi stack config (PR #1672 R1) so
 * recheck/401-invalidation work for this provider-owned credential. The value
 * is captured and returned in-process — never printed.
 */
async function readFromPulumi(): Promise<string | null> {
  const infraDir = resolveInfraDir();
  if (!infraDir) return null;
  const proc = Bun.spawnSync(
    ["pulumi", "-C", infraDir, "config", "get", TELEGRAM_PULUMI_SECRET_KEY],
    { stdout: "pipe", stderr: "pipe", env: pulumiEnv() }
  );
  if (proc.exitCode !== 0) return null;
  const token = proc.stdout.toString().trim();
  return token || null;
}

/** Delete the token from the Pulumi stack config (PR #1672 R1). */
async function removeFromPulumi(): Promise<{ removed: boolean }> {
  const infraDir = resolveInfraDir();
  if (!infraDir) return { removed: false };
  const proc = Bun.spawnSync(
    ["pulumi", "-C", infraDir, "config", "rm", TELEGRAM_PULUMI_SECRET_KEY],
    { stdout: "pipe", stderr: "pipe", env: pulumiEnv() }
  );
  return { removed: proc.exitCode === 0 };
}

async function isConfiguredInPulumi(): Promise<boolean> {
  const infraDir = resolveInfraDir();
  if (!infraDir) return false;
  // `pulumi config` LISTS keys without decrypting values (secrets render as
  // [secret]) — presence check only; nothing secret reaches this process.
  const proc = Bun.spawnSync(["pulumi", "-C", infraDir, "config"], {
    stdout: "pipe",
    stderr: "pipe",
    env: pulumiEnv(),
  });
  if (proc.exitCode !== 0) return false;
  return proc.stdout.toString().includes(TELEGRAM_PULUMI_SECRET_KEY.replace(/^secrets:/, ""));
}

export const telegramProvider: CredentialProvider = {
  id: "telegram",
  displayName: "Telegram (reviewer alerts)",
  // Display-only: storage is provider-owned (Pulumi), not config.yaml.
  configPath: TELEGRAM_PULUMI_SECRET_KEY,
  acquireUrl: "https://t.me/BotFather",
  scopeGuidance:
    "Create a bot with /newbot in @BotFather and copy its token (no extra scopes needed). " +
    "Then send your new bot one message — chat-id discovery needs it.",
  validate: callGetMe,
  test: callGetUpdatesSummary,
  store: storeInPulumi,
  read: readFromPulumi,
  remove: removeFromPulumi,
  isConfigured: isConfiguredInPulumi,
  // Deployment-specific provider (mt#2419): only surfaced where this
  // deployment's Pulumi project (the storage target) is resolvable. Users
  // without an infra/ stack never see it. Long-term home: mt#2442.
  isAvailable: () => resolveInfraDir() !== null,
};
