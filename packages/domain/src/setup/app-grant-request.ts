/**
 * Agent-initiated GitHub App grant request (mt#4693).
 *
 * Onboarding can DETECT that the Minsky App installation does not cover a
 * repository (mt#4680). Before this module, the only thing it could do with that
 * detection was print a navigation path into the setup output — a **portal**,
 * which `decision-defaults.mdc §Turnkey, not portal` names as the fallback
 * rather than the design. This makes the detection produce a durable, pollable
 * request instead of a line in a transcript nobody re-reads.
 *
 * **Why the operator must still act, and why that is not the defect.** GitHub's
 * REST docs (read 2026-08-27) state that both `PUT` and
 * `DELETE /user/installations/{id}/repositories/{id}` work ONLY for classic PATs
 * with `repo` scope, with no App-JWT or installation-token route. Expanding an
 * installation's repository access is user-authenticated by design — an App that
 * could widen its own scope would defeat the permission model. So the grant
 * happens on github.com no matter what; the defect was the ASK living in chat.
 *
 * Every function here is pure: the request is BUILT here and the satisfaction
 * decision is MADE by the shared presence-backed resolver, while the IO lives in
 * the callers — so the whole decision surface is testable with no database and
 * no network.
 *
 * @see packages/domain/src/ask/presence-backed-request.ts — the shared pattern (D4)
 * @see docs/architecture/adr-008-attention-allocation-subsystem.md — the ask entity
 */
import {
  APP_GRANT_REQUEST_METADATA_KEY,
  appGrantRequestKey,
  readAppGrantRequest,
} from "@minsky/shared/app-grant-request";
import type { AppGrantRequestPayload } from "@minsky/shared/app-grant-request";

import type { Ask, AskKind } from "../ask/types";
import { isPendingRequestState, type PresenceRequestShape } from "../ask/presence-backed-request";

export {
  APP_GRANT_REQUEST_METADATA_KEY,
  appGrantRequestKey,
  readAppGrantRequest,
  type AppGrantRequestPayload,
} from "@minsky/shared/app-grant-request";

/**
 * The kind an App-grant request is filed under.
 *
 * **`authorization.approve`, chosen against the router's ACTUAL routing rather
 * than inherited from the credential request** (mt#4693 D3). The three
 * alternatives and why each is unavailable:
 *
 * - `capability.escalate` is the semantically exact kind, and RFC 390937f0
 *   Position 3 is SATISFIED here — the signal comes from `checkAppCoverage`, a
 *   tool-layer precondition check returning a structured status, not from an
 *   agent paraphrasing a prose error. But `pickTransport` binds it to
 *   `routingTarget: "subagent"`, which routes an operator-only chore to an agent
 *   holding strictly fewer capabilities than the one that asked.
 * - `information.retrieve` binds to `retriever`, and nothing is being retrieved.
 * - `direction.decide` reaches the operator and is not policy-eligible, but
 *   there are no options to choose between; it would also pollute the
 *   direction-decision attention accounting.
 *
 * So: the kind that actually reaches a human, on a resource that genuinely IS an
 * authorization grant. **Migration trigger:** when mt#2588 (RFC Phase 2) gives
 * `capability.escalate` an operator route, move this request to that kind.
 *
 * That choice carries a known exposure — see {@link isPolicyResolved}.
 */
export const APP_GRANT_REQUEST_ASK_KIND: AskKind = "authorization.approve";

/** Inputs for {@link buildAppGrantRequestAsk}. Carries no secret-shaped field. */
export interface BuildAppGrantRequestInput {
  /** `owner/repo` the installation does not cover. */
  readonly repo: string;
  /** Which App role needs the grant. */
  readonly role: string;
  /** Display slug of the App, e.g. `minsky-ai`. */
  readonly slug: string;
  /** Deep link to the installation's settings page, when the id is configured. */
  readonly settingsUrl?: string;
  /** Task this request blocks, when there is one. */
  readonly parentTaskId?: string;
  /** The parent's status at the moment it was blocked — the caller reads it; this is pure. */
  readonly parentEntryStatus?: string;
}

