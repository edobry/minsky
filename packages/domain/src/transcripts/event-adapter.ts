/**
 * Transcript → semantic-event adapter (mt#3157, Phase 0 of the
 * watchable-world program).
 *
 * Pure, dependency-free (like `conversation-elements.ts`) batch adapter:
 * walks the FULL `TranscriptMessage[]` array returned by
 * `getTranscript()` (the `provenance/transcript-service.ts` seam — see the
 * module-boundary note below) and emits an ordered `SemanticEvent[]`.
 *
 * ## Input seam (RFC Amendment 1 / ADR-025 coordination)
 *
 * This module intentionally does NOT read `agent_transcripts.transcript`
 * directly. `AgentTranscriptService.getTranscript()`
 * (`../provenance/transcript-service.ts`) is the seam: mt#2580 will drop the
 * raw JSONB column in favor of an object-store archive, and `getTranscript`
 * is reader #3 in that task's re-point enumeration — riding the seam means
 * this adapter's callers (see `scripts/export-gource-log.ts`) carry across
 * that migration with zero discovery cost. Callers are responsible for
 * fetching the `TranscriptMessage[]` and passing it in here; this module
 * takes no DB dependency of its own (kept pure and unit-testable, matching
 * `conversation-elements.ts`'s precedent).
 *
 * ## Pairing algorithm (RFC Amendment 1)
 *
 * Per-call `t_end`/`outcome` come from pairing each assistant-line `tool_use`
 * block with the matching `tool_result` block carried in the IMMEDIATELY
 * FOLLOWING user-role line (matched on `tool_use.id === tool_result.tool_use_id`).
 * All `tool_use` blocks on one assistant line share one `batchId` and one
 * `tStart` — this is the parallel-tool-batch signal; this adapter never
 * synthesizes an order within a batch.
 *
 * ## Actor attribution (RFC Amendment 2)
 *
 * A transcript's ASSISTANT-role turns are always attributed to this
 * transcript's own agent (`context.agentSessionId`). Its USER-role turns are
 * attributed via `context.userTurnActor`, which the CALLER resolves BEFORE
 * invoking this adapter: `{ kind: "principal" }` for a top-level
 * conversation, or `{ kind: "agent", agentSessionId: <parent> }` when this
 * transcript is linked as a spawn child via `agent_spawns` — including its
 * very first user-role line, the dispatch prompt (see
 * `event-adapter.test.ts`'s child-dispatch-prompt-attribution test).
 *
 * ## Tool → verb/realm/target mapping (RFC SC 2 / Amendment 5)
 *
 * `resolveToolMapping` below is the versioned adapter contract: an explicit
 * seed registry (keyed by BARE tool name, same normalization convention as
 * the cockpit's `tool-name.ts` `parseToolName` — reimplemented locally here
 * rather than imported, since `packages/domain` must not depend on the
 * `src/cockpit/web` frontend bundle), a generic name/server pattern fallback,
 * and a TOTAL fallback (`execute` + `unmapped: true`) that never drops an
 * event. `computeAdapterCoverage` reports the fraction of tool-call events
 * that avoided the total fallback (mt#3157 SC 2's coverage metric).
 *
 * @see event-schema.ts — the SemanticEvent shape this module produces
 * @see gource-exporter.ts — the Phase-0 consumer
 * @see turn-extractor.ts — sibling module; shares the synthetic-interrupt-marker convention
 */

import type { TranscriptMessage } from "../provenance/transcript-service";
import {
  EVENT_SCHEMA_VERSION,
  weightForVerb,
  type EventActor,
  type EventOutcome,
  type EventRealm,
  type EventTarget,
  type EventVerb,
  type SemanticEvent,
} from "./event-schema";

// ── Adapter contract version ──────────────────────────────────────────────────

/**
 * Adapter contract version, independent of `EVENT_SCHEMA_VERSION` (the event
 * SHAPE can stay stable while the tool→verb/realm registry below evolves).
 */
export const ADAPTER_VERSION = "event-adapter-v0" as const;

// ── Context ───────────────────────────────────────────────────────────────────

