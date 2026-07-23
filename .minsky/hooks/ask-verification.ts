// Server-side verification of an approved `authorization.approve` Ask
// (mt#2823). Shared by the issuance surface (`scripts/grant-ask-action.ts`)
// and the bridge hook (`.minsky/hooks/ask-permission-bridge.ts`) — issuance
// verifies at mint time AND the hook re-verifies at decision time, so a
// hand-written store entry still fails at the hook (defense-in-depth; the
// store is never the authority, the Ask's DB state is).
//
// Mechanism: shell out to a `minsky tools asks list --id <id>` CLI read (the
// same reach-the-server mechanism as the mt#2813 standalone-duplicate probe)
// rather than importing `packages/domain` — keeps the hook self-contained per
// `.claude/hooks/SPEC.md`. The lookup is BY ID (mt#3007); it previously paged
// through `tools asks list --state ...`, which silently missed asks outside
// the page. An empty result array is a structured "absent" signal, so a
// missing ask is never confused with a broken read.
//
// Security posture (the spec's fabrication criterion):
//   - ask must EXIST (a nonexistent id is refused, not deferred)
//   - kind must be exactly "authorization.approve"
//   - state must be "responded" or "closed" — an Ask in any other state
//     cannot carry a valid operator answer (enforced explicitly since the
//     by-id lookup can return an Ask in ANY state)
//   - response.responder must be "operator" — agent/policy/timeout
//     responders are REFUSED, closing the self-respond vector (an agent
//     calling asks_respond on its own ask cannot mint authorization)
//   - the response VALUE must be a structured approval (conservative
//     default: not approving)
// Anything the CLI cannot confirm is "unavailable", which callers treat as
// not-verified (never allow on unverifiable state).

import { execWithPath } from "./types";

const ASKS_CLI_TIMEOUT_MS = 20000;

/**
 * States in which an Ask can carry an operator's answer.
 *
 * The predecessor implementation enforced this implicitly by only ever
 * fetching `--state responded` and `--state closed`. The by-id lookup can
 * return an Ask in ANY state, so the constraint has to be explicit — otherwise
 * a cancelled or expired Ask that still carries a stale approving response
 * would verify (reviewer R1, mt#3007).
 */
const ANSWERABLE_STATES = new Set(["responded", "closed"]);

export interface AskVerificationResult {
  verdict: "approved" | "not-approved" | "unavailable";
  detail: string;
}

/** Minimal row shape read from `tools asks get` JSON output. */
export interface AskRow {
  id?: unknown;
  kind?: unknown;
  state?: unknown;
  response?: { responder?: unknown; payload?: unknown };
}

type AskFetch =
  | { ok: true; row: AskRow }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "error"; message: string };

export type ExecFn = (
  cmd: string[],
  options?: { timeout?: number }
) => { exitCode: number; stdout: string; stderr: string };

/**
 * Tokens that count as an approval when they appear as a response VALUE.
 * Deliberately narrow — see `isApprovingPayload`.
 */
const APPROVAL_TOKEN = /^(approved?|yes)$/i;

/**
 * Keys whose string value is treated as the operator's chosen response.
 *
 * `value` is the cockpit-resolve shape; `chosen`/`option` are what the inbox
 * writes when the operator picks an option button (mt#3007 — verified against
 * a real approval, which stored `{ chosen: "approve", option: "approve" }`).
 *
 * `message` is deliberately ABSENT: a free-text prose response is not a
 * structured approval signal, and accepting one would let an agent mint
 * authorization by writing prose into an ask response.
 */
const CHOICE_KEYS = ["value", "chosen", "option"] as const;

/**
 * True when a kind-specific response payload expresses approval. Handles the
 * `{ approved: boolean }` cockpit-resolve shape and approve-shaped option
 * values (`value` / `chosen` / `option`); everything else — including absent
 * payloads and free-text messages — is NOT approval.
 *
 * Note the conservative treatment of `{chosen}`: the chosen value is an OPTION
 * VALUE, not necessarily the literal word "approved", so this only accepts one
 * that is itself approve-shaped. An `authorization.approve` ask whose approving
 * option carries some other value (say `"authorize-hook-override"`) therefore
 * fails CLOSED rather than being resolved against the ask's option list. That
 * is intentional: blanket-accepting any `{chosen}` would make DECLINING an
 * authorization ask read as approving it, which is the one error this function
 * must never make.
 */
