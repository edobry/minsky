/**
 * Entity discussion thread launch (mt#3364, parent mt#3363).
 *
 * Daemon-side wiring between an entity's cockpit detail page and a driven
 * session (../cockpit/driven-session-host.ts) scoped to that entity — the
 * mechanism half of "discuss this ask with an agent without leaving the
 * cockpit."
 *
 * ## Why a driven session rather than a completion call
 *
 * The question this thread exists to answer is "why did you ask me this?",
 * which requires an agent that can go READ things — the ask row, the parent
 * task, the originating conversation, related memories. `ai.complete`
 * (src/adapters/shared/commands/ai/completion-commands.ts) is single-shot with
 * a string prompt and no tools, and `ai.chat` at that same callsite is a stub
 * that throws. A driven session is the genuine `claude` binary and, per
 * ../cockpit/driven-session-host.ts's own docblock, "the spawned `claude` child
 * inherits the operator's MCP config and MAY call back into Minsky MCP tools
 * during its turn" — so the agent can investigate instead of paraphrasing.
 *
 * ## Identity
 *
 * The spawn is keyed by `entityThreadLocalId(entityType, entityId)` — the same
 * deterministic id the `entity_threads` row uses. `startDrivenSession`'s
 * `localId` option (mt#3243) upserts `driven_sessions` on that key, so an
 * entity occupies exactly ONE driven-session row across restarts and respawns
 * rather than accumulating one per spawn.
 *
 * The pure functions here (`buildEntityThreadSeedPrompt`, `askToEntitySeed`)
 * hold the seeding contract and are unit-tested with no process spawned.
 *
 * @see mt#3364 — this module
 * @see ./driven-session-host.ts — the spawn/parse/registry layer this calls
 * @see packages/domain/src/transcripts/entity-thread-store.ts — thread persistence
 */

import { log } from "@minsky/shared/logger";
import { sql } from "drizzle-orm";
import { RESOLVE_PROPOSAL_FENCE } from "@minsky/shared/resolve-proposal";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  startDrivenSession,
  sendDrivenSessionInput,
  buildReconnectingDrivenSessionRecord,
  drivenSessionRegistry,
  hasLiveSessionDriver,
  DEFAULT_PERMISSION_MODE,
  type DrivenSessionCostSummary,
  type DrivenSessionEvent,
  type DrivenSessionRecord,
  type DrivenSessionRegistry,
  type DrivenSessionSubscriber,
  type SpawnFn,
} from "./driven-session-host";
import {
  createDrivenResultObserver,
  createDrivenSessionPersistObserver,
  createDrivenInitObserver,
  orchestrateDrivenSessionResume,
} from "./driven-session-launch";
import {
  appendEntityThreadTurn,
  entityThreadLocalId,
  type EntityThreadEntityType,
} from "@minsky/domain/transcripts/entity-thread-store";
import { getLoggableErrorSummary } from "@minsky/domain/errors/index";
import { pendingReplyBuffer, schedulePendingDrain } from "./entity-thread-reply-buffer";
import { drivenSessionMcpServerNames } from "./driven-session-mcp-servers";
import {
  writeHarnessSessionLabel,
  type WriteHarnessSessionLabelInput,
} from "./harness-session-label";

// ---------------------------------------------------------------------------
// Seeding (pure)
// ---------------------------------------------------------------------------

/**
 * The entity content a thread is seeded with.
 *
 * Deliberately a NARROW structural type rather than the domain's full `Ask` /
 * `Task` / changeset types: the seed builder must work identically for every
 * entity kind (mt#3366 generalizes the mount), and coupling it to one domain
 * type would force a rewrite at that point. Each entity kind gets an adapter
 * (`askToEntitySeed` and its future siblings) that narrows to this shape.
 */
export interface EntitySeedContext {
  entityType: EntityThreadEntityType;
  entityId: string;
  /** Human-readable label — what the principal sees in the page header. */
  title: string;
  /**
   * Short human-readable ref — `ask#9257`, `mt#4621` (mt#4621).
   *
   * Distinct from `entityId`, which is a uuid for an ask, and from `title`,
   * which folds the short id in only as a FALLBACK when the entity has no
   * title of its own. The harness session label needs the ref and the title as
   * SEPARATE values to render `ask#9257 — <title>`, and neither existing field
   * can supply it alone.
   *
   * Optional because {@link EntitySeedContext} is deliberately a narrow
   * structural type every entity kind must satisfy; a kind with no short id
   * omits it and the label falls back to the entity id.
   */
  shortRef?: string;
  /** The entity's substantive content: an ask's question, a task's summary. */
  body: string;
  /** Optional labelled references the entity already carries (contextRefs, parent task). */
  refs?: { label: string; value: string }[];
  /**
   * The conversation that originally filed this entity, when reachable (mt#3367).
   *
   * Carried as a POINTER, never as copied transcript text. The agent holds the
   * transcript tools and can read it selectively on demand — which is both far
   * cheaper than assembling context up front and better behaved, since an agent
   * that judges the origin irrelevant simply does not read it.
   *
   * Absent for the MAJORITY of asks (measured reachability: 46.2%). Absence is
   * a first-class state the prompt states explicitly, not a silent omission.
   */
  originConversationId?: string;
}

