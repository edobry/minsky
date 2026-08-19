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
import {
  sendTelegramMessageWithThreadFallback,
  type FetchFn,
  type ThreadFallbackSendResult,
} from "./telegram-transport";

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
  | {
      configured: false;
      reason: string;
      /**
       * True when a credential READ FAILED, rather than the credential being
       * genuinely absent (mt#3608).
       *
       * The two used to be indistinguishable: both readers swallowed their
       * errors into `null`, so a DNS blip against the Pulumi backend produced
       * the same "not configured" verdict as an operator who had never set the
       * value. Callers therefore could not tell a transient fault from a
       * permanent one, and the channel's launch path — which gives up on
       * "not configured" — treated a five-second network hiccup as a
       * configuration decision and stayed off for the life of the process.
       *
       * `true` means "ask again shortly"; `false` means "an operator must act."
       */
      transient: boolean;
    };

/**
 * Outcome of one credential read: a value, a definite absence, or a failure.
 *
 * Deliberately NOT exported (PR #2627 R1): the two pure helpers below reference
 * it in their signatures, which does not require it to be public — this package
 * is consumed from source, so nothing needs to name the type externally. Keeping
 * it module-private avoids widening the deep-import surface
 * (`@minsky/domain/notify/principal-channel`) as a side effect of extracting a
 * testable helper.
 */
type CredentialRead = { ok: true; value: string | null } | { ok: false; error: string };

/**
 * Dependencies for credential RESOLUTION. Every member is REQUIRED, per ADR-026
 * tier 2 ("an explicit, **required** `deps` parameter (no `?`, no default
 * value)"), because each one reaches REAL INFRASTRUCTURE when absent: the real
 * environment, the real `pulumi` CLI, the real clock.
 *
 * An optional member with a real-implementation fallback is the shape ADR-026
 * bans outright, and the consequence it names — "silently connects tests to
 * real infrastructure when a caller forgets to inject a fake" — is not
 * hypothetical here. It is what this module did: two tests asserting the "not
 * configured on a bare machine" branch injected nothing, fell through to the
 * real readers, resolved real credentials, and delivered two live Telegram
 * messages to the principal on every full-suite run (mt#3557 / mt#3609).
 * Required members move that failure from runtime to COMPILE time.
 */
export interface PrincipalChannelResolveDeps {
  readEnv: (name: string) => string | undefined;
  /**
   * Decrypted bot token from the Pulumi stack config, or null when unset.
   * THROWS on a read FAILURE — a value that could not be read is not the same
   * as a value that is absent, and collapsing the two is what turned a
   * transient fault permanent (mt#3608).
   */
  readPulumiToken: () => Promise<string | null>;
  /**
   * Plain (non-secret) Pulumi stack-config value, or null when unset. THROWS
   * on a read failure, for the same reason as `readPulumiToken`.
   */
  readPulumiPlain: (key: string) => Promise<string | null>;
  /** Injected clock so cache-expiry is testable without waiting. */
  now: () => number;
}

/**
 * Dependencies for SENDING: the resolve set, plus the transport, plus the two
 * genuinely-optional topic hooks.
 */
export interface PrincipalChannelDeps extends PrincipalChannelResolveDeps {
  /**
   * Transport. REQUIRED for the same reason as the readers above — absent, a
   * send goes out over the real global `fetch`, which is the exact path by
   * which the mt#3557 tests reached Telegram.
   */
  fetchFn: FetchFn;
  /**
   * Resolve the Telegram topic bound to a task, if one exists (mt#3507).
   *
   * GENUINELY optional, unlike every member above: omitting it reaches no
   * infrastructure. A caller that never passes `taskId` to
   * {@link notifyPrincipal} never needs this, and one that does but has no
   * database reachable (e.g. running outside the cockpit daemon) degrades to
   * "no topic found", which is exactly the un-bound-task behavior the spec
   * calls for (post to the standing conversation).
   */
  lookupTaskTopic?: (taskId: string, chatId: string) => Promise<{ messageThreadId: number } | null>;
  /**
   * Record that a topic's mapping is dead after Telegram reported its thread
   * gone (mt#3507 drift reconciliation). Best-effort — a caller with no
   * persistence path simply cannot record it, and the send itself still
   * falls back correctly either way.
   */
  markTopicDead?: (chatId: string, messageThreadId: number) => Promise<void>;
}

