/**
 * The post-deploy monitor's SECONDARY alert channel — deciding and shaping the
 * `asks_create` call (mt#2782).
 *
 * ## What was broken
 *
 * `scripts/post-deploy-health-monitor.ts`'s `alertViaMcp` has never created an
 * ask. It sent `name: "mcp__minsky__asks_create"` — the Claude Code HARNESS
 * prefix, which is not a server-registered tool name — with arguments
 * `{ kind, subject, body, priority }`, three of which `asks.create` does not
 * declare. Both fail.
 *
 * Worse than failing: it checked only `callRes.ok`, the HTTP transport status.
 * A JSON-RPC error comes back as HTTP 200 with an `error` member in the body,
 * so the script logged `asks_create coordination.notify sent successfully` on
 * every failed call. Live evidence (run 31412887433, 2026-08-10): a real
 * digest-lag alert logged that line while `asks_list` showed no ask from that
 * run or any other that day. A log asserting a delivery that did not happen is
 * strictly worse than silence — mem#704's class, one layer out: the ACTUATOR
 * reporting success without checking its own outcome.
 *
 * So the rule this module exists to enforce: **success is the returned ask id,
 * never the absence of a thrown error.**
 *
 * ## Why the logic is here and not in the script
 *
 * Same reason as mt#3963's `monitor-p0-resolution.ts`: the script is an IO
 * shell that CI runs on a cron, and `scripts/smoke-post-deploy-health-monitor.ts`
 * COPIES the monitor's logic rather than importing it — so a test written
 * against the script asserts a duplicate. The decisions live here, pure and
 * tested; the script keeps the fetches.
 *
 * @see mt#2782 — this module
 * @see packages/domain/src/deployment/monitor-p0-resolution.ts — mt#3963, same split
 * @see ask#7824 — the principal chose "fix and activate" over removing the path
 */

// mt#4014: `import type` so an invented state is a COMPILE error rather than a
// reviewer catch. Type-only, so it is erased at build and adds nothing to the
// runtime module graph. The first version of TERMINAL_ASK_STATES below restated
// this union from recall — inventing two members, omitting two, and reading the
// wrong field name — and shipped past typecheck, lint and 24 unit tests that had
// inherited the same invented vocabulary (PR #2888 R1).
import type { AskState } from "../ask/types";

/** Ask kind used for deploy alerts. Valid `AskKind`; the one field the old call got right. */
export const MONITOR_ALERT_ASK_KIND = "coordination.notify";

/** Metadata key carrying the coalesce identity. */
export const COALESCE_KEY_FIELD = "monitorCoalesceKey";

/**
 * Identity of "the same incident", keyed the way the GitHub-issue channel
 * already de-dups so the two channels agree about what one incident is.
 */
export function buildCoalesceKey(service: string, failureClass: string): string {
  return `${service}|${failureClass}`;
}

/** The declared `asks.create` params this channel sends. No undeclared keys. */
export interface AskCreateArguments {
  kind: typeof MONITOR_ALERT_ASK_KIND;
  title: string;
  question: string;
  severity: "incident";
  forceImmediate: true;
  metadata: Record<string, string>;
}

export interface BuildAskArgumentsInput {
  service: string;
  failureClass: string;
  /** Human-readable alert subject, already rendered by the caller. */
  subject: string;
  details: string;
}

/**
 * Shape the create call.
 *
 * `severity: "incident"` and `forceImmediate: true` are not decoration. The
 * marker requires BOTH a severity event and operator-only remediation
 * (`communication-contract.mdc §Severity transport binding`). A failed
 * production deploy is enumerated as a severity trigger; the operator-only half
 * holds for a STRUCTURAL reason — this monitor runs on a cron in GitHub Actions
 * with no agent attached, so when it fires there is no agent in a turn to pick
 * the work up and the operator is the only available actor.
 *
 * (Contrast mt#3997's capture notice, which deliberately does NOT carry the
 * marker: its remediation is performed by the agent whose turn it lands in.
 * Same substrate, opposite answer, and the discriminator is whether a human is
 * the only actor who can respond.)
 *
 * The two fields are independent: `severity` decides whether the principal is
 * notified, `forceImmediate` whether the ask waits for the next service window.
 * Sending a notification that points at an ask still sitting in a queue is
 * worse than either alone, so both are set.
 */