/**
 * Build the seed prompt for an entity thread's agent.
 *
 * Three things this deliberately does:
 *
 * 1. **States the job in terms of the principal's actual question.** The
 *    thread exists because an entity was unclear; the agent's job is to explain
 *    it, not to act on it.
 * 2. **Tells the agent to investigate rather than paraphrase.** Without this
 *    the likely failure is a fluent restatement of the same text the principal
 *    already could not parse — which is exactly the degenerate behavior the
 *    driven-session mechanism was chosen to avoid.
 * 3. **Forbids acting on the entity.** A thread about an ask must not resolve
 *    that ask as a side effect of discussing it; resolution is an explicit,
 *    operator-confirmed action owned by mt#3368. The agent has live MCP tools,
 *    so this boundary has to be stated, not assumed.
 */
export function buildEntityThreadSeedPrompt(seed: EntitySeedContext): string {
  const lines: string[] = [
    `You are answering the principal's questions about a Minsky ${seed.entityType}.`,
    "",
    `${seed.entityType} id: ${seed.entityId}`,
    `title: ${seed.title}`,
    "",
    "Content:",
    seed.body,
  ];

  if (seed.refs && seed.refs.length > 0) {
    lines.push("", "References it carries:");
    for (const ref of seed.refs) {
      lines.push(`- ${ref.label}: ${ref.value}`);
    }
  }

  if (seed.originConversationId) {
    lines.push(
      "",
      `The conversation that originally filed this ${seed.entityType} is reachable:`,
      `  conversation id: ${seed.originConversationId}`,
      "Read it with the `transcripts_get` tool when the principal's question is about WHY this",
      "exists or what the agent was thinking — that reasoning is there and is not in the text",
      "above. Read it SELECTIVELY: the tool takes a `turnRange` and a `role` filter, and",
      '`projection: "text"` returns lean turn text. Do not pull the whole transcript by reflex.'
    );
  } else {
    // Stated, not omitted (mt#3367). Silence would read to the agent as "no
    // originating conversation exists", and it would then answer the "why did
    // you ask me this?" question from the entity text alone WITHOUT telling the
    // principal its grounding was thinner than it could have been.
    lines.push(
      "",
      `The conversation that originally filed this ${seed.entityType} could NOT be resolved, so`,
      "you cannot read the reasoning behind it. If the principal asks WHY it exists, say that",
      "the originating conversation is unavailable rather than inferring a motive from the text."
    );
  }

  lines.push(
    "",
    "The principal is looking at this in the cockpit and wants to understand it.",
    "Investigate before answering — you have Minsky MCP tools. Follow the references listed",
    "above, read related memories, and pull in whatever else bears on it, rather than",
    "restating the text above, which the principal has already read and found unclear.",
    "",
    // ⚠️ THIS SENTENCE IS THE ONLY BARRIER (mt#3435). It is a prompt-level
    // constraint on a STRUCTURALLY CAPABLE agent, not a guarantee.
    //
    // A thread child spawns with `DEFAULT_PERMISSION_MODE` →
    // `--dangerously-skip-permissions` and, via mt#3377, the COMPLETE Minsky MCP
    // server with no `--allowedTools`/`--disallowedTools`. So the agent asked to
    // EXPLAIN an ask can also call `asks_respond` on it, `session_pr_merge`,
    // `tasks_status_set` — anything. Nothing below the prompt stops it.
    //
    // Do not read mt#3368's confirm step as containment either: that guards the
    // PANEL's resolve path, and the agent never needs the panel.
    //
    // The principal reviewed four containment options on 2026-07-30 and chose to
    // ACCEPT this risk and document it. mt#3435 holds the decision, the verified
    // capability surface, the revisit triggers, and the option set — read it
    // before weakening this line or concluding something else already guards it.
    "Do NOT take action on this entity. Do not resolve, close, edit, or respond to it.",
    "Explain it. Any action is the principal's own, taken through the cockpit's own",
    "controls.",
    ""
  );

  if (seed.entityType === "ask") {
    lines.push(
      "If — and only if — the discussion reaches a clear answer to this ask, you may PROPOSE",
      "one. Proposing is not acting: it renders as a pre-filled control that commits nothing",
      "until the principal clicks confirm. Emit a fenced block exactly like this, in addition",
      "to your normal prose:",
      "",
      `\`\`\`${RESOLVE_PROPOSAL_FENCE}`,
      '{"optionLetter": "B", "rationale": "one sentence on why"}',
      "```",
      "",
      "`optionLetter` is a single letter naming one of the ask's own options.",
      "",
      "If the ask is malformed, ambiguous, or you cannot ground an answer in what you read,",
      "DECLINE to propose — say so plainly and emit no block. A plausible-looking proposal you",
      "cannot support is worse than none: it invites a confirming click on reasoning that does",
      "not exist. Never propose an option the ask does not list.",
      ""
    );
  }

  lines.push("Wait for the principal's question.");

  return lines.join("\n");
}

