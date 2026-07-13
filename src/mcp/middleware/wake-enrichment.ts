/**
 * Wake-signal enrichment middleware (mt#1661 v0 — pull-on-tool-call delivery).
 *
 * Sibling to `memory-enrichment.ts`. Drains undelivered `wake_pending` rows for
 * the calling session at every allowlisted MCP tool call and appends them as a
 * `{type:"text"}` content block in the tool response.
 *
 * **v0 scope: babysit-PR case + tools carrying session/task args.** Cross-session,
 * agent-handoff, and surface-rebinding wake delivery require the `InterfaceBinding`
 * model designed in mt#1506. v0 covers only the unambiguous case where the
 * calling tool's args directly name the session/task (`session`, `sessionId`,
 * `task`, or `taskId`).
 *
 * Telemetry: every call emits one of three structured log events:
 *   - `wake.enrichment.delivered` (with count): wakes drained and delivered
 *   - `wake.enrichment.no_session_id` (with tool name): caller carried no
 *     resolvable session arg — this is the v0-inadequacy signal that feeds
 *     mt#1506's binding-model design
 *   - silent (no event): session resolved but no pending wakes — common case
 *
 * Reference: mt#1519 §5, mt#1661 spec.
 */

import type { WakeSignalPayload } from "@minsky/domain/ask/wake-on-respond";
import { log } from "@minsky/shared/logger";

/**
 * Surface the middleware uses against the wake-pending store. Subset of
 * `WakePendingRepository` — only the consumer-side method.
 */
export interface WakeServiceSurface {
  drainBySession(parentSessionId: string, drainedForTool: string): Promise<WakeSignalPayload[]>;
}

/**
 * Resolves a session ID from a session-name reference (`args.session`/`args.sessionId`).
 * v0 keeps this opaque — the consumer of this module supplies a real resolver in
 * production wiring; tests pass a fake resolver. The middleware cannot resolve
 * task → session itself without pulling in the session repository, which crosses
 * a layer boundary; the caller does the lookup.
 */
export interface SessionResolver {
  /**
   * Given a session name OR a task ID, return the Minsky session UUID this
   * caller is bound to (matches `Ask.parentSessionId`). Returns null when the
   * input doesn't resolve (unknown session, no session for task, etc.).
   *
   * Implementation note: the v0 production resolver maps:
   *   - `session` arg directly → session.id
   *   - `task` arg → session lookup by taskId → session.id
   * v0 punts on "agent-bound-to-session" reverse lookup; that requires mt#1506.
   */
  resolveParentSessionId(args: Record<string, unknown>): Promise<string | null>;
}

export interface WakeEnrichmentBlock {
  type: "text";
  text: string;
}

/**
 * Tools the v0 wake-enrichment middleware fires on.
 *
 * Includes tools from the original asks-path allowlist (`tasks.get`) PLUS tools
 * an operator-driven agent would call while waiting on a PR-watch notification
 * (mt#1725 extension). The common pattern: agent registers a pr_watch, does other
 * work, calls one of these tools, and the wake-enrichment block arrives in the
 * response carrying the watch-fired signal.
 *
 * Allowlist criteria:
 *   - The tool carries `session` or `sessionId` args (required for session resolution)
 *   - It is a read-oriented query that an agent polls naturally during babysitting
 *   - Adding it does not open a delivery path to unrelated callers
 */
const WAKE_ENRICHMENT_ALLOWLIST = new Set<string>([
  "tasks.get",
  "pr.watch.list",
  "tasks.status.get",
  "session.pr.get",
  "session.pr.list",
]);

/** Total character budget for the wake-enrichment block (envelope + payload). */
const DEFAULT_CHAR_BUDGET = 4000;

/** Telemetry tags. Operators grep on these. */
const TAG_DELIVERED = "wake.enrichment.delivered";
const TAG_NO_SESSION_ID = "wake.enrichment.no_session_id";
const TAG_FAILED = "wake.enrichment.failed";

export interface WakeEnrichmentOptions {
  charBudget?: number;
}

/**
 * Returns true when this tool is in the v0 wake-enrichment allowlist.
 */
export function shouldEnrichWake(toolName: string): boolean {
  return WAKE_ENRICHMENT_ALLOWLIST.has(toolName);
}

/**
 * Run the wake-enrichment middleware against a tool call.
 *
 * Returns a content block when undelivered wakes were drained for the calling
 * session; `null` otherwise. Errors are logged at `wake.enrichment.failed` and
 * suppressed — enrichment failure must NEVER break the underlying tool call
 * (same contract as memory-enrichment).
 *
 * Telemetry: the three named log tags are mutually exclusive on the success
 * path. The `no_session_id` tag is the v0-inadequacy signal feeding mt#1506.
 */
export async function enrichWakeResponse(
  toolName: string,
  args: Record<string, unknown>,
  wakeService: WakeServiceSurface | undefined,
  sessionResolver: SessionResolver | undefined,
  options: WakeEnrichmentOptions = {}
): Promise<WakeEnrichmentBlock | null> {
  if (!shouldEnrichWake(toolName)) return null;
  if (!wakeService || !sessionResolver) return null;

  const charBudget = options.charBudget ?? DEFAULT_CHAR_BUDGET;

  let parentSessionId: string | null;
  try {
    parentSessionId = await sessionResolver.resolveParentSessionId(args);
  } catch (err: unknown) {
    log.debug("[wake-enrichment] session resolver failed; skipping", {
      tool: toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  if (!parentSessionId) {
    log.cli(
      `${TAG_NO_SESSION_ID} ${JSON.stringify({
        event: TAG_NO_SESSION_ID,
        tool: toolName,
      })}`
    );
    return null;
  }

  let payloads: WakeSignalPayload[];
  try {
    payloads = await wakeService.drainBySession(parentSessionId, toolName);
  } catch (err: unknown) {
    log.cli(
      `${TAG_FAILED} ${JSON.stringify({
        event: TAG_FAILED,
        tool: toolName,
        error: err instanceof Error ? err.message : String(err),
      })}`
    );
    return null;
  }

  // Session resolved but no pending wakes — silent no-op. This is the common case
  // and emitting telemetry per call would be noisy.
  if (payloads.length === 0) return null;

  log.cli(
    `${TAG_DELIVERED} ${JSON.stringify({
      event: TAG_DELIVERED,
      tool: toolName,
      count: payloads.length,
    })}`
  );

  return buildBlock(toolName, parentSessionId, payloads, charBudget);
}

/**
 * Format the drained wakes as a single content block.
 *
 * Format mirrors memory-enrichment's envelope shape (`<wake-events ...>`) so
 * downstream parsers can detect both blocks uniformly.
 */
function buildBlock(
  toolName: string,
  parentSessionId: string,
  payloads: WakeSignalPayload[],
  charBudget: number
): WakeEnrichmentBlock | null {
  const envelope = `<wake-events tool="${toolName}" session="${parentSessionId}" count="${payloads.length}">\n`;
  const closing = `\n</wake-events>`;
  let bodyBudget = charBudget - envelope.length - closing.length;
  if (bodyBudget <= 0) return null;

  const lines: string[] = [];
  for (const p of payloads) {
    const line = JSON.stringify(p);
    if (line.length + 1 > bodyBudget) {
      // Budget exceeded mid-payload; stop appending so we don't truncate JSON
      // (operators rely on each line being valid JSON for downstream parsing).
      break;
    }
    lines.push(line);
    bodyBudget -= line.length + 1;
  }
  if (lines.length === 0) return null;

  return {
    type: "text",
    text: `${envelope}${lines.join("\n")}${closing}`,
  };
}