/** The ask-shaped result: exactly the fields a caller passes to ask creation. */
export interface AppGrantRequestAskDraft {
  readonly kind: AskKind;
  readonly title: string;
  readonly question: string;
  readonly parentTaskId?: string;
  readonly metadata: Record<string, unknown>;
}

/**
 * Build the ask for an App-grant request.
 *
 * Pure — returns the draft rather than creating anything, so the wording and the
 * metadata shape are assertable without a repository.
 *
 * Wording notes, load-bearing rather than stylistic:
 * - **The settings URL is embedded when known.** A request that names a
 *   dashboard without linking it makes the principal go find it, which is the
 *   `portal-no-link` form-lint check (`packages/domain/src/ask/form-lint.ts`) —
 *   and it is the exact defect mt#4695 exists to fix in the CLI message. When
 *   the installation id is not configured the link is omitted rather than
 *   guessed: a wrong URL is worse than none.
 * - **It states what is blocked.** Missing coverage does not merely mean "PR
 *   creation 404s" — the reviewer bot rides the App's webhooks, so it gates the
 *   whole session → PR → review → merge loop. An operator who does not know that
 *   cannot triage it.
 * - **It says nothing is broken.** This is an operator-only chore, NOT a severity
 *   event; per `communication-contract.mdc` both halves are required for the
 *   severity marker and only one holds here, so it must not read like an incident.
 */
export function buildAppGrantRequestAsk(input: BuildAppGrantRequestInput): AppGrantRequestAskDraft {
  const { repo, role, slug, settingsUrl, parentTaskId, parentEntryStatus } = input;

  const payload: AppGrantRequestPayload = {
    repo,
    role,
    slug,
    ...(settingsUrl ? { settingsUrl } : {}),
    ...(parentTaskId && parentEntryStatus ? { parentEntryStatus } : {}),
  };

  const question = [
    `**Grant the ${slug} GitHub App access to \`${repo}\`.**`,
    "",
    `The installation does not currently cover this repository, so Minsky cannot open a pull request on it — and because the reviewer bot rides the same App's webhooks, the session → PR → review → merge loop is blocked, not just PR creation.`,
    "",
    settingsUrl
      ? `Grant it here: ${settingsUrl} — pick \`${repo}\` under Repository access, then Save.`
      : `Grant it under GitHub → Settings → Applications → Installed GitHub Apps → ${slug} → Repository access.`,
    "",
    `Nothing is broken; onboarding is waiting on this. Minsky notices the grant on its own — there is nothing to confirm here afterwards. Decline if you would rather not.`,
  ].join("\n");

  return {
    kind: APP_GRANT_REQUEST_ASK_KIND,
    title: `Grant ${slug} access to ${repo}`,
    question,
    ...(parentTaskId ? { parentTaskId } : {}),
    metadata: { [APP_GRANT_REQUEST_METADATA_KEY]: payload },
  };
}

/**
 * True when the router resolved this ask in-policy rather than routing it to a
 * human — the failure this feature must never wait on silently.
 *
 * **Identical exposure to the credential request, for the identical reason.**
 * `authorization.approve` is the SOLE member of `POLICY_ELIGIBLE_KINDS`
 * (`../ask/policy.ts`), so the one kind that reaches the operator inbox is also
 * the one kind phase-1 policy consultation can short-circuit — a path that has
 * fired repeatedly (mt#3233) on well-formed questions, so careful wording is not
 * a defense.
 *
 * Because resolution here is by COVERAGE PRESENCE, a policy close cannot produce
 * a false "satisfied" — it produces a request that never resolves at all, while
 * the row reads downstream as closed at zero operator cost. Onboarding would
 * report a grant request nobody was ever asked for.
 *
 * **Callers MUST read the ask back after creating it and surface this rather
 * than proceeding as though a human had been reached.** The clean fix — whether
 * the kind stays policy-eligible — is mt#3715.
 */