/**
 * Construct the REAL dependency set — production wiring, made visible at the
 * call site that chose it.
 *
 * This is deliberately NOT the `deps?.x ?? createConfiguredX(...)` shape
 * ADR-026 bans. That ban is on an IMPLICIT fallback reached from inside the
 * consumer, which fires for a caller that never decided anything and cannot be
 * seen from the call site. Here the caller decides, by name, in its own
 * composition root, where a grep finds it. ADR-026 tier 2's own text has
 * callers constructing their dependencies directly — this is that, for the
 * production half, with tests constructing fakes on the other side.
 *
 * The topic hooks are deliberately absent: they need a database, they are
 * genuinely optional, and the callers that have one (the `principal.notify`
 * command) add them on top of this base.
 */
export function createRealPrincipalChannelDeps(): PrincipalChannelDeps {
  return {
    readEnv: (name: string) => process.env[name],
    readPulumiToken: readPulumiTokenFromStack,
    readPulumiPlain: readPulumiPlainFromStack,
    now: Date.now,
    // Wrapped rather than passed bare: a detached `globalThis.fetch` reference
    // loses its receiver in some runtimes.
    fetchFn: (url, init) => globalThis.fetch(url, init),
  };
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
  deps: PrincipalChannelResolveDeps
): Promise<PrincipalChannelResolution> {
  const now = deps.now;
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

async function resolveUncached(
  deps: PrincipalChannelResolveDeps
): Promise<PrincipalChannelResolution> {
  const readEnv = deps.readEnv;

  const envToken = nonEmpty(readEnv("TELEGRAM_BOT_TOKEN"));
  const envChatId = nonEmpty(readEnv("TELEGRAM_CHAT_ID"));

  // Env wins and cannot fail, so the Pulumi read is skipped entirely when the
  // env var is set — which also means an env-configured channel is immune to
  // the transient-failure class this distinction exists for.
  const tokenRead: CredentialRead =
    envToken !== undefined ? { ok: true, value: envToken } : await readPulumiToken(deps);
  const chatIdRead: CredentialRead =
    envChatId !== undefined ? { ok: true, value: envChatId } : await readPulumiChatId(deps);

  // A read that FAILED tells us nothing about whether the value exists, so the
  // verdict is "ask again", not "not configured" (mt#3608).
  const failures = [tokenRead, chatIdRead].filter(
    (r): r is Extract<CredentialRead, { ok: false }> => !r.ok
  );
  if (failures.length > 0) {
    return {
      configured: false,
      transient: true,
      reason:
        "Telegram principal channel credentials could not be READ (this is not the same as them " +
        `being unset): ${failures.map((f) => f.error).join("; ")}. The channel will retry.`,
    };
  }

  const token = nonEmpty(tokenRead.ok ? tokenRead.value : null);
  const chatId = nonEmpty(chatIdRead.ok ? chatIdRead.value : null);

  if (!token && !chatId) {
    return {
      configured: false,
      transient: false,
      reason:
        "Telegram principal channel is not configured: neither TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID " +
        "are set in the environment, nor are the Pulumi stack values " +
        `(secrets:minsky-reviewer-telegram-bot-token, ${TELEGRAM_CHAT_ID_PULUMI_KEY}) set.`,
    };
  }
  if (!token) {
    return {
      configured: false,
      transient: false,
      reason:
        "Telegram principal channel has a chat id but no bot token. Set TELEGRAM_BOT_TOKEN, or " +
        "store the token via the cockpit credentials widget (Telegram provider) / " +
        "`pulumi -C infra config set --secret secrets:minsky-reviewer-telegram-bot-token`.",
    };
  }
  if (!chatId) {
    return {
      configured: false,
      transient: false,
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

async function readPulumiToken(deps: PrincipalChannelResolveDeps): Promise<CredentialRead> {
  // ONE path, not two. `readPulumiToken` is required, so there is no longer an
  // else-branch that reaches the real provider behind an un-injected caller's
  // back — the real implementation lives in `readPulumiTokenFromStack` below
  // and is supplied EXPLICITLY, by callers that mean to use it.
  //
  // A reader that throws is a READ FAILURE, not an absent value (mt#3608).
  // That distinction is the whole point of this wrapper, and it now applies
  // uniformly to injected and real readers alike rather than only to one.
  try {
    return { ok: true, value: await deps.readPulumiToken() };
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    log.debug("principal-channel: Pulumi token read failed", { error });
    return { ok: false, error: `token read failed: ${error}` };
  }
}

/**
 * The REAL bot-token read, for {@link createRealPrincipalChannelDeps}.
 *
 * Throws on a read failure, per the {@link PrincipalChannelResolveDeps}
 * contract — the caller turns that into the retryable `ok: false` verdict.
 */
async function readPulumiTokenFromStack(): Promise<string | null> {
  // Lazy import: the credentials provider reaches for the filesystem and the
  // `pulumi` binary at module scope-adjacent paths, and this module is
  // imported by surfaces (tests, the browser-facing bundle) that have neither.
  const { telegramProvider } = await import("../credentials/providers/telegram");
  return (await telegramProvider.read?.()) ?? null;
}

/**
 * Structurally test whether `key` is set in a `pulumi config --json` payload
 * (mt#3698). Returns `null` when the question cannot be answered — unparseable
 * or non-object output — which callers must treat as "don't know", never as an
 * absence.
 *
 * Keys in the `--json` map are NAMESPACED (`minsky-infra:reviewer-telegram-chat-id`)
 * while `pulumi config get` accepts the bare key, so both forms match. Missing
 * this is not a cosmetic bug: a bare-key-only comparison reads EVERY key as
 * absent, reintroducing mt#3608's collapse through a new mechanism.
 *
 * The namespace is matched as ONE segment (PR #2627 R1) rather than by a bare
 * `endsWith`, so `a:b:reviewer-telegram-chat-id` no longer counts. A real map
 * does carry several namespaces at once (`minsky-infra:`, `secrets:`,
 * `railway:`, `pulumi:`), so this cannot pin the exact owning project without
 * reading `Pulumi.yaml`. That residual is deliberate and safe by direction: an
 * over-accepted match reports the key as PRESENT, and present routes to the
 * FAILURE branch — retryable — never to a false absence, which is the verdict
 * that would strand the channel.
 */
export function isPulumiConfigKeySet(configJson: string, key: string): boolean | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configJson);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const namespaced = new RegExp(`^[^:]+:${escapeForRegExp(key)}$`);
  return Object.keys(parsed as Record<string, unknown>).some(
    (k) => k === key || namespaced.test(k)
  );
}

/** Escape a literal for safe interpolation into a RegExp. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Decide what a non-zero `pulumi config get` exit MEANS: the key is genuinely
 * unset, or the read failed (mt#3698).
 *
 * Pulumi exits non-zero for both, and until mt#3698 this was decided by
 * regex-matching its stderr prose for three English phrases. That was already
 * WRONG on the installed CLI: Pulumi v3.252.0 says `configuration key 'x' not
 * found for stack 'y'`, which matches none of them — so a genuinely unset key
 * was reported as a retryable failure, the exact collapse mt#3608 built this
 * distinction to prevent, inverted. Pulumi documents no error-text contract,
 * so no phrase list can be correct for long.
 *
 * `keyPresent` therefore comes from a STRUCTURAL lookup ({@link isPulumiConfigKeySet}):
 * `false` is the only value that proves absence. `true` (the key exists, so the
 * failure was something else) and `null` (presence undeterminable) are both
 * read failures — when in doubt, stay retryable rather than telling the caller
 * an operator must act.
 */
export function classifyPulumiConfigGetFailure(
  exitCode: number | null,
  stderr: string,
  keyPresent: boolean | null
): CredentialRead {
  if (keyPresent === false) return { ok: true, value: null };
  return {
    ok: false,
    error: `chat-id read failed: ${stderr || `exit ${exitCode ?? "unknown"}`}`,
  };
}

async function readPulumiChatId(deps: PrincipalChannelResolveDeps): Promise<CredentialRead> {
  // ONE path, as with `readPulumiToken` above — the real reader is
  // `readPulumiPlainFromStack`, supplied explicitly rather than fallen back to.
  try {
    return { ok: true, value: await deps.readPulumiPlain(TELEGRAM_CHAT_ID_PULUMI_KEY) };
  } catch (err: unknown) {
    return {
      ok: false,
      error: `chat-id read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The REAL plain-config read, for {@link createRealPrincipalChannelDeps}.
 *
 * Returns `null` for a genuine ABSENCE and THROWS on a read FAILURE, per the
 * {@link PrincipalChannelResolveDeps} contract. Keeping those two outcomes
 * distinct is mt#3608's fix and must survive this refactor: an absence is
 * final, a failure is retryable.
 */
async function readPulumiPlainFromStack(key: string): Promise<string | null> {
  {
    const { resolveInfraDir } = await import("../credentials/providers/telegram");
    const infraDir = resolveInfraDir();
    // A missing infra dir is a real ABSENCE, not a failure: there is no Pulumi
    // project here to read from, and retrying cannot change that.
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
    if (proc.exitCode !== 0) {
      // Pulumi exits non-zero BOTH for "this key is not set" and for "I could
      // not reach the backend." Only the first is an absence; the second is a
      // failure that a retry can clear, so they must not collapse (mt#3608).
      // WHICH one it is comes from a structural key-presence read, not from
      // Pulumi's error prose (mt#3698) — one extra spawn, and only on a path
      // that has already failed.
      const stderr = proc.stderr.toString().trim();
      const probe = Bun.spawnSync(["pulumi", "-C", infraDir, "config", "--json"], {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          PULUMI_CONFIG_PASSPHRASE: process.env["PULUMI_CONFIG_PASSPHRASE"] ?? "",
        },
        timeout: 5000,
      });
      // `config --json` without `--show-secrets` lists keys and leaves secret
      // values encrypted, so this never decrypts anything and never needs the
      // passphrase to succeed (verified against the live stack, mt#3698).
      const keyPresent =
        probe.exitCode === 0 ? isPulumiConfigKeySet(probe.stdout.toString(), key) : null;
      const classified = classifyPulumiConfigGetFailure(proc.exitCode, stderr, keyPresent);
      // The absence-vs-failure CLASSIFICATION is unchanged and still lives in
      // the exported, separately-tested helper. Only the carrier changes: an
      // absence becomes `null`, a failure becomes a throw.
      //
      // NO DIAGNOSTIC DETAIL IS LOST, and that is checkable rather than
      // asserted (PR #3168 R1): the helper's error is exactly
      // `"chat-id read failed: " + (stderr || "exit " + exitCode)`, and the
      // caller `readPulumiChatId` re-adds that same prefix to whatever this
      // throws. Throwing `classified.error` would therefore emit the prefix
      // TWICE; throwing the bare reason reproduces the helper's string
      // character-for-character. Both operands are read from the same `proc`,
      // so the two cannot drift apart.
      if (classified.ok) return classified.value;
      throw new Error(stderr || `exit ${proc.exitCode ?? "unknown"}`);
    }
    return proc.stdout.toString().trim() || null;
  }
  // A spawn failure (binary missing, timeout, DNS) is never an absence — it
  // propagates as a throw, which `readPulumiChatId` renders as a retryable
  // read failure.
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
  /**
   * Post into the Telegram topic bound to this task, if one exists — else
   * the standing conversation (mt#3507). Additive and optional: a caller
   * that omits it (every caller before this field existed, and any caller
   * today that has nothing to name) produces byte-for-byte the same wire
   * payload as before this field existed. Never creates a topic — an
   * unbound task always falls back to the standing conversation, by design
   * (topic creation is Phase 3, mt#3508).
   */
  taskId?: string;
  /**
   * REQUIRED (ADR-026 tier 2, mt#3609). Production callers pass
   * {@link createRealPrincipalChannelDeps}; tests pass fakes. There is no
   * default, so a caller that forgets cannot silently send over the real
   * network — it fails to compile.
   */
  deps: PrincipalChannelDeps;
}

export type NotifyPrincipalResult =
  | {
      delivered: true;
      messageId: number;
      chatId: string;
      source: string;
      /** Set when the topic named by `taskId` was gone and this landed in the standing conversation instead (mt#3507). */
      fellBackFromDeadTopic?: true;
    }
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
  const deps = opts.deps;
  const resolution = await resolvePrincipalChannel(deps);
  if (!resolution.configured) {
    return { delivered: false, reason: "not-configured", detail: resolution.reason };
  }

  const { token, chatId, source } = resolution.config;
  const text = opts.title ? `${opts.title}\n\n${opts.message}` : opts.message;

  // Only a caller naming a task, with a way to look one up, ever queries the
  // topic mapping — every other caller (every one before this field existed)
  // takes the exact path it always did. Absent-either-way is a NO-OP, not an
  // error: an unbound task, or a `taskId` with no lookup wired at all, both
  // mean "post to the standing conversation", which is this feature's own
  // documented fallback, not a degraded case.
  const topic =
    opts.taskId !== undefined && deps.lookupTaskTopic
      ? await deps.lookupTaskTopic(opts.taskId, chatId)
      : null;

  const markTopicDead = deps.markTopicDead;
  const result: ThreadFallbackSendResult = await sendTelegramMessageWithThreadFallback({
    token,
    chatId,
    text,
    ...(opts.replyToMessageId === undefined ? {} : { replyToMessageId: opts.replyToMessageId }),
    ...(topic === null ? {} : { messageThreadId: topic.messageThreadId }),
    fetchFn: deps.fetchFn,
    ...(markTopicDead
      ? { onThreadNotFound: (threadId: number) => markTopicDead(chatId, threadId) }
      : {}),
  });

  if (!result.ok) {
    return { delivered: false, reason: "send-failed", detail: result.detail };
  }
  return {
    delivered: true,
    messageId: result.messageId,
    chatId,
    source,
    ...(result.fellBackFromDeadTopic ? { fellBackFromDeadTopic: true as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// Task-topic mapping (mt#3507) — read/write access to `telegram_channel_topics`
// for the `principal.notify` command's `taskId` parameter and the poller's
// drift reconciliation. Lives here, not in the cockpit layer, because BOTH
// the cockpit daemon's poller AND the `principal.notify` shared command
// (which can run in a bare MCP-server process with no cockpit daemon at all)
// need it, and a domain module is the one place both can import from without
// inverting the Domain -> Adapters -> Infrastructure layering (adapters may
// depend on domain; domain must never depend on the cockpit application
// layer built on top of it).
// ---------------------------------------------------------------------------

/** Minimal shape of a SQL-capable Drizzle connection this module needs. */
export interface TelegramTopicDb {
  execute(query: unknown): Promise<unknown>;
}

/** Deps shared by the task-topic-mapping helpers below. */
export interface TaskTopicDeps {
  getDb: () => Promise<TelegramTopicDb | null>;
}

/**
 * Look up the Telegram topic bound to a task, if one exists.
 *
 * SCOPED BY CHAT, deliberately (PR #2513 R1). `telegram_channel_topics` is
 * unique on the PAIR `(chat_id, message_thread_id)`, not on the thread id
 * alone, so a thread id only identifies a topic WITHIN its chat. A lookup
 * that filtered on `entity_id` alone could return a thread belonging to a
 * different chat; sending it to the configured chat would fail with "message
 * thread not found", and the reconciliation that follows — which IS chat-scoped,
 * see {@link markTelegramChannelTopicDead} — would then match no row, leaving the
 * bad mapping in place so every subsequent notify for that task failed over
 * again. Scoping both sides identically is what keeps lookup and dead-marking
 * addressing the same row.
 *
 * Best-effort: a DB outage or an unreadable connection degrades to "no topic
 * found" rather than throwing, because the caller's correct behavior on a
 * genuinely unbound task is IDENTICAL (post to the standing conversation) —
 * there is no distinct failure mode to surface here that the caller would act
 * on differently.
 */
export async function findTelegramTopicForTask(
  taskId: string,
  chatId: string,
  deps: TaskTopicDeps
): Promise<{ messageThreadId: number } | null> {
  const db = await deps.getDb();
  if (!db) return null;
  try {
    const { sql } = await import("drizzle-orm");
    const rows = (await db.execute(sql`
      SELECT message_thread_id FROM telegram_channel_topics
      WHERE chat_id = ${chatId} AND entity_type = 'task' AND entity_id = ${taskId}
      LIMIT 1
    `)) as Array<{ message_thread_id: number }>;
    const row = rows[0];
    return row ? { messageThreadId: row.message_thread_id } : null;
  } catch (err: unknown) {
    log.debug("principal-channel: task-topic lookup failed", {
      taskId,
      chatId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Mark a topic's mapping dead after Telegram reports its thread gone
 * (mt#3507 drift reconciliation).
 *
 * Deletes the mapping row rather than adding a soft-delete flag: a deleted
 * Telegram topic's thread id is gone forever (Telegram never reuses one), so
 * there is nothing to reactivate later, and a future send targeting the same
 * task finds no row — exactly the "unbound task" case, which already falls
 * back to the standing conversation. Best-effort and never throws: this runs
 * from inside a send's error path, and a failure to record the deletion must
 * never turn into a failure to deliver the fallback message the caller is
 * already in the middle of sending.
 */
export async function markTelegramChannelTopicDead(
  chatId: string,
  messageThreadId: number,
  deps: TaskTopicDeps
): Promise<void> {
  const db = await deps.getDb();
  if (!db) {
    log.warn("principal-channel: could not mark a topic mapping dead (no DB)", {
      chatId,
      messageThreadId,
    });
    return;
  }
  try {
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`
      DELETE FROM telegram_channel_topics
      WHERE chat_id = ${chatId} AND message_thread_id = ${messageThreadId}
    `);
    log.warn(
      "principal-channel: marked a topic mapping dead after Telegram reported its thread gone",
      { chatId, messageThreadId }
    );
  } catch (err: unknown) {
    log.warn("principal-channel: failed to mark a topic mapping dead", {
      chatId,
      messageThreadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