export interface AdapterContext {
  /** This transcript's own harness conversation id. */
  agentSessionId: string;
  /**
   * Attribution for USER-role turns (RFC Amendment 2). Callers resolve this
   * BEFORE calling the adapter: query `agent_spawns` for a row where
   * `child_agent_session_id === agentSessionId`; if found, attribute to
   * `{ kind: "agent", agentSessionId: <parentAgentSessionId> }`, else
   * `{ kind: "principal" }`.
   */
  userTurnActor: EventActor;
  /** Overrides {@link ADAPTER_VERSION} for events emitted in this call (test seam). */
  adapterVersion?: string;
  /** Prefix used to compose `file:<repoRoot>:<path>` target ids. Defaults to `"workspace"`. */
  repoRoot?: string;
}

// ── Content-block shape (mirrors turn-extractor.ts's local ContentBlock) ─────

interface ContentBlock {
  type?: string;
  text?: unknown;
  thinking?: unknown;
  name?: unknown;
  input?: unknown;
  id?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

function normalizeContent(content: unknown): ContentBlock[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content.filter((b): b is ContentBlock => b !== null && typeof b === "object");
  }
  return [];
}

/**
 * Resolve a `TranscriptMessage`'s actual content payload.
 *
 * DISCOVERY (verified against live `agent_transcripts` rows, mt#3157
 * implementation): despite `TranscriptMessage`'s declared shape (`content`
 * flattened directly onto the message), the REAL production ingestion path
 * (`agent-transcript-ingest-service.ts`, not the transitional/legacy
 * `AgentTranscriptService.ingestTranscript`) writes the raw harness JSONL
 * line verbatim — `{ type, message: { role, content }, timestamp, uuid, cwd,
 * ... }` — matching `transcript-source.ts`'s `RawTurnLine` shape, i.e. the
 * SAME nested shape `turn-extractor.ts` reads (`line.message.content`), not
 * the flattened `TranscriptMessage.content` the seam's TS type promises.
 * This resolver reads the nested `message.content` when present (the live
 * shape) and falls back to the flat `.content` field (the seam's documented
 * type, and this module's own test fixtures) otherwise — defensive against
 * either shape rather than trusting the seam's type annotation.
 */
interface RawTranscriptLineShape extends TranscriptMessage {
  /** Present on real production rows (see the resolver doc comment above). */
  message?: { content?: unknown; [key: string]: unknown };
}

function resolveInnerContent(msg: TranscriptMessage): unknown {
  const raw = msg as RawTranscriptLineShape;
  if (raw.message !== null && typeof raw.message === "object" && "content" in (raw.message ?? {})) {
    return raw.message?.content;
  }
  return msg.content;
}

/**
 * Claude Code's synthesized "user cancelled" marker (mt#3131 D6) — harness
 * plumbing, not a real prompt. Duplicated (not imported) from
 * `turn-extractor.ts`'s `SYNTHETIC_INTERRUPT_MARKERS`, matching that file's
 * own documented precedent of deliberately non-shared constants between
 * transcript-processing modules.
 */
const SYNTHETIC_INTERRUPT_MARKERS: ReadonlySet<string> = new Set([
  "[Request interrupted by user for tool use]",
  "[Request interrupted by user]",
]);

function extractPlainText(blocks: readonly ContentBlock[]): string | null {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}

function isSyntheticInterruptText(text: string): boolean {
  return SYNTHETIC_INTERRUPT_MARKERS.has(text.trim());
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Flatten a tool_result's `content` (string, or Anthropic text-block array) to plain text. */
function resultContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : ""
      )
      .filter((s) => s.length > 0)
      .join("\n");
  }
  return "";
}

// ── Tool-name normalization (local reimplementation — see module doc) ───────

interface ParsedToolName {
  server: string | null;
  name: string;
}

const MCP_NAME_RE = /^mcp__(.+?)__(.+)$/;

function parseToolNameLocal(raw: string): ParsedToolName {
  const m = MCP_NAME_RE.exec(raw);
  if (m && m[1] !== undefined && m[2] !== undefined) {
    return { server: m[1], name: m[2] };
  }
  return { server: null, name: raw };
}

// ── Target extraction ─────────────────────────────────────────────────────────

