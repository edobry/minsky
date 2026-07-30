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
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  startDrivenSession,
  sendDrivenSessionInput,
  drivenSessionRegistry,
  DEFAULT_PERMISSION_MODE,
  type DrivenSessionEvent,
  type DrivenSessionRecord,
  type DrivenSessionRegistry,
  type DrivenSessionSubscriber,
  type SpawnFn,
} from "./driven-session-host";
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

  lines.push(
    "",
    "The principal is looking at this in the cockpit and wants to understand it.",
    "Investigate before answering — you have Minsky MCP tools; read the parent task,",
    "the originating conversation, and related memories rather than restating the text",
    "above, which the principal has already read and found unclear.",
    "",
    "Do NOT take action on this entity. Do not resolve, close, edit, or respond to it.",
    "Explain it. Any action is the principal's own, taken through the cockpit's own",
    "controls.",
    "",
    "Wait for the principal's question."
  );

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
    ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    ...(opts.registry ? { registry: opts.registry } : {}),
    ...(opts.command ? { command: opts.command } : {}),
  });

  // The spawn alone yields an agent that knows nothing about the entity — the
  // seed prompt IS the scoping. Send it before the session is handed back so a
  // caller can never forward the principal's first question to an unseeded
  // child.
  const seeded = sendDrivenSessionInput(result.record, buildEntityThreadSeedPrompt(opts.seed));
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