export function buildAskCreateArguments(input: BuildAskArgumentsInput): AskCreateArguments {
  return {
    kind: MONITOR_ALERT_ASK_KIND,
    title: input.subject,
    question: input.details,
    severity: "incident",
    forceImmediate: true,
    metadata: {
      [COALESCE_KEY_FIELD]: buildCoalesceKey(input.service, input.failureClass),
      service: input.service,
      failureClass: input.failureClass,
      source: "post-deploy-health-monitor",
    },
  };
}

/** The subset of an ask record this decision needs. */
export interface ExistingAsk {
  id: string;
  /**
   * The ask's lifecycle state. Named `state`, NOT `status` — `AskState` in
   * `packages/domain/src/ask/types.ts` is the canonical field, and PR #2888 R1
   * caught this reading `status`, which never matches, so coalescing would
   * silently never fire and every tick would create a duplicate.
   */
  state?: string;
  metadata?: Record<string, unknown> | null;
}

export type AskAlertDecision =
  | { action: "create" }
  | { action: "skip"; reason: "already-open"; existingAskId: string };

/**
 * The TERMINAL `AskState`s, from `packages/domain/src/ask/types.ts`.
 *
 * Tested as a terminal set rather than an open set on purpose (PR #2888 R1).
 * The first version enumerated the OPEN states and got them wrong — it invented
 * `pending` and `delivered`, which do not exist, and omitted `detected` and
 * `responded`, which do. Two failure directions, and they are not symmetric:
 *
 *   - miss an open state  -> coalescing silently never fires -> a duplicate ask
 *     every 10 minutes, which is the exact defect the coalesce exists to stop;
 *   - miss a terminal state -> a resolved incident suppresses a new alert.
 *
 * The terminal set is the smaller and far more stable of the two, and defaulting
 * an UNRECOGNIZED state to "open" fails toward the noisy side, matching
 * `parseOpenAsksResponse`'s asymmetry. A state added to the enum later is
 * therefore handled correctly without touching this file.
 */
// Constructed as `Set<AskState>` so the MEMBERS are checked against the union;
// exposed as `ReadonlySet<string>` so lookups can pass a raw wire value without
// a cast. That split is the point: the literal is validated where it is written,
// and the boundary stays honest about receiving unvalidated strings.
const TERMINAL_ASK_STATES: ReadonlySet<string> = new Set<AskState>([
  "closed",
  "cancelled",
  "expired",
]);

/** True when the ask still represents an unresolved incident. */
function isOpenAsk(state: string | undefined): boolean {
  if (state === undefined) return true;
  return !TERMINAL_ASK_STATES.has(state);
}

/**
 * Create, or coalesce onto an ask already open for this incident.
 *
 * Without this, a sustained outage creates a fresh ask every 10 minutes — the
 * monitor's cron cadence. The substrate's 3-per-24h notification ceiling bounds
 * how often the principal is PAGED and does nothing about how many asks are
 * CREATED, so the ceiling is a backstop for the notification channel, not a
 * substitute for coalescing the records.
 *
 * Matches on the metadata key rather than on the title, so a retitled ask still
 * coalesces and a title that happens to collide does not.
 */
export function decideAskAlert(input: {
  openAsks: ExistingAsk[];
  service: string;
  failureClass: string;
}): AskAlertDecision {
  const key = buildCoalesceKey(input.service, input.failureClass);
  const existing = input.openAsks.find(
    (ask) => isOpenAsk(ask.state) && ask.metadata?.[COALESCE_KEY_FIELD] === key
  );
  return existing
    ? { action: "skip", reason: "already-open", existingAskId: existing.id }
    : { action: "create" };
}