interface TargetResult {
  id: string;
  raw?: unknown;
}

type TargetExtractor = (
  input: unknown,
  result: ToolResultInfo | undefined,
  context: AdapterContext
) => TargetResult | TargetResult[] | null;

export interface ToolResultInfo {
  content: unknown;
  isError: boolean;
}

function pathTargetExtractor(
  input: unknown,
  _result: ToolResultInfo | undefined,
  context: AdapterContext
): TargetResult | null {
  const rec = asRecord(input);
  const path = rec ? (str(rec.file_path) ?? str(rec.path) ?? str(rec.filePath)) : undefined;
  if (!path) return null;
  return { id: `file:${context.repoRoot ?? "workspace"}:${path}`, raw: path };
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function webTargetExtractor(input: unknown): TargetResult | null {
  const rec = asRecord(input);
  const url = rec ? str(rec.url) : undefined;
  if (!url) return null;
  const domain = domainOf(url);
  if (!domain) return null;
  return { id: `web:${domain}`, raw: url };
}

/**
 * A search resolving to N domains emits N sibling target results sharing the
 * caller's batchId (RFC Amendment 4 — reuses the batch mechanism, no schema
 * change). URLs are mined from the tool-result text; falls back to a bare
 * `web:search` target keyed on the query when no URL is present in the
 * result (e.g. an unresolved/errored search).
 */
function webSearchTargetExtractor(
  input: unknown,
  result: ToolResultInfo | undefined
): TargetResult[] | null {
  const rec = asRecord(input);
  const query = rec ? str(rec.query) : undefined;
  const text = result ? resultContentText(result.content) : "";
  const domains = new Set<string>();
  const urlRe = /https?:\/\/[^\s"')\]]+/g;
  for (const m of text.match(urlRe) ?? []) {
    const d = domainOf(m);
    if (d) domains.add(d);
  }
  if (domains.size > 0) {
    return [...domains].map((d) => ({ id: `web:${d}`, raw: query }));
  }
  return [{ id: "web:search", raw: query }];
}

function agentSpawnTargetExtractor(input: unknown): TargetResult {
  const rec = asRecord(input);
  const kind = rec ? str(rec.subagent_type) : undefined;
  return { id: `agents:${kind ?? "unknown"}`, raw: input };
}

/** A synthetic directory-grain target for `session_start` (RFC Amendment 3's "clone" mapping). */
function sessionCloneTargetExtractor(input: unknown): TargetResult {
  const rec = asRecord(input);
  const ref = rec ? (str(rec.task) ?? str(rec.sessionId) ?? str(rec.repo)) : undefined;
  return { id: `minsky:workspace:${ref ?? "unknown"}`, raw: input };
}

function shellTargetExtractor(input: unknown): TargetResult {
  const rec = asRecord(input);
  const cmd = rec ? (str(rec.command) ?? str(rec.script)) : undefined;
  return { id: `shell:${cmd ? cmd.slice(0, 60) : "cmd"}`, raw: cmd };
}

function gitPathTargetExtractor(
  input: unknown,
  _result: ToolResultInfo | undefined,
  context: AdapterContext
): TargetResult | null {
  const rec = asRecord(input);
  const path = rec ? (str(rec.path) ?? str(rec.file) ?? str(rec.ref)) : undefined;
  if (!path) return null;
  return { id: `file:${context.repoRoot ?? "workspace"}:${path}`, raw: path };
}

/** Generic minsky-substrate entity target: `taskId`/`id`/`sessionId`/`task` on the input. */
function minskySubstrateTargetExtractor(entityKind: string): TargetExtractor {
  return (input: unknown): TargetResult => {
    const rec = asRecord(input);
    const ref = rec
      ? (str(rec.taskId) ?? str(rec.id) ?? str(rec.sessionId) ?? str(rec.task))
      : undefined;
    return { id: `minsky:${entityKind}:${ref ?? "unknown"}`, raw: input };
  };
}

// ── Tool → verb/realm registry (mt#3157 SC 2, versioned adapter contract) ───

interface ToolMapping {
  verb: EventVerb;
  realm: EventRealm;
  extractTarget?: TargetExtractor;
}

/**
 * Explicit seed registry, keyed by BARE tool name. Deliberately a small
 * proof-of-pattern set (same precedent as `tool-summary.ts`'s seed registry)
 * — broader per-tool coverage is added reactively via the coverage metric,
 * not pre-built exhaustively.
 */
const EXPLICIT_TOOL_REGISTRY: Record<string, ToolMapping> = {
  Read: { verb: "read", realm: "repo", extractTarget: pathTargetExtractor },
  Write: { verb: "write", realm: "repo", extractTarget: pathTargetExtractor },
  Edit: { verb: "write", realm: "repo", extractTarget: pathTargetExtractor },
  session_read_file: { verb: "read", realm: "repo", extractTarget: pathTargetExtractor },
  session_write_file: { verb: "write", realm: "repo", extractTarget: pathTargetExtractor },
  session_edit_file: { verb: "write", realm: "repo", extractTarget: pathTargetExtractor },
  "session_edit-file": { verb: "write", realm: "repo", extractTarget: pathTargetExtractor },
  session_delete_file: { verb: "delete", realm: "repo", extractTarget: pathTargetExtractor },
  session_move_file: { verb: "write", realm: "repo", extractTarget: pathTargetExtractor },
  session_rename_file: { verb: "write", realm: "repo", extractTarget: pathTargetExtractor },
  repo_read_file: { verb: "read", realm: "repo", extractTarget: pathTargetExtractor },
  repo_list_directory: { verb: "read", realm: "repo", extractTarget: pathTargetExtractor },
  session_list_directory: { verb: "read", realm: "repo", extractTarget: pathTargetExtractor },
  session_grep_search: { verb: "search", realm: "repo" },
  repo_search: { verb: "search", realm: "repo" },
  Bash: { verb: "execute", realm: "shell", extractTarget: shellTargetExtractor },
  session_exec: { verb: "execute", realm: "shell", extractTarget: shellTargetExtractor },
  git_log: { verb: "read", realm: "repo", extractTarget: gitPathTargetExtractor },
  git_diff: { verb: "read", realm: "repo", extractTarget: gitPathTargetExtractor },
  git_status: { verb: "read", realm: "repo" },
  git_blame: { verb: "read", realm: "repo", extractTarget: gitPathTargetExtractor },
  git_search: { verb: "search", realm: "repo" },
  git_commit: { verb: "write", realm: "repo" },
  git_push: { verb: "write", realm: "repo" },
  git_pull: { verb: "write", realm: "repo" },
  git_stash: { verb: "write", realm: "repo" },
  git_reset: { verb: "write", realm: "repo" },
  git_restore: { verb: "write", realm: "repo", extractTarget: gitPathTargetExtractor },
  session_commit: { verb: "write", realm: "minsky-substrate" },
  session_start: {
    verb: "clone",
    realm: "minsky-substrate",
    extractTarget: sessionCloneTargetExtractor,
  },
  session_pr_create: {
    verb: "create",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("changeset"),
  },
  session_pr_merge: {
    verb: "write",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("changeset"),
  },
  tasks_get: {
    verb: "read",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("task"),
  },
  tasks_list: { verb: "read", realm: "minsky-substrate" },
  tasks_search: { verb: "search", realm: "minsky-substrate" },
  tasks_spec_get: {
    verb: "read",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("task"),
  },
  tasks_create: {
    verb: "create",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("task"),
  },
  tasks_edit: {
    verb: "write",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("task"),
  },
  tasks_status_set: {
    verb: "write",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("task"),
  },
  tasks_spec_patch: {
    verb: "write",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("task"),
  },
  tasks_delete: {
    verb: "delete",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("task"),
  },
  memory_search: { verb: "search", realm: "minsky-substrate" },
  memory_create: {
    verb: "create",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("memory"),
  },
  memory_get: {
    verb: "read",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("memory"),
  },
  asks_create: {
    verb: "ask",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("ask"),
  },
  asks_respond: {
    verb: "respond",
    realm: "minsky-substrate",
    extractTarget: minskySubstrateTargetExtractor("ask"),
  },
  "asks_wait-for-response": { verb: "wait", realm: "minsky-substrate" },
  WebFetch: { verb: "read", realm: "web", extractTarget: webTargetExtractor },
  WebSearch: { verb: "search", realm: "web", extractTarget: webSearchTargetExtractor },
  Agent: { verb: "spawn", realm: "agents", extractTarget: agentSpawnTargetExtractor },
};

/** Realm inference from MCP server name / bare-name prefix (generic fallback tier). */
function inferRealmFromServer(server: string | null, bareName: string): EventRealm | null {
  if (server === "github") return "repo";
  if (server && server.toLowerCase().includes("notion")) return "notion";
  const n = bareName.toLowerCase();
  if (n.startsWith("git_")) return "repo";
  if (
    n.startsWith("tasks_") ||
    n.startsWith("memory_") ||
    n.startsWith("session_") ||
    n.startsWith("rules_") ||
    n.startsWith("asks_") ||
    n.startsWith("workspace_") ||
    n.startsWith("changeset_")
  ) {
    return "minsky-substrate";
  }
  return null;
}

/** Verb inference from bare-name keyword patterns (generic fallback tier). */
function inferVerbFromName(bareName: string): EventVerb | null {
  const n = bareName.toLowerCase();
  if (/(delete|remove|close|cancel|drop)/.test(n)) return "delete";
  if (/create/.test(n)) return "create";
  if (/(write|edit|update|set|patch|add|merge|push|commit|open|approve|dismiss|resolve)/.test(n)) {
    return "write";
  }
  if (/(search|find|query|similar)/.test(n)) return "search";
  if (/(get|list|read|status|show|view|check|fetch)/.test(n)) return "read";
  if (/(exec|run)/.test(n)) return "execute";
  return null;
}

function inferGenericMapping(rawName: string): ToolMapping | null {
  const { server, name } = parseToolNameLocal(rawName);
  const verb = inferVerbFromName(name);
  if (!verb) return null;
  const realm = inferRealmFromServer(server, name) ?? "minsky-substrate";
  return { verb, realm };
}

/** Total fallback: never drop an event, always mark `unmapped: true` (mt#3157 SC 2). */
const FALLBACK_MAPPING: ToolMapping = { verb: "execute", realm: "unknown" };

function resolveToolMapping(rawName: string): { mapping: ToolMapping; unmapped: boolean } {
  const { name } = parseToolNameLocal(rawName);
  const explicit = EXPLICIT_TOOL_REGISTRY[name];
  if (explicit) return { mapping: explicit, unmapped: false };
  const inferred = inferGenericMapping(rawName);
  if (inferred) return { mapping: inferred, unmapped: false };
  return { mapping: FALLBACK_MAPPING, unmapped: true };
}

function extractTargets(
  mapping: ToolMapping,
  input: unknown,
  result: ToolResultInfo | undefined,
  context: AdapterContext,
  rawName: string
): EventTarget[] {
  const extracted = mapping.extractTarget ? mapping.extractTarget(input, result, context) : null;
  if (!extracted) {
    const { name } = parseToolNameLocal(rawName);
    return [{ realm: mapping.realm, id: `${mapping.realm}:${name}` }];
  }
  const list = Array.isArray(extracted) ? extracted : [extracted];
  return list.map((t) => ({ realm: mapping.realm, id: t.id, raw: t.raw }));
}

// ── Guard-denial detection ────────────────────────────────────────────────────

/**
 * Whole-word markers for a tool_result representing a policy/guard denial —
 * a PreToolUse hook deny, a blocked Bash command, a pre-commit/commit-msg
 * hook rejection, a capability-grant refusal, etc.
 *
 * VERIFIED AGAINST A REAL CORPUS SAMPLE (mt#3157 implementation,
 * 2026-07-24): scanning `is_error: true` tool_result blocks across the 15
 * most-recently-ingested real sessions found 13 genuine denial results,
 * spanning at least four distinct guard mechanisms with FOUR DIFFERENT
 * phrasings — none of which matched an earlier, purely speculative marker
 * list based on `.claude/hooks/types.ts`'s `permissionDecisionReason`
 * field name:
 *   - `<tool_use_error>Blocked: sleep 40 ...` (a Bash-command guard)
 *   - `MCP error ...: pre-commit hook blocked the commit (ESLint ...)`
 *   - `Main workspace edit blocked: /path/to/file ...`
 *   - `Subagent merge denied (ADR-028 D5): no valid capability grant ...`
 * All four contain the WHOLE WORD "blocked" or "denied" (word-boundary
 * matched, so "unblocked" does not false-positive). This is a broader net
 * than a hook-name-keyed list could ever be — this repo alone carries ~50
 * distinct guard hooks, each with its own free-text phrasing — and is the
 * pragmatic Phase-0 choice: false positives (a genuine tool error that
 * happens to say "permission denied", e.g. an OS EACCES message) still
 * describe SOMETHING external gating the action, which is directionally
 * the right actor attribution even when the wording isn't literally a
 * Minsky guard hook.
 */
const GUARD_DENIAL_MARKER_RE = /\b(?:blocked|denied)\b/i;

/**
 * Best-effort extraction of a guard/hook name or receipt ref from denial
 * text (mt#3157 SC 1's "receipt ref to the guard doc"). Tries, in order:
 * the originally-assumed explicit `blocked by hook: <name>` shape; Minsky's
 * own `<class> hook blocked the commit (<reason>)` pre-commit/commit-msg
 * phrasing; and a trailing parenthetical immediately after the verb (e.g.
 * `Subagent merge denied (ADR-028 D5): ...` → `"ADR-028 D5"`). Returns
 * `undefined` when none match — not every denial names its own mechanism
 * (e.g. the bash-guard's free-text `Blocked: <command>` message).
 */
function extractGuardName(text: string): string | undefined {
  const explicit = /(?:blocked|denied) by (?:a )?(?:pretooluse )?hook:?\s*([a-z0-9_.-]+)/i.exec(
    text
  );
  if (explicit?.[1]) return explicit[1];

  const hookBlockedCommit = /([a-z0-9-]+) hook blocked the commit(?:\s*\(([^)]+)\))?/i.exec(text);
  if (hookBlockedCommit) return hookBlockedCommit[2] ?? hookBlockedCommit[1];

  const parenthetical = /(?:blocked|denied)\s*\(([^)]+)\)/i.exec(text);
  if (parenthetical?.[1]) return parenthetical[1];

  return undefined;
}

