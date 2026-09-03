/**
 * ACP permission-request → Ask bridge (mt#4936).
 *
 * When an ACP agent (Codex CLI's `codex-acp`, `claude-agent-acp`, or any
 * other ACP-compliant agent) sends a `session/request_permission` request,
 * `AcpTransport` (`src/cockpit/acp-transport.ts`) turns it into a Minsky
 * Ask so a human decides, then translates the Ask's resolution back into the
 * ACP `RequestPermissionOutcome` the agent is waiting on.
 *
 * Mirrors `../credentials/request.ts`'s pure-builder-plus-classifier split
 * exactly: every function here is pure (build the draft, classify a
 * resolved Ask), and the IO (creating the Ask, polling for its resolution)
 * lives in the caller — `AcpTransport` — so the whole decision surface is
 * testable with no database and no live ACP agent process.
 *
 * @see docs/architecture/adr-047-driver-transport-interface.md
 * @see packages/domain/src/credentials/request.ts — the pattern this mirrors
 */
import type { Ask, AskKind, AskOption } from "./types";

/**
 * The kind an ACP permission request is filed under.
 *
 * `authorization.approve` — "can act, shouldn't without permission" is
 * exactly what a tool-call permission request is. Per `../ask/router.ts`
 * (`pickTransport`) this kind routes to the operator inbox, which is where a
 * human can actually see the tool call and decide.
 *
 * Carries the SAME known exposure `../credentials/request.ts` documents:
 * `authorization.approve` is the sole member of `POLICY_ELIGIBLE_KINDS`
 * (`../ask/policy.ts`), so phase-1 policy consultation can close this ask
 * against an unrelated citation before a human ever sees it (mt#3233). For a
 * permission request the failure direction is worse than for a credential
 * request: a silent policy close must NEVER read as "approved" — see
 * {@link isPolicyResolved} and {@link classifyAcpPermissionResponse}'s
 * `"policy-closed"` branch, which the caller MUST treat as a refusal, never
 * as a selected option.
 */
export const ACP_PERMISSION_REQUEST_ASK_KIND: AskKind = "authorization.approve";

/** Metadata key carrying the ACP-specific context (tool call id, harness). */
export const ACP_PERMISSION_REQUEST_METADATA_KEY = "acpPermissionRequest";

/** ACP-specific context stashed in the Ask's metadata — never a decision. */
export interface AcpPermissionRequestPayload {
  readonly harnessKind: string;
  readonly toolCallId: string;
  readonly toolTitle: string;
}

/** One ACP `PermissionOption`, as `AcpTransport` reads it off the wire. */
export interface AcpPermissionOptionInput {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

/** Inputs for {@link buildAcpPermissionRequestAsk}. */
export interface BuildAcpPermissionRequestAskInput {
  /** Which ACP-driven harness is asking (`"codex"`, `"claude-code-acp"`, …). */
  readonly harnessKind: string;
  readonly toolCallId: string;
  readonly toolTitle: string;
  readonly options: readonly AcpPermissionOptionInput[];
  /** The drive's bound task, when there is one — "parented to the drive's
   * task when bound" (mt#4936 spec SC2). */
  readonly parentTaskId?: string;
}

/** The ask-shaped result: exactly the fields a caller passes to ask creation. */
export interface AcpPermissionRequestAskDraft {
  readonly kind: AskKind;
  readonly title: string;
  readonly question: string;
  readonly options: AskOption[];
  readonly parentTaskId?: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Build the ask for an ACP permission request.
 *
 * Pure — returns the draft rather than creating anything. Each ACP
 * `PermissionOption` becomes one `AskOption`: `value` carries the ACP
 * `optionId` verbatim (per `AskOption.value`'s own contract — "what the
 * router stores in the response payload"), so
 * {@link classifyAcpPermissionResponse} can read the operator's choice back
 * without a second mapping table.
 */
export function buildAcpPermissionRequestAsk(
  input: BuildAcpPermissionRequestAskInput
): AcpPermissionRequestAskDraft {
  const { harnessKind, toolCallId, toolTitle, options, parentTaskId } = input;

  const question = [
    `**${harnessKind}** wants to run a tool call and is waiting for permission:`,
    "",
    `> ${toolTitle}`,
    "",
    "Choose one of the options below. The agent is blocked until you respond.",
  ].join("\n");

  const payload: AcpPermissionRequestPayload = { harnessKind, toolCallId, toolTitle };

  return {
    kind: ACP_PERMISSION_REQUEST_ASK_KIND,
    title: `Permission requested: ${toolTitle}`,
    question,
    options: options.map((o) => ({ label: o.name, value: o.optionId, description: o.kind })),
    ...(parentTaskId ? { parentTaskId } : {}),
    metadata: { [ACP_PERMISSION_REQUEST_METADATA_KEY]: payload },
  };
}

/**
 * True when the router resolved this ask in-policy rather than routing it to
 * a human — same exposure and same check as
 * `../credentials/request.ts`'s `isPolicyResolved`. Duplicated rather than
 * imported: the two modules are independent HITL bridges that happen to
 * share one router quirk, not a shared abstraction — see that module's own
 * doc comment for the full mt#3233 background.
 */
export function isPolicyResolved(ask: Pick<Ask, "routingTarget" | "response">): boolean {
  return ask.routingTarget === "policy" || ask.response?.responder === "policy";
}

/**
 * What the requesting `AcpTransport` observes while waiting on a permission
 * ask. Mirrors `CredentialRequestStatus`'s shape (`../credentials/request.ts`)
 * for the same reasons: `cancelled` (principal declined or the ask expired)
 * and `policy-closed` (mt#3233 — resolved with no human ever seeing it) are
 * BOTH translated to ACP's `{ outcome: "cancelled" }` by the caller — never
 * `"selected"` — because neither carries an actual human decision to run the
 * tool call.
 */
export type AcpPermissionRequestStatus =
  | { status: "pending" }
  | { status: "selected"; optionId: string }
  | { status: "cancelled" }
  | { status: "policy-closed" };

/**
 * Classify a permission-request ask's current state for the transport that
 * filed it. Pure.
 */
export function classifyAcpPermissionResponse(
  ask: Pick<Ask, "state" | "response" | "routingTarget">
): AcpPermissionRequestStatus {
  if (ask.state === "cancelled" || ask.state === "expired") {
    return { status: "cancelled" };
  }

  if (ask.state !== "responded" && ask.state !== "closed") {
    return { status: "pending" };
  }

  // A phase-1 policy close is NOT a decision — see `isPolicyResolved`'s doc
  // comment. Checked before reading the payload: a policy close never wrote
  // a real option selection, and even if it happened to write something
  // payload-shaped, treating it as "selected" would run a tool call nobody
  // approved.
  if (isPolicyResolved(ask)) {
    return { status: "policy-closed" };
  }

  const payload = ask.response?.payload as { value?: unknown } | undefined;
  const value = payload?.value;
  if (typeof value === "string" && value.length > 0) {
    return { status: "selected", optionId: value };
  }

  // Responded/closed but no recognizable option value — the principal
  // declined without picking a listed option, or the response payload is
  // shaped some other way. Fail closed: never run an unapproved tool call.
  return { status: "cancelled" };
}
