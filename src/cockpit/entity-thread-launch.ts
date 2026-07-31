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
  drivenSessionRegistry,
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
} from "./driven-session-launch";
import {
  appendEntityThreadTurn,
  entityThreadLocalId,
  type EntityThreadEntityType,
} from "@minsky/domain/transcripts/entity-thread-store";

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
      error: err instanceof Error ? err.message : String(err),
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
}

export interface EntityThreadSession {
  localId: string;
  record: DrivenSessionRecord;
  /** True when this call spawned the session; false when one was already live. */
  spawned: boolean;
  /**
   * True when the seed prompt was accepted by the child's stdin. False means
   * the spawn succeeded but the child was not writable — the session exists
   * but its agent has NOT been told what entity it is discussing, so the
   * caller must surface that rather than treating the session as ready.
   */
  seeded: boolean;
}

/**
 * Get the live driven session for an entity's thread, spawning a seeded one if
 * none is running.
 *
 * Idempotent by `localId`: a second call while the first session is still
 * registered returns the existing record rather than spawning a competing
 * child against the same conversation. That matters beyond tidiness — two
 * concurrent writers on one conversation is the DAG-fork corruption mt#3095
 * exists to prevent, and the registry lookup is what keeps this path from
 * being a way to cause it.
 */
export function startEntityThreadSession(
  opts: StartEntityThreadSessionOptions
): EntityThreadSession {
  const registry = opts.registry ?? drivenSessionRegistry;
  const localId = entityThreadLocalId(opts.seed.entityType, opts.seed.entityId);

  const existing = registry.get(localId);
  if (existing) {
    return { localId, record: existing, spawned: false, seeded: true };
  }

  log.debug(`startEntityThreadSession: spawning for ${localId}`);
  const result = startDrivenSession({
    localId,
    cwd: opts.cwd ?? process.cwd(),
    permissionMode: DEFAULT_PERMISSION_MODE,
    // mt#3402: the SAME observer set ./routes/driven-sessions.ts wires for
    // every driven session. Omitting these is why no `driven_sessions` row was
    // ever written for a thread — and therefore why the deterministic
    // `localId`'s whole purpose (one row per entity, surviving a daemon
    // restart) silently never held. This callsite was originally written from
    // `startDrivenSession`'s SIGNATURE rather than from its existing caller.
    //
    // `createDrivenInitLinkObserver` is deliberately NOT wired: it early-returns
    // unless the record carries BOTH a harnessSessionId and a minskySessionId,
    // and a thread is bound to an entity, not to a workspace session. Wiring it
    // would add a permanent no-op, not a link.
    onStateChange: opts.onStateChange ?? createDrivenSessionPersistObserver(),
    onResultSummary: opts.onResultSummary ?? createDrivenResultObserver(),
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

  return { localId, record: result.record, spawned: true, seeded };
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
 * Write failures are logged and swallowed: this subscriber runs on the live
 * session's event path, where the sibling observers' convention (see
 * ./driven-session-launch.ts) is that persistence must never disturb the
 * running child. A dropped turn degrades the thread's history; a throw here
 * would degrade the session itself.
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
        log.warn(`entity-thread reply recorder: failed to persist turn for ${localId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
    // An actuator swap replaces the record this subscriber is attached to. The
    // thread itself is unaffected — it is keyed by localId, which survives the
    // swap — so there is nothing to tear down here; the route re-registers a
    // recorder against the new record on the next message.
    onSwap: () => {},
  };
}