/**
 * Read an `asks_list` response into the records the coalesce decision needs.
 *
 * Returns [] on ANY shape it cannot read — an unparseable listing must not be
 * mistaken for "an ask is already open", because that would SUPPRESS the alert.
 * The asymmetry is deliberate: failing open here duplicates an ask (noisy,
 * recoverable), failing closed would silently drop a production alert.
 */
export function parseOpenAsksResponse(body: unknown): ExistingAsk[] {
  if (!body || typeof body !== "object") return [];
  const envelope = body as { error?: unknown; result?: { isError?: boolean; content?: unknown } };
  if (envelope.error || !envelope.result || envelope.result.isError) return [];

  const text = extractText(envelope.result.content);
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { asks?: unknown }).asks)
      ? (parsed as { asks: unknown[] }).asks
      : [];

  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const record = row as { id?: unknown; state?: unknown; metadata?: unknown };
    if (typeof record.id !== "string") return [];
    return [
      {
        id: record.id,
        ...(typeof record.state === "string" ? { state: record.state } : {}),
        metadata:
          record.metadata && typeof record.metadata === "object"
            ? (record.metadata as Record<string, unknown>)
            : null,
      },
    ];
  });
}

export type ToolCallOutcome = { ok: true; askId: string } | { ok: false; error: string };

/**
 * Read the JSON-RPC response as an OUTCOME, not as a transport status.
 *
 * This is the function the original defect needed and did not have. Three
 * distinct failures all previously read as success:
 *   - a JSON-RPC `error` member returned with HTTP 200;
 *   - a `result` carrying `isError: true` (the MCP tool-error shape);
 *   - a success-shaped result with no ask id in it, which means the call was
 *     accepted and nothing was created.
 *
 * The last one matters most: it is why "the call did not throw" is not
 * evidence. Only an id coming back proves an ask exists.
 */
export function parseAskCreateResponse(body: unknown): ToolCallOutcome {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "response body was not an object" };
  }
  const envelope = body as {
    error?: { message?: string; code?: number };
    result?: { isError?: boolean; content?: unknown };
  };

  if (envelope.error) {
    const code = envelope.error.code === undefined ? "" : ` (code ${envelope.error.code})`;
    return { ok: false, error: `JSON-RPC error${code}: ${envelope.error.message ?? "unknown"}` };
  }
  if (!envelope.result) {
    return { ok: false, error: "response carried neither result nor error" };
  }
  if (envelope.result.isError) {
    return { ok: false, error: `tool reported isError: ${extractText(envelope.result.content)}` };
  }

  const askId = extractAskId(envelope.result.content);
  if (!askId) {
    return { ok: false, error: "call succeeded but returned no ask id — nothing was created" };
  }
  return { ok: true, askId };
}

/** Calls one MCP tool and returns the raw JSON-RPC response body. */
export type McpToolCaller = (name: string, args: object) => Promise<unknown>;

export type AskAlertResult =
  | { outcome: "created"; askId: string }
  | { outcome: "coalesced"; existingAskId: string };

/**
 * The whole secondary-alert flow: list, decide, create — and verify.
 *
 * Extracted from the script (PR #2888 R1) so the end-to-end sequence is
 * exercisable with an injected caller. Previously only the parsers and the
 * builder had tests, so nothing covered the ORDER of the calls, the skip
 * short-circuit, or that a failed create actually throws. The script keeps the
 * fetch/session setup and passes `callTool` in.
 *
 * Throws on a create that did not produce an ask id — the caller logs it as a
 * non-fatal secondary failure. Throwing rather than returning a failure value
 * is deliberate: the old code's sin was making failure look like success, and a
 * thrown error cannot be mistaken for one.
 */
