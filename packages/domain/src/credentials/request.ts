/**
 * Agent-initiated credential request (mt#4030).
 *
 * Gives an agent a way to ASK the principal for a credential it cannot read,
 * without the value ever entering the transcript. Every function here is pure:
 * the request is BUILT here, the satisfaction decision is MADE here, and the IO
 * (creating the ask, reading the credential listing, closing the ask) lives in
 * the callers — so the whole decision surface is testable with no database and
 * no network.
 *
 * **Data-path invariant.** The credential value travels browser → cockpit server
 * → `~/.config/minsky/config.yaml` and touches nothing in this module. There is
 * deliberately no parameter, field, or return value here capable of carrying a
 * secret; see `mem#564` for why chat is the forbidden transport (the transcript
 * is persisted to disk AND ingested into the transcripts DB).
 *
 * @see docs/architecture/adr-008-attention-allocation-subsystem.md — the ask entity
 * @see packages/domain/src/credentials/providers/index.ts — the provider registry
 */
import {
  CREDENTIAL_REQUEST_METADATA_KEY,
  readCredentialRequest,
} from "@minsky/shared/credential-request";
import type { CredentialRequestPayload } from "@minsky/shared/credential-request";
import type { Ask, AskKind } from "../ask/types";
import type { CredentialProvider } from "./types";

/**
 * The payload contract is defined in `@minsky/shared` and re-exported here.
 *
 * Both sides need it — this module builds and resolves the request, and the
 * browser-bundled cockpit reads it off an ask to pick a render mode — and this
 * module is Node-reaching, so the browser cannot import it
 * (`custom/no-node-import-in-cockpit-web`, mt#3239). Re-exported rather than
 * redefined so the key string has exactly one definition.
 */
export {
  CREDENTIAL_REQUEST_METADATA_KEY,
  readCredentialRequest,
  type CredentialRequestPayload,
} from "@minsky/shared/credential-request";

/**
 * The kind a credential request is filed under.
 *
 * `authorization.approve`, NOT the semantically-nearer `capability.escalate`:
 * per `pickTransport` (`../ask/router.ts`) that kind binds to `subagent`, which
 * would route a request for an operator-held secret to an agent holding
 * strictly fewer capabilities than the one that asked. This kind binds to the
 * operator inbox, which is where a human can actually answer it.
 *
 * That choice carries a known exposure — see {@link isPolicyResolved}.
 */
export const CREDENTIAL_REQUEST_ASK_KIND: AskKind = "authorization.approve";

/** Inputs for {@link buildCredentialRequestAsk}. Carries no secret-shaped field. */
export interface BuildCredentialRequestInput {
  /** The registered provider whose credential is wanted. */
  readonly provider: CredentialProvider;
  /** Human-readable reason shown to the principal — why this is needed now. */
  readonly reason: string;
  /** Task this request blocks, when there is one. */
  readonly parentTaskId?: string;
}