export function isApprovingPayload(payload: unknown): boolean {
  if (payload === null || payload === undefined) return false;
  if (typeof payload === "string") return APPROVAL_TOKEN.test(payload.trim());
  if (typeof payload === "object") {
    const rec = payload as Record<string, unknown>;
    if (rec.approved === true) return true;
    for (const key of CHOICE_KEYS) {
      const candidate = rec[key];
      if (typeof candidate === "string" && APPROVAL_TOKEN.test(candidate.trim())) return true;
    }
  }
  return false;
}

/** Pure evaluation of fetched ask rows against the approval criteria. */
export function evaluateAskRows(rows: AskRow[], askId: string): AskVerificationResult {
  const ask = rows.find((r) => typeof r.id === "string" && r.id === askId);
  if (!ask) {
    return {
      verdict: "not-approved",
      detail: `ask ${askId} not found among recent responded/closed authorization.approve asks`,
    };
  }
  if (ask.kind !== "authorization.approve") {
    return {
      verdict: "not-approved",
      detail: `ask ${askId} has kind "${String(ask.kind)}", not authorization.approve`,
    };
  }
  if (typeof ask.state !== "string" || !ANSWERABLE_STATES.has(ask.state)) {
    return {
      verdict: "not-approved",
      detail: `ask ${askId} is in state "${String(ask.state)}", not responded/closed`,
    };
  }
  const responder = ask.response?.responder;
  if (responder !== "operator") {
    return {
      verdict: "not-approved",
      detail: `ask ${askId} responder is "${String(responder ?? "absent")}", not operator`,
    };
  }
  if (!isApprovingPayload(ask.response?.payload)) {
    return {
      verdict: "not-approved",
      detail: `ask ${askId} response value is not an approval`,
    };
  }
  return { verdict: "approved", detail: `ask ${askId} approved by operator` };
}

/**
 * Fetch a single Ask BY ID.
 *
 * mt#3007: this replaces a paged scan of `tools asks list --state responded`
 * plus `--state closed` at `--limit 200`. That approach rested on a documented
 * assumption — "a newest-first page of this size always contains the target" —
 * which is FALSE: the list is not ordered newest-first. Verified 2026-07-22
 * against the originating incident's own ask (`7fee3742`, closed 2026-07-21):
 * it did not appear anywhere in the 200-row page, whose entries were all from
 * 2026-07-13/14. A genuinely fresh, genuinely approved ask could therefore be
 * reported "not found among recent responded/closed authorization.approve
 * asks" — which is verbatim the error the originating incident hit and
 * attributed to a different cause.
 *
 * Uses the `--id` filter rather than `tools asks get` so that ABSENCE is a
 * structured signal: a nonexistent id returns exit 0 with an empty `asks`
 * array, which cannot be confused with an infrastructure failure. (Reviewer
 * R1: `asks get` reports absence only in prose, so telling "missing" from
 * "broken" would have depended on matching an error string.)
 */
function fetchAskById(askId: string, exec: ExecFn): AskFetch {
  const result = exec(["minsky", "tools", "asks", "list", "--id", askId], {
    timeout: ASKS_CLI_TIMEOUT_MS,
  });

  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: "error",
      message: `minsky tools asks list --id exited ${result.exitCode}: ${result.stderr.trim()}`,
    };
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout);
    const asks = (parsed as { asks?: unknown })?.asks;
    if (!Array.isArray(asks)) {
      return { ok: false, reason: "error", message: "unexpected asks list shape" };
    }
    const row = asks.find((r) => (r as AskRow)?.id === askId) as AskRow | undefined;
    if (!row) return { ok: false, reason: "not-found" };
    return { ok: true, row };
  } catch (err) {
    return {
      ok: false,
      reason: "error",
      message: `unparseable asks list JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Verify `askId` is an operator-approved `authorization.approve` Ask.
 *
 * Reads the Ask directly by id, so there is no page window to fall outside of
 * and no partial-failure case to reconcile across two fetches (the mt#3007
 * predecessor read two state pages and had to decide what a not-found verdict
 * meant when one of them was unreadable — a single fetch removes that class
 * rather than handling it).
 *
 * Fail posture: a nonexistent id is "not-approved" (fail closed — a fabricated
 * id must never verify); anything the CLI could not confirm is "unavailable",
 * which callers treat as not-verified and never as permission.
 */
export function verifyApprovedAsk(
  askId: string,
  exec: ExecFn = execWithPath
): AskVerificationResult {
  const fetched = fetchAskById(askId, exec);

  if (!fetched.ok) {
    if (fetched.reason === "not-found") {
      return { verdict: "not-approved", detail: `ask ${askId} does not exist` };
    }
    return { verdict: "unavailable", detail: fetched.message };
  }

  return evaluateAskRows([fetched.row], askId);
}
