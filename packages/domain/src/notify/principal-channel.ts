/**
 * Principal channel — the agent-reachable "message the principal" surface (mt#3228).
 *
 * Before this module there was no way for an agent to reach the principal's
 * phone at all: the Telegram capability existed, but only as the reviewer
 * service's circuit-breaker alert sink, firing on one seam and invocable by
 * nothing.
 *
 * ## Where the credentials come from, and why there is no second copy
 *
 * The bot token's source of truth is the Pulumi stack config
 * (`secrets:minsky-reviewer-telegram-bot-token`), because the DEPLOYED reviewer
 * consumes it via IaC-managed Railway env vars. Storing a second copy in
 * `config.yaml` would create a token nothing reads — the rationale mt#2431 was
 * closed on. So resolution is:
 *
 *   1. `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` env — how the deployed
 *      services already receive them (infra/index.ts `defineVariables`), and
 *      the override a test or a second stack uses.
 *   2. Pulumi stack config — how a local process (cockpit daemon, MCP server)
 *      reads the same single copy.
 *
 * Resolution is cached: step 2 spawns the `pulumi` CLI, which is far too slow
 * to repeat per message.
 *
 * ## Bot identity
 *
 * v1 REUSES the reviewer's bot rather than provisioning a dedicated one. Both
 * its token and the principal's chat id are already set on the stack — the chat
 * id's presence is itself proof the principal has messaged the bot, which is
 * the one step Telegram requires a human to perform (there is no API to look up
 * a chat id). Reuse therefore costs the principal zero setup steps. Switching
 * to a dedicated bot later is a config change, not a code change, because both
 * values resolve through this one function.
 *
 * @see mt#3228 — the bidirectional principal channel
 * @see ./telegram-transport.ts — the wire-level Bot API calls
 * @see packages/domain/src/credentials/providers/telegram.ts — Pulumi-backed token storage
 */

import { log } from "@minsky/shared/logger";
import { sendTelegramMessage, type FetchFn } from "./telegram-transport";

/** Pulumi stack-config key holding the principal's chat id (plain, not secret). */
export const TELEGRAM_CHAT_ID_PULUMI_KEY = "reviewer-telegram-chat-id";

/** How long a successful resolution is reused before re-reading Pulumi. */
const RESOLUTION_CACHE_MS = 5 * 60 * 1000;

/** Resolved credentials plus where they came from (surfaced in diagnostics). */
export interface PrincipalChannelConfig {
  token: string;
  chatId: string;
  source: "env" | "pulumi" | "mixed";
}

export type PrincipalChannelResolution =
  | { configured: true; config: PrincipalChannelConfig }
  | { configured: false; reason: string };

/**
 * Injected readers. Both default to the real sources; tests pass stubs so no
 * test ever spawns `pulumi` or depends on ambient env.
 */
export interface PrincipalChannelDeps {
  readEnv?: (name: string) => string | undefined;
  /** Decrypted bot token from the Pulumi stack config, or null. */
  readPulumiToken?: () => Promise<string | null>;
  /** Plain (non-secret) Pulumi stack-config value, or null. */
  readPulumiPlain?: (key: string) => Promise<string | null>;
  fetchFn?: FetchFn;
  /** Injected clock so cache-expiry is testable without waiting. */
  now?: () => number;
}

interface CacheEntry {
  resolution: PrincipalChannelResolution;
  resolvedAtMs: number;
}

let cache: CacheEntry | null = null;

/** Drop the memoized resolution — for tests, and after a credential change. */
export function clearPrincipalChannelCache(): void {
  cache = null;
}

/**
 * Resolve the channel's credentials, or explain precisely what is missing.
 *
 * The unconfigured branch returns a `reason` naming BOTH candidate sources
 * rather than a bare "not configured": an operator hitting this needs to know
 * whether to set an env var or run `pulumi config set`, and which of the two
 * values is the one that is absent.
 */
export async function resolvePrincipalChannel(
  deps: PrincipalChannelDeps = {}
): Promise<PrincipalChannelResolution> {
  const now = deps.now ?? Date.now;
  if (cache && now() - cache.resolvedAtMs < RESOLUTION_CACHE_MS) {
    return cache.resolution;
  }

  const resolution = await resolveUncached(deps);
  // Only a success is cached. A miss is cheap to recompute and an operator who
  // just ran `pulumi config set` should see the effect immediately rather than
  // wait out a cache window.
  if (resolution.configured) {
    cache = { resolution, resolvedAtMs: now() };
  }
  return resolution;
}