export async function runAskAlert(input: {
  callTool: McpToolCaller;
  service: string;
  failureClass: string;
  subject: string;
  details: string;
}): Promise<AskAlertResult> {
  const openAsks = parseOpenAsksResponse(
    await input.callTool("asks_list", { kind: MONITOR_ALERT_ASK_KIND })
  );

  const decision = decideAskAlert({
    openAsks,
    service: input.service,
    failureClass: input.failureClass,
  });
  if (decision.action === "skip") {
    return { outcome: "coalesced", existingAskId: decision.existingAskId };
  }

  const created = parseAskCreateResponse(
    await input.callTool(
      "asks_create",
      buildAskCreateArguments({
        service: input.service,
        failureClass: input.failureClass,
        subject: input.subject,
        details: input.details,
      })
    )
  );
  if (!created.ok) {
    throw new Error(`asks_create did not create an ask: ${created.error}`);
  }
  return { outcome: "created", askId: created.askId };
}

// ---------------------------------------------------------------------------
// Reading the response body (mt#4012)
// ---------------------------------------------------------------------------

/**
 * Pick THIS request's JSON-RPC message out of an SSE-framed response body.
 *
 * ## Why this exists
 *
 * The MCP Streamable-HTTP transport answers `tools/call` with
 * `Content-Type: text/event-stream` unless the server opts into
 * `enableJsonResponse`, which `src/mcp/server.ts` does not (the SDK default is
 * `false`). So the body is `event: message\ndata: {...}`, not JSON — and the
 * script's `await res.json()` threw `SyntaxError: Failed to parse JSON` on
 * EVERY call for the life of this channel.
 *
 * It failed at the tool call rather than at `initialize` because the init step
 * reads only the `mcp-session-id` HEADER and never touches its (equally
 * SSE-framed) body. And `res.ok` is true throughout: the transport returns a
 * perfectly good HTTP 200, so the existing status guard could never see it.
 *
 * The lexing is NOT reimplemented here — `parseSseEventData`
 * (`src/mcp/shim/sse.ts`) already does it spec-correctly per the WHATWG
 * event-stream algorithm, and the shim client has branched on this since
 * mt#3812. The caller passes its data buffers in; what belongs here is the
 * DECISION of which message is the answer to the request we made.
 *
 * Matches on the JSON-RPC `id` rather than taking the first frame, because a
 * single response stream may legitimately carry notifications (progress events)
 * alongside the result. Falls back to the first parseable object when no id
 * matches, so a server that omits or rewrites the id still yields something the
 * outcome parsers can judge — and they treat an unrecognized shape as FAILURE,
 * so the fallback can never manufacture a false success.
 *
 * @param dataBuffers the `data:` payloads from one SSE response body, in order
 * @param requestId the `id` sent on the JSON-RPC request
 * @returns the matching message, or `null` when nothing parsed
 */
export function selectJsonRpcResponse(dataBuffers: string[], requestId: number): unknown {
  let firstParsed: unknown = null;
  let sawParsed = false;

  for (const buffer of dataBuffers) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(buffer);
    } catch {
      // A frame that is not JSON is not this response — keep scanning rather
      // than failing the whole read on one malformed or non-JSON-RPC event.
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;

    if (!sawParsed) {
      firstParsed = parsed;
      sawParsed = true;
    }
    if ((parsed as { id?: unknown }).id === requestId) return parsed;
  }

  return firstParsed;
}

/**
 * Describe a response body's SHAPE for a diagnostic log line.
 *
 * The originating defect produced 43 minutes of production failure and exactly
 * one repeated exception name, because the read path discarded the body before
 * anything could look at it. This renders enough to identify the shape on the
 * next occurrence.
 *
 * **Emits no body CONTENT, deliberately.** A tool response carries real records
 * (ask titles, service details), and this string lands in a public GitHub
 * Actions run log. Content-type, byte length and a structural classification
 * are enough to tell an SSE frame from an auth redirect from an empty body —
 * which is the whole diagnostic question — without putting payload text into a
 * log. The classification reads only the first non-blank character, never a
 * substring of the body.
 */