/** The ask-shaped result: exactly the fields a caller passes to ask creation. */
export interface CredentialRequestAskDraft {
  readonly kind: AskKind;
  readonly title: string;
  readonly question: string;
  readonly parentTaskId?: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Build the ask for a credential request.
 *
 * Pure — returns the draft rather than creating anything, so the wording, the
 * metadata shape, and the absence of any value-bearing field are all assertable
 * without a repository.
 *
 * Wording notes, both load-bearing rather than stylistic:
 * - The provider's `acquireUrl` is embedded, which is what keeps the body clear
 *   of the form-lint `portal-no-link` check — a request that names a dashboard
 *   without linking it makes the principal go find it.
 * - The body says "project" rather than "production" and states plainly that
 *   nothing is broken. A credential request is an operator-only chore but NOT a
 *   severity event, so it must not read like one; per
 *   `communication-contract.mdc` both halves are required for the severity
 *   marker and only one holds here.
 */
export function buildCredentialRequestAsk(
  input: BuildCredentialRequestInput
): CredentialRequestAskDraft {
  const { provider, reason, parentTaskId } = input;
  const payload: CredentialRequestPayload = { provider: provider.id };

  const question = [
    `**Enter the ${provider.displayName} credential below — the value goes straight to the credential store and never through this conversation.**`,
    "",
    reason.trim(),
    "",
    `Get it here: ${provider.acquireUrl}`,
    "",
    provider.scopeGuidance.trim(),
    "",
    `It lands at \`${provider.configPath}\`. Nothing is broken — a queued step is waiting on it. Decline if you would rather not.`,
  ].join("\n");

  return {
    kind: CREDENTIAL_REQUEST_ASK_KIND,
    title: `Add the ${provider.displayName} credential`,
    question,
    ...(parentTaskId ? { parentTaskId } : {}),
    metadata: { [CREDENTIAL_REQUEST_METADATA_KEY]: payload },
  };
}

/**
 * True when the router resolved this ask in-policy rather than routing it to a
 * human — the failure this feature must never wait on silently.
 *
 * **Why this check exists.** `authorization.approve` is the SOLE member of
 * `POLICY_ELIGIBLE_KINDS` (`../ask/policy.ts`), so the one kind that reaches the
 * operator inbox is also the one kind phase-1 policy consultation can
 * short-circuit. That path has fired repeatedly (mt#3233), closing operator-bound
 * asks in ~150ms against topically unrelated citations, with `tokenCost: 0` and
 * no operator ever seeing them — on WELL-FORMED questions, so careful wording is
 * not a defense.
 *
 * For a credential request the consequence is worse than for a decision ask.
 * Resolution here is by credential PRESENCE, so a policy close cannot produce a
 * false "satisfied" — it produces a request that never resolves at all, while
 * the row reads downstream as resolved at zero operator cost. The agent would
 * wait forever on a credential nobody was ever asked for. Callers MUST read the
 * ask back after creating it and fail loudly on `true` rather than entering the
 * wait.
 *
 * The clean fix — whether the kind stays policy-eligible — is mt#3715.
 */
export function isPolicyResolved(ask: Pick<Ask, "routingTarget" | "response">): boolean {
  return ask.routingTarget === "policy" || ask.response?.responder === "policy";
}

/** States in which a credential request is still awaiting the principal. */
const PENDING_STATES: ReadonlySet<Ask["state"]> = new Set([
  "detected",
  "classified",
  "routed",
  "suspended",
]);

/** A pending request paired with the provider it is waiting on. */
export interface PendingCredentialRequest {
  readonly ask: Ask;
  readonly provider: string;
}

/**
 * Select the still-open credential requests from a set of asks.
 *
 * Terminal rows are excluded so a re-run cannot re-close an already-closed
 * request, which is what makes the resolver safe to call on every sweep tick.
 */
export function selectPendingCredentialRequests(asks: readonly Ask[]): PendingCredentialRequest[] {
  const pending: PendingCredentialRequest[] = [];
  for (const ask of asks) {
    if (!PENDING_STATES.has(ask.state)) continue;
    const payload = readCredentialRequest(ask);
    if (payload) pending.push({ ask, provider: payload.provider });
  }
  return pending;
}

/** One provider's presence signal, as read back from the credential listing. */
export interface ProviderPresence {
  readonly provider: string;
  readonly configured: boolean;
  /** The provider's own validation line — e.g. "3 buckets visible". Never a value. */
  readonly detail?: string;
}

/** A request whose credential is now present, and the detail to close it with. */
export interface SatisfiedCredentialRequest {
  readonly ask: Ask;
  readonly provider: string;
  readonly detail: string;
}

/**
 * Decide which pending requests are now satisfied.
 *
 * **Presence-based, not response-based**, and three properties fall out of that
 * one choice — none of which survives if the principal's click is what closes
 * the ask:
 *
 * 1. The value posts to the credentials route and never enters the ask row, the
 *    response payload, the MCP boundary, or the transcript.
 * 2. The agent's observable is a boolean plus a status string, so there is
 *    nothing to leak downstream.
 * 3. Out-of-band satisfaction is free — an operator who prefers
 *    `config credentials add`, or who had the credential set already, closes the
 *    request with nothing to click and no second place to enter it.
 *
 * `detail` is the provider's own validation line, never the credential.
 */
export function selectSatisfiedCredentialRequests(
  pending: readonly PendingCredentialRequest[],
  presence: readonly ProviderPresence[]
): SatisfiedCredentialRequest[] {
  const configured = new Map<string, ProviderPresence>();
  for (const entry of presence) {
    if (entry.configured) configured.set(entry.provider, entry);
  }

  const satisfied: SatisfiedCredentialRequest[] = [];
  for (const { ask, provider } of pending) {
    const hit = configured.get(provider);
    if (!hit) continue;
    satisfied.push({ ask, provider, detail: hit.detail ?? "credential configured" });
  }
  return satisfied;
}