async function resolveUncached(deps: PrincipalChannelDeps): Promise<PrincipalChannelResolution> {
  const readEnv = deps.readEnv ?? ((name: string) => process.env[name]);

  const envToken = nonEmpty(readEnv("TELEGRAM_BOT_TOKEN"));
  const envChatId = nonEmpty(readEnv("TELEGRAM_CHAT_ID"));

  const token = envToken ?? nonEmpty(await readPulumiToken(deps));
  const chatId = envChatId ?? nonEmpty(await readPulumiChatId(deps));

  if (!token && !chatId) {
    return {
      configured: false,
      reason:
        "Telegram principal channel is not configured: neither TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID " +
        "are set in the environment, nor are the Pulumi stack values " +
        `(secrets:minsky-reviewer-telegram-bot-token, ${TELEGRAM_CHAT_ID_PULUMI_KEY}) readable.`,
    };
  }
  if (!token) {
    return {
      configured: false,
      reason:
        "Telegram principal channel has a chat id but no bot token. Set TELEGRAM_BOT_TOKEN, or " +
        "store the token via the cockpit credentials widget (Telegram provider) / " +
        "`pulumi -C infra config set --secret secrets:minsky-reviewer-telegram-bot-token`.",
    };
  }
  if (!chatId) {
    return {
      configured: false,
      reason:
        "Telegram principal channel has a bot token but no chat id. Message the bot once, then " +
        "run `bun scripts/reviewer-alerts/discover-chat-id.ts` and set it with " +
        `\`pulumi -C infra config set ${TELEGRAM_CHAT_ID_PULUMI_KEY} <id>\` (or TELEGRAM_CHAT_ID).`,
    };
  }

  const source: PrincipalChannelConfig["source"] =
    envToken && envChatId ? "env" : !envToken && !envChatId ? "pulumi" : "mixed";
  return { configured: true, config: { token, chatId, source } };
}

async function readPulumiToken(deps: PrincipalChannelDeps): Promise<string | null> {
  if (deps.readPulumiToken) return deps.readPulumiToken();
  try {
    // Lazy import: the credentials provider reaches for the filesystem and the
    // `pulumi` binary at module scope-adjacent paths, and this module is
    // imported by surfaces (tests, the browser-facing bundle) that have
    // neither.
    const { telegramProvider } = await import("../credentials/providers/telegram");
    return (await telegramProvider.read?.()) ?? null;
  } catch (err: unknown) {
    log.debug("principal-channel: Pulumi token read failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function readPulumiChatId(deps: PrincipalChannelDeps): Promise<string | null> {
  if (deps.readPulumiPlain) return deps.readPulumiPlain(TELEGRAM_CHAT_ID_PULUMI_KEY);
  try {
    const { resolveInfraDir } = await import("../credentials/providers/telegram");
    const infraDir = resolveInfraDir();
    if (!infraDir) return null;
    // `config get` on a PLAIN key decrypts nothing and returns no secret; the
    // chat id is an operator identifier, not a credential.
    const proc = Bun.spawnSync(
      ["pulumi", "-C", infraDir, "config", "get", TELEGRAM_CHAT_ID_PULUMI_KEY],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PULUMI_CONFIG_PASSPHRASE: process.env["PULUMI_CONFIG_PASSPHRASE"] ?? "",
        },
        timeout: 5000,
      }
    );
    if (proc.exitCode !== 0) return null;
    return proc.stdout.toString().trim() || null;
  } catch {
    return null;
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

export interface NotifyPrincipalOptions {
  /** Message body. Sent as plain text. */
  message: string;
  /** Optional leading line, rendered above the body. */
  title?: string;
  /** Thread this under an earlier message in the chat. */
  replyToMessageId?: number;
  deps?: PrincipalChannelDeps;
}

export type NotifyPrincipalResult =
  | { delivered: true; messageId: number; chatId: string; source: string }
  | { delivered: false; reason: "not-configured" | "send-failed"; detail: string };

/**
 * Send the principal a message.
 *
 * Never throws, and never fails loudly on an unconfigured deployment: an agent
 * calling this on a machine with no channel set up gets a clear
 * `not-configured` result it can report, not a crash mid-task. A genuine
 * delivery failure is distinguished from absence so the caller can tell "you
 * have no channel" from "your channel is broken".
 */
export async function notifyPrincipal(
  opts: NotifyPrincipalOptions
): Promise<NotifyPrincipalResult> {
  const deps = opts.deps ?? {};
  const resolution = await resolvePrincipalChannel(deps);
  if (!resolution.configured) {
    return { delivered: false, reason: "not-configured", detail: resolution.reason };
  }

  const { token, chatId, source } = resolution.config;
  const text = opts.title ? `${opts.title}\n\n${opts.message}` : opts.message;

  const result = await sendTelegramMessage({
    token,
    chatId,
    text,
    ...(opts.replyToMessageId === undefined ? {} : { replyToMessageId: opts.replyToMessageId }),
    ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}),
  });

  if (!result.ok) {
    return { delivered: false, reason: "send-failed", detail: result.detail };
  }
  return { delivered: true, messageId: result.messageId, chatId, source };
}