function detectGuardDenial(resultBlock: ContentBlock): { guardName?: string } | null {
  if (resultBlock.is_error !== true) return null;
  const text = resultContentText(resultBlock.content);
  if (!GUARD_DENIAL_MARKER_RE.test(text)) return null;
  return { guardName: extractGuardName(text) };
}

// ── Batch id ──────────────────────────────────────────────────────────────────

function makeBatchId(msg: TranscriptMessage, index: number): string {
  return msg.uuid ? `batch:${msg.uuid}` : `batch:line-${index}`;
}

// ── Event emission ────────────────────────────────────────────────────────────

function emitSimpleEvent(
  verb: Extract<EventVerb, "speak" | "think" | "ask">,
  timestamp: string | undefined,
  actor: EventActor,
  context: AdapterContext
): SemanticEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    tStart: timestamp ?? "",
    actor,
    verb,
    target: { realm: "agents", id: `agents:${context.agentSessionId}` },
    outcome: "ok",
    weight: weightForVerb(verb),
    adapterVersion: context.adapterVersion ?? ADAPTER_VERSION,
  };
}

function emitToolCallEvents(
  block: ContentBlock,
  resultBlock: ContentBlock | undefined,
  resultTimestamp: string | undefined,
  batchId: string,
  tStart: string,
  context: AdapterContext
): SemanticEvent[] {
  const rawName = typeof block.name === "string" ? block.name : "";
  const { mapping, unmapped } = resolveToolMapping(rawName);
  const resultInfo: ToolResultInfo | undefined = resultBlock
    ? { content: resultBlock.content, isError: resultBlock.is_error === true }
    : undefined;

  const denial = resultBlock ? detectGuardDenial(resultBlock) : null;
  const targets = extractTargets(mapping, block.input, resultInfo, context, rawName);

  const actor: EventActor = denial
    ? { kind: "policy", guardName: denial.guardName }
    : { kind: "agent", agentSessionId: context.agentSessionId };

  const outcome: EventOutcome = denial
    ? "denied"
    : resultInfo
      ? resultInfo.isError
        ? "error"
        : "ok"
      : "ok";

  return targets.map((target) => ({
    schemaVersion: EVENT_SCHEMA_VERSION,
    tStart,
    tEnd: resultBlock ? resultTimestamp : undefined,
    actor,
    verb: mapping.verb,
    target,
    outcome,
    weight: weightForVerb(mapping.verb),
    batchId,
    adapterVersion: context.adapterVersion ?? ADAPTER_VERSION,
    unmapped,
  }));
}