export function describeResponseBody(contentType: string | null, bodyText: string): string {
  const type = contentType && contentType.trim() ? contentType.trim() : "(absent)";
  const bytes = Buffer.byteLength(bodyText, "utf8");
  return `content-type=${JSON.stringify(type)}, ${bytes} bytes, shape=${classifyBodyShape(bodyText)}`;
}

/** Structural classification only — never a substring of the body. */
function classifyBodyShape(bodyText: string): string {
  const trimmed = bodyText.trim();
  if (!trimmed) return "empty";
  if (/^(event|data|id|retry):/m.test(trimmed)) return "sse-frames";
  const first = trimmed[0];
  if (first === "{") return "json-object";
  if (first === "[") return "json-array";
  if (first === "<") return "markup (html/xml — likely an error or auth page)";
  return "other-text";
}

// ---------------------------------------------------------------------------
// Retiring an ask whose condition recovered (mt#4012)
// ---------------------------------------------------------------------------

/**
 * Responder recorded on a monitor-driven cancellation.
 *
 * `system:<event>` per `asks.cancel`'s documented convention. The command
 * REJECTS the literal `operator` outright, which is the property this channel
 * depends on: the monitor is withdrawing an alert nobody answered, and
 * recording the principal as the responder would misreport that as a decision
 * they made (mt#3353).
 */
export const MONITOR_RECOVERY_RESPONDER = "system:monitor-observed-recovery";

export type AskCancelDecision =
  | { action: "cancel"; askId: string }
  | { action: "none"; reason: "no-open-ask" };

/**
 * Decide whether a recovered class has an open ask to retire.
 *
 * The mirror image of `decideAskAlert`, matching on the SAME coalesce key, so
 * the ask a recovery closes is by construction the one the alert opened.
 *
 * **Caller precondition — this function cannot enforce it.** Call this ONLY for
 * a class `observedRecoveredClasses` reports, which requires POSITIVE evidence
 * that the detecting check RAN and found no problem. "No alert fired this run"
 * is NOT recovery (mt#3963), and a check that could not run is not recovery
 * either — an unrunnable check must close nothing. The same precondition
 * governs `resolveP0IfRecovered` on the GitHub-issue side, and both are called
 * from the one loop that already establishes it.
 */
export function decideAskCancel(input: {
  openAsks: ExistingAsk[];
  service: string;
  failureClass: string;
}): AskCancelDecision {
  const key = buildCoalesceKey(input.service, input.failureClass);
  const existing = input.openAsks.find(
    (ask) => isOpenAsk(ask.state) && ask.metadata?.[COALESCE_KEY_FIELD] === key
  );
  return existing
    ? { action: "cancel", askId: existing.id }
    : { action: "none", reason: "no-open-ask" };
}

export type AskCancelOutcome =
  | { ok: true; askId: string; outcome: string }
  | { ok: false; error: string };

/**
 * Read an `asks_cancel` response as an OUTCOME.
 *
 * Same discipline as `parseAskCreateResponse`, and for the same reason: this
 * channel's founding defect was treating "the call did not throw" as evidence.
 * Success here is a terminal disposition coming back — `cancelled`, `closed`,
 * or `already-terminal`, the last being what makes a re-run safe (AT4).
 *
 * `not-found` and `skipped` are FAILURES rather than benign no-ops: both mean
 * the ask we matched on is still out there unretired, which is the state this
 * path exists to prevent, and reporting them as success would rebuild the
 * original lie one command over.
 */
const TERMINAL_CANCEL_OUTCOMES: ReadonlySet<string> = new Set([
  "cancelled",
  "closed",
  "already-terminal",
]);

