/**
 * The App-grant request payload contract (mt#4693).
 *
 * The SECOND payload kind on the ask render-mode seam, and it follows the
 * convention `./credential-request` set rather than inventing one: a `metadata`
 * key declares the payload, and the ask surface selects a control from it.
 *
 * Lives in `shared` for the same reason its sibling does — the domain builds and
 * resolves the request, and the browser-bundled cockpit reads it off an ask to
 * pick a render mode, and the domain module is Node-reaching so the browser
 * cannot import it (`custom/no-node-import-in-cockpit-web`, mt#3239).
 *
 * **What this payload is NOT.** It carries no secret and no value of any kind.
 * The grant happens entirely on github.com — GitHub's own docs state that
 * changing an installation's repository access works ONLY for classic PATs with
 * `repo` scope, with no App-JWT or installation-token route — so there is
 * nothing for the principal to type and nothing for this payload to carry. That
 * is why the cockpit control here is status-plus-link rather than the masked
 * entry form `credential-request` needs: same seam, different control, per the
 * mt#4030 ↔ mt#4447 seam decision and mt#4693 D4.
 */

/**
 * Metadata key carrying the request payload on the ask row.
 *
 * Its own key and its own branch, sharing nothing with the credential payload —
 * the seam decision's explicit prescription for a second payload kind.
 */
export const APP_GRANT_REQUEST_METADATA_KEY = "appGrantRequest";

/** The request payload as it is persisted, and as readers get it back. */
export interface AppGrantRequestPayload {
  /** `owner/repo` the installation does not cover. */
  readonly repo: string;
  /** Which App role needs the grant — `implementer` or `reviewer`. */
  readonly role: string;
  /** Display slug of the App, e.g. `minsky-ai`. Named by the caller, never inferred. */
  readonly slug: string;
  /**
   * Deep link to that installation's settings page.
   *
   * Optional because the installation id may not be configured. Absent means the
   * surface renders without a link rather than with a guessed one — a wrong URL
   * is worse than none (mt#4695).
   */
  readonly settingsUrl?: string;
}

/**
 * **App-grant requests are NOT task-scoped, and carry no parent-release field.**
 *
 * The credential payload has `parentEntryStatus` because a credential request can
 * block a task, and the resolver has to know where to return it. This one has no
 * equivalent, deliberately: it is filed by `minsky setup` during ONBOARDING,
 * before any task exists, so there is nothing to block and nothing to release.
 *
 * An earlier draft mirrored the credential payload's field without asking whether
 * it applied — which would have left a payload field nothing ever set and a
 * release seam nothing ever called, i.e. a silent divergence from the credential
 * path that reads as an oversight rather than a decision. If a task-scoped caller
 * ever appears, it should add the field and the release seam TOGETHER, as one
 * coherent change.
 */

/**
 * The dedup identity of a request: one open ask per (repo, role).
 *
 * RFC 390937f0 fixes the escalation dedup key at `(capability, task-id)` and
 * names escalation spam as an enumerated threat. Here the capability IS
 * "coverage of `repo` by `role`", and there is no task id — onboarding is not
 * task-scoped — so the pair below is that key's shape for this resource. Without
 * it, re-running `minsky setup` on an uncovered repo files a second ask.
 */
export function appGrantRequestKey(payload: {
  readonly repo: string;
  readonly role: string;
}): string {
  // A tuple encoding, NOT `${repo}::${role}`. A separator-joined key is ambiguous
  // whenever a component can contain the separator: ("a/b", "c::d") and
  // ("a/b::c", "d") both flatten to "a/b::c::d", which would make two distinct
  // requests share one dedup identity and silently suppress the second. Today's
  // roles are a closed two-member set so the collision is unreachable — this is
  // cheap enough not to depend on that staying true, and the test that found it
  // is kept as the pin.
  return JSON.stringify([payload.repo.toLowerCase(), payload.role]);
}

/** The subset of an ask this reader needs — kept structural so both sides fit it. */
export interface AppGrantRequestMetadataCarrier {
  metadata?: Record<string, unknown> | null;
}

/**
 * Read the request payload off an ask, or `null` when it is not one.
 *
 * Defensive about shape rather than trusting the jsonb column: `metadata` is
 * free-form and a row can predate, or sit outside, this feature entirely.
 *
 * **Every field is lifted EXPLICITLY**, and this reader constructs a fresh
 * object rather than returning `raw` — so a field added to the payload above and
 * NOT added here is silently dropped, with no error and no missing-key warning,
 * just a value that reads as absent at every call site. The sibling reader
 * carries the same warning; `app-grant-request.test.ts` pins it with a
 * round-trip assertion over the full payload, so the drop fails a test instead
 * of shipping.
 */
export function readAppGrantRequest(
  ask: AppGrantRequestMetadataCarrier | null | undefined
): AppGrantRequestPayload | null {
  const raw = ask?.metadata?.[APP_GRANT_REQUEST_METADATA_KEY];
  if (!raw || typeof raw !== "object") return null;

  const repo = (raw as { repo?: unknown }).repo;
  const role = (raw as { role?: unknown }).role;
  const slug = (raw as { slug?: unknown }).slug;
  if (typeof repo !== "string" || repo.length === 0) return null;
  if (typeof role !== "string" || role.length === 0) return null;
  if (typeof slug !== "string" || slug.length === 0) return null;

  const settingsUrl = (raw as { settingsUrl?: unknown }).settingsUrl;

  return {
    repo,
    role,
    slug,
    ...(typeof settingsUrl === "string" && settingsUrl.length > 0 ? { settingsUrl } : {}),
  };
}