export function isPolicyResolved(ask: Pick<Ask, "routingTarget" | "response">): boolean {
  return ask.routingTarget === "policy" || ask.response?.responder === "policy";
}

/**
 * Responder recorded when a request is closed by coverage presence.
 *
 * The `system:<event>` convention: the principal satisfied this by GRANTING
 * access on github.com, not by answering the ask, so surfaces must not render it
 * as an operator response payload — and the agent side uses it to tell
 * "satisfied" from "declined", which are both `closed`.
 */
export const APP_GRANT_REQUEST_RESPONDER = "system:app-grant-granted";

/**
 * How an App-grant request maps onto the shared presence-backed request shape.
 *
 * The key is the (repo, role) pair rather than a bare string, which is why the
 * shared module is generic over its key type at all.
 */
export const APP_GRANT_REQUEST_SHAPE: PresenceRequestShape<AppGrantRequestPayload> = {
  label: "app-grant-request",
  readKey: (ask) => readAppGrantRequest(ask),
  identity: (payload) => appGrantRequestKey(payload),
  defaultDetail: "installation now covers the repository",
};

/**
 * Is this repo/role pair already covered by an OPEN request? (idempotency)
 *
 * The check onboarding runs before filing, so re-running `minsky setup` against
 * an uncovered repository does not file a second ask. RFC 390937f0 enumerates
 * escalation spam as a threat and fixes the dedup key at `(capability, task-id)`;
 * `appGrantRequestKey` is that key's shape for this resource.
 */
export function hasOpenAppGrantRequest(
  asks: readonly Ask[],
  subject: { readonly repo: string; readonly role: string }
): boolean {
  const wanted = appGrantRequestKey(subject);
  return asks.some((ask) => {
    if (!isPendingRequestState(ask.state)) return false;
    const payload = readAppGrantRequest(ask);
    return payload !== null && appGrantRequestKey(payload) === wanted;
  });
}

/** What the requesting agent observes. A status and a status LINE — never a value. */
export type AppGrantRequestStatus =
  | { status: "pending"; repo: string; role: string }
  | { status: "satisfied"; repo: string; role: string; detail: string }
  | { status: "declined"; repo: string; role: string; reason?: string }
  | { status: "unanswered"; repo: string; role: string; reason: "cancelled" | "expired" }
  /**
   * The router auto-resolved it in-policy and no human ever saw it (mt#3233).
   * Distinct from `declined` on purpose: no grant is coming, but nobody refused.
   * An agent should escalate rather than treat it as an answer.
   */
  | { status: "policy-closed"; repo: string; role: string };

/**
 * Classify an App-grant request for the agent that filed it.
 *
 * Pure, and returns `null` when the ask is not an App-grant request at all, so a
 * caller handed the wrong id gets a distinguishable answer rather than a
 * plausible-looking "pending".
 */
export function classifyAppGrantRequest(
  ask: Pick<Ask, "state" | "metadata" | "response" | "routingTarget"> | null | undefined
): AppGrantRequestStatus | null {
  if (!ask) return null;
  const payload = readAppGrantRequest(ask);
  if (!payload) return null;
  const { repo, role } = payload;

  if (isPendingRequestState(ask.state)) return { status: "pending", repo, role };

  if (ask.state === "cancelled" || ask.state === "expired") {
    return { status: "unanswered", repo, role, reason: ask.state };
  }

  const responder = ask.response?.responder;
  if (responder === APP_GRANT_REQUEST_RESPONDER) {
    const detail = (ask.response?.payload as { detail?: unknown } | undefined)?.detail;
    return {
      status: "satisfied",
      repo,
      role,
      detail: typeof detail === "string" ? detail : APP_GRANT_REQUEST_SHAPE.defaultDetail,
    };
  }

  if (responder === "policy" || ask.routingTarget === "policy") {
    return { status: "policy-closed", repo, role };
  }

  const reason = (ask.response?.payload as { reason?: unknown } | undefined)?.reason;
  return {
    status: "declined",
    repo,
    role,
    ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
  };
}