export function parseAskCancelResponse(body: unknown): AskCancelOutcome {
  if (!body || typeof body !== "object") {
    return { ok: false, error: "response body was not an object" };
  }
  const envelope = body as {
    error?: { message?: string; code?: number };
    result?: { isError?: boolean; content?: unknown };
  };

  if (envelope.error) {
    const code = envelope.error.code === undefined ? "" : ` (code ${envelope.error.code})`;
    return { ok: false, error: `JSON-RPC error${code}: ${envelope.error.message ?? "unknown"}` };
  }
  if (!envelope.result) {
    return { ok: false, error: "response carried neither result nor error" };
  }
  if (envelope.result.isError) {
    return { ok: false, error: `tool reported isError: ${extractText(envelope.result.content)}` };
  }

  const text = extractText(envelope.result.content);
  let parsed: { askId?: unknown; outcome?: unknown };
  try {
    parsed = JSON.parse(text) as { askId?: unknown; outcome?: unknown };
  } catch {
    return { ok: false, error: "cancel result was not JSON" };
  }

  const outcome = typeof parsed.outcome === "string" ? parsed.outcome : "";
  if (!TERMINAL_CANCEL_OUTCOMES.has(outcome)) {
    return {
      ok: false,
      error: `cancel did not retire the ask (outcome: ${outcome || "absent"})`,
    };
  }
  return {
    ok: true,
    askId: typeof parsed.askId === "string" ? parsed.askId : "(unknown)",
    outcome,
  };
}

export type AskRecoveryCloseResult =
  | { outcome: "cancelled"; askId: string; disposition: string }
  | { outcome: "none"; reason: "no-open-ask" };

/**
 * List -> decide -> cancel -> verify, for a class observed RECOVERED.
 *
 * The symmetric counterpart of `runAskAlert`, sharing its structure so the two
 * halves of the channel's lifecycle read the same way. Throws on a cancel that
 * did not retire the ask, for the same reason `runAskAlert` throws on a create
 * that produced no id: a failure that looks like a success is the one defect
 * this whole module exists to prevent.
 *
 * See `decideAskCancel` for the recovery-evidence precondition the caller owns.
 */
export async function runAskRecoveryClose(input: {
  callTool: McpToolCaller;
  service: string;
  failureClass: string;
  reason: string;
}): Promise<AskRecoveryCloseResult> {
  const openAsks = parseOpenAsksResponse(
    await input.callTool("asks_list", { kind: MONITOR_ALERT_ASK_KIND })
  );

  const decision = decideAskCancel({
    openAsks,
    service: input.service,
    failureClass: input.failureClass,
  });
  if (decision.action === "none") {
    return { outcome: "none", reason: decision.reason };
  }

  const cancelled = parseAskCancelResponse(
    await input.callTool("asks_cancel", {
      id: decision.askId,
      reason: input.reason,
      responder: MONITOR_RECOVERY_RESPONDER,
    })
  );
  if (!cancelled.ok) {
    throw new Error(`asks_cancel did not retire ask ${decision.askId}: ${cancelled.error}`);
  }
  return { outcome: "cancelled", askId: decision.askId, disposition: cancelled.outcome };
}

/** Flatten MCP `content` blocks to text. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : ""
    )
    .join("");
}

/**
 * Pull the created ask's id out of the tool result.
 *
 * Tolerant of shape because the boundary is a serialized tool response, not a
 * typed call: accepts a JSON payload carrying `id` or `shortId`, and falls back
 * to a `mem`-style `ask#N` / uuid found in the text. Returns null when there is
 * nothing that looks like an id — which the caller treats as a FAILURE, so
 * tolerance here never converts a miss into a false success.
 */
function extractAskId(content: unknown): string | null {
  const text = extractText(content);
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as { id?: unknown; shortId?: unknown };
    if (typeof parsed.id === "string" && parsed.id) return parsed.id;
    if (typeof parsed.shortId === "string" && parsed.shortId) return parsed.shortId;
  } catch {
    // Not JSON — fall through to the textual scan below. Not an error: the tool
    // surface is free to return prose, and a miss becomes a failure anyway.
  }

  const shortId = text.match(/\bask#\d+\b/);
  if (shortId) return shortId[0];
  const uuid = text.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i);
  return uuid ? uuid[0] : null;
}