// ── Main adapter ──────────────────────────────────────────────────────────────

/**
 * Adapt a full transcript (as returned by `AgentTranscriptService.
 * getTranscript()`) into an ordered `SemanticEvent[]`. See the module doc
 * comment for the pairing algorithm and actor-attribution rules.
 */
export function adaptTranscriptToEvents(
  messages: readonly TranscriptMessage[],
  context: AdapterContext
): SemanticEvent[] {
  const events: SemanticEvent[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.type === "assistant") {
      const blocks = normalizeContent(resolveInnerContent(msg));
      const batchId = makeBatchId(msg, i);
      const tStart = msg.timestamp ?? "";

      const next = messages[i + 1];
      const nextIsUser = next?.type === "user";
      const resultBlocks =
        nextIsUser && next
          ? normalizeContent(resolveInnerContent(next)).filter((b) => b.type === "tool_result")
          : [];
      const resultById = new Map<string, ContentBlock>();
      for (const rb of resultBlocks) {
        if (typeof rb.tool_use_id === "string") resultById.set(rb.tool_use_id, rb);
      }
      const resultTimestamp = nextIsUser ? next?.timestamp : undefined;

      for (const block of blocks) {
        if (
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim().length > 0
        ) {
          events.push(
            emitSimpleEvent(
              "speak",
              tStart,
              { kind: "agent", agentSessionId: context.agentSessionId },
              context
            )
          );
        } else if (block.type === "thinking" || block.type === "redacted_thinking") {
          events.push(
            emitSimpleEvent(
              "think",
              tStart,
              { kind: "agent", agentSessionId: context.agentSessionId },
              context
            )
          );
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          const resultBlock = resultById.get(block.id);
          events.push(
            ...emitToolCallEvents(block, resultBlock, resultTimestamp, batchId, tStart, context)
          );
        }
      }
    } else if (msg.type === "user") {
      const blocks = normalizeContent(resolveInnerContent(msg));
      const hasToolResult = blocks.some((b) => b.type === "tool_result");
      if (hasToolResult) continue; // a completion, not a fresh prompt — handled above.

      const text = extractPlainText(blocks);
      if (text && !isSyntheticInterruptText(text)) {
        events.push(emitSimpleEvent("ask", msg.timestamp, context.userTurnActor, context));
      }
    }
  }

  return events;
}

// ── Coverage metric (mt#3157 SC 2) ────────────────────────────────────────────

export interface AdapterCoverageResult {
  /** Total tool-call-derived events observed (excludes conversational events). */
  totalToolEvents: number;
  /** Tool-call-derived events that avoided the total fallback. */
  nonFallbackToolEvents: number;
  /** `nonFallbackToolEvents / totalToolEvents`, or 1 when there were no tool-call events. */
  coverage: number;
}

/**
 * Fraction of tool-call events mapping to a non-fallback verb (mt#3157 SC 2).
 * Only events carrying a defined `unmapped` flag are tool-call-derived
 * (conversational events never set it) — see `event-schema.ts`'s doc comment
 * on `SemanticEvent.unmapped`.
 */
export function computeAdapterCoverage(events: readonly SemanticEvent[]): AdapterCoverageResult {
  let total = 0;
  let nonFallback = 0;
  for (const event of events) {
    if (event.unmapped === undefined) continue;
    total++;
    if (!event.unmapped) nonFallback++;
  }
  return {
    totalToolEvents: total,
    nonFallbackToolEvents: nonFallback,
    coverage: total === 0 ? 1 : nonFallback / total,
  };
}