/** The narrow slice of an ask this module needs — see `EntitySeedContext`. */
export interface AskSeedInput {
  id: string;
  shortId?: string | null;
  title?: string | null;
  question: string;
  kind?: string | null;
  parentTaskId?: string | null;
  contextRefs?: { kind: string; ref: string }[] | null;
  /** Resolved by `resolveOriginConversationId`; absent when unreachable (mt#3367). */
  originConversationId?: string | null;
}

/**
 * Adapt an ask to the seed shape.
 *
 * Prefers the short id (`ask#N`) as the label because that is what the
 * principal sees in the cockpit and what they would type; the uuid stays the
 * addressing key and is carried as `entityId`.
 */
export function askToEntitySeed(ask: AskSeedInput): EntitySeedContext {
  const refs: { label: string; value: string }[] = [];
  if (ask.parentTaskId) refs.push({ label: "parent task", value: ask.parentTaskId });
  for (const ref of ask.contextRefs ?? []) {
    refs.push({ label: ref.kind, value: ref.ref });
  }
  if (ask.kind) refs.push({ label: "ask kind", value: ask.kind });

  return {
    entityType: "ask",
    entityId: ask.id,
    title: ask.title?.trim() || ask.shortId || ask.id,
    // mt#4621: the short id UNFOLDED, so the harness session label can render
    // `ask#9257 — <title>`. `title` above already falls back to it, which is
    // why it cannot serve as the ref on its own.
    ...(ask.shortId ? { shortRef: ask.shortId } : {}),
    body: ask.question,
    ...(refs.length > 0 ? { refs } : {}),
    // NOT added to `refs`: the origin is a tool TARGET the prompt gives explicit
    // reading instructions for, not another labelled fact to skim. Keeping it a
    // distinct field is also what lets the route report `originSeeded` to the
    // panel without pattern-matching a ref label.
    //
    // A blank id is treated as ABSENT, deliberately (PR #2493 R1 non-blocking
    // asked whether this is a false negative — it is not). An empty or
    // whitespace-only conversation id cannot be read by any tool; carrying it
    // would tell the agent to go read "" and tell the principal the thread is
    // origin-grounded. Both claims would be false. `.trim()` so a whitespace id
    // is caught too, not just `""`.
    ...(ask.originConversationId?.trim()
      ? { originConversationId: ask.originConversationId.trim() }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Origin conversation (mt#3367)
// ---------------------------------------------------------------------------

/**
 * The confidence a link must carry to be used for origin-seeding.
 *
 * Gated at an EXACT 1.0 rather than a threshold. Measured against prod
 * 2026-07-31: 531 of 536 links are 1.0, and — decisively — the set of asks
 * reachable via ANY link and via a confidence-1.0 link are IDENTICAL (1382 of
 * 2990 over 30 days). So this gate costs zero coverage today while removing the
 * failure it exists to prevent: answering "why did you ask me this?" confidently
 * from the WRONG conversation. `confidence` is nullable, and `= 1` excludes NULL
 * too, which is the intended reading — an unscored link is not a trusted one.
 */
const ORIGIN_LINK_MIN_CONFIDENCE = 1;

interface RawOriginLinkRow {
  agent_session_id: string;
}

/**
 * Resolve the conversation that originally filed an entity, or `null`.
 *
 * `null` is the MAJORITY outcome, not an error path: measured reachability is
 * 46.2% of asks. The unseeded path is the common case and must stay first-class
 * (see `buildEntityThreadSeedPrompt`, which SAYS the origin is unavailable
 * rather than silently omitting it).
 *
 * Failures are logged and degrade to `null`: a thread that works without origin
 * context is strictly better than a thread that 500s because a lookup failed.
 */
export async function resolveOriginConversationId(
  db: PostgresJsDatabase,
  parentSessionId: string | null | undefined
): Promise<string | null> {
  if (!parentSessionId) return null;

  try {
    const result = await db.execute(sql`
      SELECT agent_session_id
      FROM minsky_session_links
      WHERE minsky_session_id = ${parentSessionId}
        AND confidence = ${ORIGIN_LINK_MIN_CONFIDENCE}
      ORDER BY detected_at DESC NULLS LAST
      LIMIT 1
    `);
    const rows = Array.from(result as Iterable<RawOriginLinkRow>);
    return rows[0]?.agent_session_id ?? null;
  } catch (err) {
    log.warn(`entity-thread: origin-conversation lookup failed for ${parentSessionId}`, {
      error: getLoggableErrorSummary(err),
    });
    return null;
  }
}

/** The narrow slice of a task this module needs — see `EntitySeedContext`. */
export interface TaskSeedInput {
  id: string;
  title?: string | null;
  status?: string | null;
  kind?: string | null;
  parentTaskId?: string | null;
  /** The spec body. Optional on the domain `Task`, and genuinely absent sometimes. */
  spec?: string | null;
  tags?: string[] | null;
}

/**
 * Adapt a task to the seed shape (mt#3366).
 *
 * The sibling of `askToEntitySeed`, and deliberately built the same way: narrow
 * structural input, refs assembled from whatever the entity actually carries.
 *
 * The `body` fallback is the one judgment call. A task with no spec still
 * EXISTS, so the route cannot 404 it — but seeding an empty body would produce
 * exactly the failure `buildSeedForEntity`'s docblock warns about, an agent
 * confidently discussing nothing. Naming the absence instead lets the agent
 * tell the principal the spec is empty, which is the true and useful answer.
 */
export function taskToEntitySeed(task: TaskSeedInput): EntitySeedContext {
  const refs: { label: string; value: string }[] = [];
  if (task.status) refs.push({ label: "status", value: task.status });
  if (task.kind) refs.push({ label: "task kind", value: task.kind });
  if (task.parentTaskId) refs.push({ label: "parent task", value: task.parentTaskId });
  if (task.tags && task.tags.length > 0) {
    refs.push({ label: "tags", value: task.tags.join(", ") });
  }

  const spec = task.spec?.trim();

  return {
    entityType: "task",
    entityId: task.id,
    title: task.title?.trim() || task.id,
    // mt#4621: a task's id IS its short ref (`mt#4621`), so unlike an ask this
    // needs no separate lookup — it is stated rather than derived so the label
    // builder never has to know which entity kinds happen to coincide.
    shortRef: task.id,
    body: spec && spec.length > 0 ? spec : "(This task has no spec body recorded.)",
    ...(refs.length > 0 ? { refs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

export interface StartEntityThreadSessionOptions {
  seed: EntitySeedContext;
  /** Working directory for the spawned child. Defaults to the daemon's cwd. */
  cwd?: string;
  /** Test seam — see ./driven-session-host.ts's module docblock. */
  spawnFn?: SpawnFn;
  /** Test seam — hermetic registry instance. */
  registry?: DrivenSessionRegistry;
  /** Test seam — fake binary path. */
  command?: string;
  /**
   * Override the durable-persistence observer (mt#3402). Production omits it
   * and gets `createDrivenSessionPersistObserver`; tests inject a capture so
   * they can assert the row WOULD be written without touching Postgres.
   */
  onStateChange?: (record: DrivenSessionRecord) => void;
  /** Override the per-turn cost observer (mt#3402). Same seam convention. */
  onResultSummary?: (record: DrivenSessionRecord, summary: DrivenSessionCostSummary) => void;
  /**
   * Override the init observer (mt#4323). Same seam convention: production
   * omits it and gets `createDrivenInitObserver` carrying this spawn's
   * `FreshSpawnReason`; tests inject a capture to assert the conversation
   * adoption WOULD be recorded without touching Postgres.
   */
  onHarnessSessionLinked?: (record: DrivenSessionRecord) => void;
  /**
   * Override the harness session-label write (mt#4621). Same seam convention.
   *
   * Deliberately a SEPARATE seam from `onHarnessSessionLinked` above, not a
   * behavior folded into it: a test that injects that observer is asserting
   * something about the conversation adoption and must not thereby start
   * writing real files into `/tmp`, which `custom/no-real-fs-in-tests` forbids
   * and which would make those tests order-dependent on each other's leftovers.
   */
  writeSessionLabel?: (input: WriteHarnessSessionLabelInput) => boolean;
  /**
   * Override the resume orchestration (mt#3550) — the same seam convention as
   * the observers above. Production omits it and gets
   * `orchestrateDrivenSessionResume`, which reads the persisted row and takes a
   * cross-process advisory lock; tests inject a fake so the re-spawn decision
   * is exercisable without a database.
   */
  resumeSession?: typeof orchestrateDrivenSessionResume;
}

export interface EntityThreadSession {
  localId: string;
  record: DrivenSessionRecord;
  /**
   * True when this call put a NEW session driver behind the thread — a first spawn, a
   * resume-respawn, or a fresh replacement for a dead one. False only when an
   * already-live session was reused.
   *
   * The route keys the reply-recorder subscription on this: a swapped-in record
   * carries none of the old record's subscribers (`registry.replace` tells them
   * to swap away), so anything that must observe the new session driver has to be
   * re-attached whenever this is true.
   */
  spawned: boolean;
  /**
   * True when a reachable agent is scoped to this entity — i.e. the returned
   * record has a live session driver AND its conversation carries the seed prompt.
   *
   * Per branch: a fresh spawn reports whether the child's stdin actually
   * accepted the prompt (false means the spawn succeeded but the child was not
   * writable — the agent has NOT been told what entity it is discussing); a
   * reused live record and a resumed conversation are both already scoped; and
   * a record handed back with NO session driver behind it is false regardless of
   * what its conversation once held, because nothing is reachable to have been
   * seeded (PR #2601 R1 BLOCKING).
   *
   * A false here means the caller must surface the state rather than treat the
   * session as ready.
   */
  seeded: boolean;
  /**
   * The conversation this call REPLACED with a fresh seeded child (mt#4093).
   *
   * Present only on the one path that actually replaces something: a persisted
   * row naming a conversation that could not be resumed. Absent for a first
   * launch, a reuse, a resume, and for a row that never linked a conversation
   * — in none of those is there a prior exchange the new agent is missing.
   *
   * The caller MUST record and surface it. Every turn already on the operator's
   * screen belongs to this conversation, and the agent about to answer has
   * never seen any of them; left unsaid, the panel renders continuity that does
   * not exist. It is reported here because this is the last moment it is
   * knowable — the spawn below upserts `driven_sessions` on the same
   * `localId`, overwriting `harness_session_id` with the new conversation.
   */
  replacedConversationId?: string;
  /**
   * Why this call spawned a fresh seeded child, when it spawned one (mt#4093).
   * Absent for a reuse and for a resume — neither spawned fresh.
   *
   * Reported as a VALUE, not left to the log line that renders it. The log is
   * what a human reads after the fact; a caller (and a test) needs the reason
   * itself, and deriving it a second time from a formatted string would be the
   * usual way the two drift apart. It is also what makes "every fresh spawn
   * says why" checkable without patching the logger.
   */
  freshSpawnReason?: FreshSpawnReason;
}

/**
 * Why a thread ended up spawning a fresh seeded child instead of resuming.
 *
 * Named rather than collapsed to a boolean because the three cases call for
 * different things: the first is an ordinary first launch, the second is a
 * CONVERSATION SWAP the operator has to be told about, and the third is a
 * failure whose cause is unknown to this layer.
 *
 * **The definition MOVED to `@minsky/domain/storage/schemas/driven-sessions-schema`
 * in mt#4323 and is re-exported here unchanged** — every existing consumer
 * (this module's own logs, its tests, the panel's swap disclosure) imports the
 * same type it always did. It had to move because
 * `driven_session_conversations.adoption_reason` stores these values, the store
 * that writes them lives in `packages/domain`, and that package deliberately
 * imports nothing from `src/cockpit/**` — so leaving the union here would have
 * forced a COPY on the table side, and a copy is exactly what drifts.
 */
export type { FreshSpawnReason } from "@minsky/domain/storage/schemas/driven-sessions-schema";

// A re-export does NOT bind the name locally, and this module uses the type in
// its own signatures below — hence the separate type-only import.
import type { FreshSpawnReason } from "@minsky/domain/storage/schemas/driven-sessions-schema";

/** What {@link respawnThreadDriver} decided to do about an absent or dead record. */
type ThreadDriverRespawn =
  | { kind: "resumed"; record: DrivenSessionRecord }
  /** Nothing to resume — the caller should spawn a fresh seeded child. */
  | { kind: "spawn-fresh"; reason: FreshSpawnReason; replacedConversationId?: string }
  /** Another process holds the resume lock for this conversation right now. */
  | { kind: "held-elsewhere" };

/**
 * Put a live session driver back behind a thread whose child has exited (mt#3550).
 *
 * Resume FIRST, because the thread's earlier turns are the point: the seed
 * prompt carries the ENTITY's content and no discussion history, so a fresh
 * child answers the principal's follow-up having never seen the exchange the
 * panel is still showing them. `claude --resume` keeps that context, and
 * `orchestrateDrivenSessionResume` is the path mt#3038 already built for
 * exactly this shape — persisted-row lookup, cross-process advisory lock,
 * orphan-PID cleanup, `registry.replace` — so this reuses it rather than
 * inventing a second recovery mechanism.
 *
 * Everything that is not a successful resume falls back to a fresh seeded
 * spawn, EXCEPT a lock held by another process: there, spawning would start a
 * second conversation for a thread another daemon is in the middle of
 * recovering, so the dead record is handed back and the message reports itself
 * undelivered. The panel's "send again" is the right advice in that one case —
 * the lock is released in seconds.
 */
async function respawnThreadDriver(
  localId: string,
  opts: StartEntityThreadSessionOptions
): Promise<ThreadDriverRespawn> {
  const resume = opts.resumeSession ?? orchestrateDrivenSessionResume;
  let outcome: Awaited<ReturnType<typeof orchestrateDrivenSessionResume>>;
  try {
    outcome = await resume(localId, {
      ...(opts.registry ? { registry: opts.registry } : {}),
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
      ...(opts.command ? { command: opts.command } : {}),
    });
  } catch (err) {
    // A resume that THREW says nothing about whether a fresh child can run —
    // the store may simply be unreachable — so this degrades to the fallback
    // rather than leaving the thread with no agent at all.
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`entity-thread: resume attempt failed for ${localId}: ${message}`);
    return { kind: "spawn-fresh", reason: "resume-attempt-failed" };
  }

  switch (outcome.outcome) {
    case "resumed":
      log.info(`entity-thread: resumed the session driver for ${localId}`);
      return { kind: "resumed", record: outcome.record };
    case "locked":
      log.info(`entity-thread: another process is resuming ${localId} — not spawning a rival`);
      return { kind: "held-elsewhere" };
    case "unrecoverable":
      // Split from `not-found` (mt#4093). Both end in a fresh seeded spawn, but
      // only this one REPLACES something: a row exists, and when it names a
      // conversation, the turns already on the operator's screen belong to that
      // conversation and the incoming agent has never seen them. Collapsing the
      // two hid exactly that distinction.
      log.info(
        `entity-thread: ${localId} is not resumable (${outcome.reason}) — spawning a fresh seeded child${
          outcome.harnessSessionId ? `, replacing conversation ${outcome.harnessSessionId}` : ""
        }`
      );
      return {
        kind: "spawn-fresh",
        reason: outcome.harnessSessionId
          ? "prior-conversation-unrecoverable"
          : "prior-spawn-never-linked",
        ...(outcome.harnessSessionId ? { replacedConversationId: outcome.harnessSessionId } : {}),
      };
    case "not-found":
    default:
      // The never-persisted and no-database cases. Nothing is being replaced —
      // this is an ordinary first launch (or a launch the store cannot see).
      log.info(
        `entity-thread: no resumable conversation for ${localId} — spawning a fresh seeded child`
      );
      return { kind: "spawn-fresh", reason: "no-prior-conversation" };
  }
}

/**
 * Get the live driven session for an entity's thread, spawning a seeded one if
 * none is running.
 *
 * Idempotent by `localId`: a second call while the first session is still LIVE
 * returns the existing record rather than spawning a competing child against
 * the same conversation. That matters beyond tidiness — two concurrent writers
 * on one conversation is the DAG-fork corruption mt#3095 exists to prevent, and
 * the registry lookup is what keeps this path from being a way to cause it.
 *
 * "Still live" is {@link hasLiveSessionDriver}, NOT "a record exists" (mt#3550).
 * A record whose child has exited stays in the registry with a terminal status,
 * and reusing it produced a thread that could never answer again: the turn was
 * stored, `sendDrivenSessionInput` refused the dead stdin, and nothing
 * re-spawned — so the panel's own "send again to ask" advice was futile
 * forever. This is the same predicate the liveness report uses, so the spawn
 * guard and the panel can no longer disagree about whether an agent is there.
 */
/**
 * Run several init observers off one `onHarnessSessionLinked` slot (mt#4621).
 *
 * `startDrivenSession` takes ONE callback and an entity thread has two things
 * to do at init, so they compose here.
 *
 * **Deliberately does NOT catch** (PR #3379 R1). An earlier revision wrapped
 * each observer in its own try/catch, which the reviewer correctly flagged as a
 * second error-handling layer for a concern the host already owns:
 * `driven-session-host.ts:1089-1097` wraps this whole callback and logs at
 * ERROR. Catching here too produced two logging surfaces at two levels for one
 * failure, split across two modules — the drift risk is real and the
 * duplication buys nothing.
 *
 * **The property that catch was protecting is preserved by ORDERING instead.**
 * The host's boundary is callback-level, not observer-level, so an escaping
 * throw from the first observer WOULD skip the rest — which is why the answer
 * is not simply "delete it and rely on the host". Callers pass the observer
 * that cannot throw FIRST (see the call site), so a failure in a later one
 * cannot suppress it. Ordering is checkable by reading the call site; a catch
 * is not.
 *
 * In practice neither of this file's observers throws synchronously today —
 * `createDrivenInitObserver` detaches its async work behind its own error
 * boundary, and `writeHarnessSessionLabel` swallows by contract — so the
 * ordering is defense in depth against a future observer, not a live bug.
 */
export function composeInitObservers<T>(
  ...observers: Array<(record: T) => void>
): (record: T) => void {
  return (record) => {
    for (const observe of observers) observe(record);
  };
}

export async function startEntityThreadSession(
  opts: StartEntityThreadSessionOptions
): Promise<EntityThreadSession> {
  const registry = opts.registry ?? drivenSessionRegistry;
  const localId = entityThreadLocalId(opts.seed.entityType, opts.seed.entityId);

  const existing = registry.get(localId);
  if (existing && hasLiveSessionDriver(existing)) {
    return { localId, record: existing, spawned: false, seeded: true };
  }

  // mt#4093: consulted whenever no LIVE session driver is behind the thread — NOT
  // only when the registry happens to hold a record. The `if (existing)` this
  // replaced made an ABSENT record fall straight through to the fresh spawn
  // below, so a thread whose conversation the registry had simply not loaded
  // (a daemon restart before boot reconciliation populated it, or a row whose
  // terminal status excluded it from that read) silently continued under a new
  // agent with none of the history the panel kept rendering. None of this
  // function's three resume branches even ran, which is why the incident logs
  // showed no trace of a declined resume: there was no resume to decline.
  //
  // The resume path does not need the registry. `orchestrateDrivenSessionResume`
  // reads the PERSISTED row and builds its `previous` record from it, and
  // `registry.replace` guards its old-record lookup — so installing over an
  // empty slot is safe. This is also what the sibling caller already does:
  // ./driven-session-ws.ts consults the same orchestration unconditionally and
  // treats only a `not-found` OUTCOME as gone. The two callers of one
  // orchestration no longer disagree about when to ask it.
  const respawn = await respawnThreadDriver(localId, opts);
  if (respawn.kind === "resumed") {
    // Already seeded — a resume continues the conversation the seed prompt
    // scoped, so re-sending it would repeat the whole scoping instruction to
    // an agent that has it.
    return { localId, record: respawn.record, spawned: true, seeded: true };
  }
  if (respawn.kind === "held-elsewhere") {
    // `seeded: false` (PR #2601 R1 BLOCKING): no session driver is behind this
    // record, so nothing accepted anything. The thread's conversation WAS
    // scoped once, but reporting that as `seeded` here would tell the caller
    // an agent is ready when none is reachable until the other process
    // releases the lock — which is how a stuck thread gets masked, the exact
    // failure this task exists to end.
    //
    // With no registry record to hand back, a placeholder is built rather than
    // spawning a rival — the lock exists precisely to stop a second child
    // against one conversation, and that constraint does not weaken just
    // because this daemon has not loaded the record. `driven-session-ws.ts`
    // builds the same placeholder for the same reason. It has no session driver, so
    // `sendDrivenSessionInput` refuses and the caller reports the message
    // undelivered — which is the truth, and clears in seconds.
    const record =
      existing ??
      buildReconnectingDrivenSessionRecord({
        localId,
        harnessSessionId: null,
        cwd: opts.cwd ?? process.cwd(),
        permissionMode: DEFAULT_PERMISSION_MODE,
        taskId: null,
        minskySessionId: null,
        status: "reconnecting",
        unrecoverableReason: null,
        driverGeneration: 0,
        startedAt: new Date().toISOString(),
      });
    return { localId, record, spawned: false, seeded: false };
  }

  log.debug(`startEntityThreadSession: spawning for ${localId}`);
  const result = startDrivenSession({
    localId,
    mcpServerNames: drivenSessionMcpServerNames(),
    cwd: opts.cwd ?? process.cwd(),
    permissionMode: DEFAULT_PERMISSION_MODE,
    // mt#3402: the SAME observer set ./routes/driven-sessions.ts wires for
    // every driven session. Omitting these is why no `driven_sessions` row was
    // ever written for a thread — and therefore why the deterministic
    // `localId`'s whole purpose (one row per entity, surviving a daemon
    // restart) silently never held. This callsite was originally written from
    // `startDrivenSession`'s SIGNATURE rather than from its existing caller.
    //
    // mt#4323: this observer IS now wired, and the carve-out it replaces is
    // worth reading before removing it again. It said
    // `createDrivenInitLinkObserver` was deliberately not wired because it
    // early-returned unless the record carried BOTH a harnessSessionId and a
    // minskySessionId — and a thread is bound to an entity, not a workspace
    // session — so wiring it "would add a permanent no-op, not a link." That
    // was correct while the observer's only job was the `driven_spawn` link.
    //
    // It now also records the CONVERSATION ADOPTION, which every driven session
    // has and which is the whole point of ADR-044's binding table. That write
    // sits ABOVE the minskySessionId gate, so it is not a no-op here; the link
    // half still self-gates and stays the no-op it always was for threads.
    // Leaving this unwired would have excluded entity threads from the very
    // record the umbrella exists to give them.
    // `respawn` is narrowed to `spawn-fresh` here — the `resumed` and
    // `held-elsewhere` arms both returned above — so its `reason` is exactly
    // the FreshSpawnReason this adoption should record.
    // mt#4621: the adoption observer AND the harness session-label write, in
    // that order. Both need exactly what the init event yields — the child's
    // conversation id — and this is the only moment it exists, so they compose
    // here rather than each re-deriving a hook into the host.
    //
    // ORDER IS LOAD-BEARING (PR #3379 R1). `composeInitObservers` does not
    // catch — the host owns that boundary — so a throw from an earlier observer
    // skips the later ones. The label write goes FIRST precisely because it is
    // the one that cannot throw (`writeHarnessSessionLabel` swallows by
    // contract), which means the durable ADR-044 adoption behind it can never
    // be suppressed by a cosmetic failure. Reversing these two would put the
    // only throw-capable observer ahead of the one that must always run.
    onHarnessSessionLinked: composeInitObservers(
      (record) => {
        if (!record.harnessSessionId) return;
        (opts.writeSessionLabel ?? writeHarnessSessionLabel)({
          harnessSessionId: record.harnessSessionId,
          ref: opts.seed.shortRef ?? opts.seed.entityId,
          title: opts.seed.title,
        });
      },
      opts.onHarnessSessionLinked ?? createDrivenInitObserver({ adoptionReason: respawn.reason })
    ),
    onStateChange: opts.onStateChange ?? createDrivenSessionPersistObserver(),
    onResultSummary: opts.onResultSummary ?? createDrivenResultObserver(),
    // mt#3550: only when this spawn is REPLACING a dead record. `register`
    // would drop that record out of the registry without telling its
    // subscribers anything, and they would go on observing a record no child
    // writes to.
    ...(existing ? { replacePrevious: true } : {}),
    ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    ...(opts.registry ? { registry: opts.registry } : {}),
    ...(opts.command ? { command: opts.command } : {}),
  });

  // The spawn alone yields an agent that knows nothing about the entity — the
  // seed prompt IS the scoping. Send it before the session is handed back so a
  // caller can never forward the principal's first question to an unseeded
  // child.
  //
  // `echo: false` (mt#3388): this text is HOST-authored, not the operator's.
  // Without it, mt#3372's operator-input echo appends the whole seed prompt to
  // the event log as a `minsky_operator_input` frame, and the conversation view
  // renders the entire scoping prompt as something the principal typed. The
  // resume-time interruption notice opts out for exactly the same reason — see
  // `sendDrivenSessionInput`'s own docblock on false attribution.
  const seeded = sendDrivenSessionInput(result.record, buildEntityThreadSeedPrompt(opts.seed), {
    echo: false,
  });
  if (!seeded) {
    log.warn(`startEntityThreadSession: spawned ${localId} but the seed prompt was not accepted`);
  }

  return {
    localId,
    record: result.record,
    spawned: true,
    seeded,
    freshSpawnReason: respawn.reason,
    ...(respawn.replacedConversationId
      ? { replacedConversationId: respawn.replacedConversationId }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Reply capture
// ---------------------------------------------------------------------------

/**
 * Pull the assistant's visible text out of one stream-json event payload.
 *
 * Returns `null` for every event that is not assistant prose — init frames,
 * tool_use / tool_result blocks, result summaries, the host's synthetic
 * `minsky_error` / `minsky_exit` events. Only text the principal would
 * actually read becomes a thread turn; the agent's tool traffic belongs to the
 * live session view, not to the durable discussion record.
 *
 * The upstream event schema is thin and under-specified (see
 * ./driven-session-host.ts's docblock citing anthropics/claude-code#24594),
 * so every level is checked rather than cast through.
 */
export function extractAssistantTextFromEvent(payload: Record<string, unknown>): string | null {
  if (payload["type"] !== "assistant") return null;

  const message = payload["message"];
  if (typeof message !== "object" || message === null) return null;

  const content = (message as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] !== "text") continue;
    const text = b["text"];
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }

  const joined = parts.join("").trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Build the subscriber that persists an entity thread's agent replies.
 *
 * Registered on the driven-session record so the thread's durable history is
 * written as the reply streams, independent of whether any browser is
 * currently connected — a thread whose turns only persisted while a WS was
 * open would silently lose exactly the replies the principal stepped away
 * from.
 *
 * A write failure never throws: this subscriber runs on the live session's
 * event path, where the sibling observers' convention (see
 * ./driven-session-launch.ts) is that persistence must never disturb the
 * running child. That constraint is unchanged.
 *
 * What CHANGED at mt#4036 is what happens instead of throwing. This used to
 * log and drop, on the reasoning that "a dropped turn degrades the thread's
 * history." The 2026-08-11 outage falsified that: the panel renders the thread
 * from this table, so a dropped reply is not a history gap — it is the ANSWER,
 * and its absence is indistinguishable from an agent that never replied. Four
 * replies were lost that way while the agent worked, and the operator sat
 * looking at silence. Not-throwing and not-losing were being treated as the
 * same choice; they are independent. The reply now goes to
 * ./entity-thread-reply-buffer.ts, which reconciles it back into the table when
 * the store recovers and reports it to the operator until then.
 */
export function createEntityThreadReplyRecorder(
  db: PostgresJsDatabase,
  localId: string
): DrivenSessionSubscriber {
  return {
    onEvent: (event: DrivenSessionEvent) => {
      const text = extractAssistantTextFromEvent(event.payload);
      if (!text) return;
      void appendEntityThreadTurn(db, { localId, role: "agent", content: text }).catch((err) => {
        // The EVENT's instant, not the rejection's (PR #2913 R1 non-blocking):
        // a slow failure path would push the watermark later than the reply
        // actually was, which is the direction that makes the reconcile miss a
        // turn that did land. Defensive parse — a malformed timestamp falls
        // back to the buffer's own default rather than poisoning the watermark
        // with NaN.
        const observedAt = Date.parse(event.receivedAt);
        const report = pendingReplyBuffer.buffer(
          localId,
          text,
          Number.isNaN(observedAt) ? undefined : observedAt
        );
        // `getLoggableErrorSummary`, not `err.message`: on a Drizzle failure the
        // message is the QUERY TEXT and the Postgres cause sits on `.cause`
        // (mt#3398). Reading `err.message` alone is why the four 2026-08-11 log
        // lines carried the entire rejected INSERT — reply body included — and
        // still did not say WHY it failed. The helper keeps the cause and bounds
        // each level, so the body can no longer be emitted whole.
        log.warn(
          `entity-thread reply recorder: failed to persist turn for ${localId} — buffered, ${report.pending} pending`,
          { error: getLoggableErrorSummary(err) }
        );
        schedulePendingDrain(db);
      });
    },
    // A session driver swap replaces the record this subscriber is attached to. The
    // thread itself is unaffected — it is keyed by localId, which survives the
    // swap — so there is nothing to tear down here; the route re-registers a
    // recorder against the new record on the next message.
    onSwap: () => {},
  };
}
