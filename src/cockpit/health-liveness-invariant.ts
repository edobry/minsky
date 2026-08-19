/**
 * The `/api/health` liveness-dating invariant, stated once as a rule (mt#4186).
 *
 * **A subsystem sub-object that can assert an operational/healthy state must also
 * carry a field that dates that assertion.** Without one, "ok, just measured" and a
 * stale "ok" written at boot are the same reading — which is the defect `db` learned
 * in mt#3563, `dbHealth` learned in mt#3826, and `principalChannel` learned in
 * mt#4183, each independently, with nothing carrying it forward to the next field
 * anyone adds. This module is what carries it forward.
 *
 * **Keyed on SHAPE, never on a list of today's field names.** An allowlist of known
 * sub-objects would exempt the next one by omission, which is the whole failure mode.
 * A sub-object is examined because of the shape it has, so a field nobody has written
 * yet is covered the day it appears.
 *
 * **Both affirmative forms are covered, and that is deliberate (mt#4186).** Keying only
 * on a `state`/`mode`/`status` discriminator would have been the same
 * exempt-by-omission failure one level up — allowlisting a *syntactic form* rather than
 * a field name. `transcriptWatcher` asserts liveness as `running: true`, a boolean, and
 * a discriminator-only rule would never have looked at it. It is dated today, so this
 * is a hole rather than a live miss; holes are cheapest to close before something falls
 * in.
 *
 * **Canonical name for NEW fields: `lastAttemptAt` (mt#4186 SC4).** The payload currently
 * spells the same idea four ways — `checkedAt` (mt#3563), `lastAttemptAt` (mt#3826, and
 * ADR-035 rule 4's own table), `lastSuccessAt`/`lastAttemptAt` (the sweep registry), and
 * `since`/`lastProgressAt` (mt#4183). ADR-035 rule 4 is the tiebreaker, so a subsystem
 * ADDING a dating field should use `lastAttemptAt` unless it means something genuinely
 * different (`since` means "written once at launch", which `lastAttemptAt` would misstate).
 * **Shipped names are deliberately NOT renamed** — the tray reads several of them via
 * `rustConsumedFields`, and this check accepts any `*At` field precisely so convergence can
 * happen by attrition instead of by a breaking rename.
 *
 * Relationship to ADR-035: this is the BUILD-TIME half of rule 4. ADR-035 names a
 * RUNTIME detector as its preferred mechanization ("any subsystem reporting
 * `unavailable` for longer than N with no `lastAttemptAt` since boot") and defers it —
 * *"Not authorized here; file it when the shape has landed in more than one
 * subsystem."* A runtime detector gated on `lastAttemptAt` cannot fire on a subsystem
 * that has no such field at all, which is exactly the mt#4183 case; enforcing the shape
 * is what makes that detector reachable.
 *
 * @see docs/architecture/adr-035-failed-initializer-must-not-be-memoized-as-a-value.md
 * @see contract/cockpit-health-shape.json
 */

/**
 * Discriminator keys whose STRING value can assert liveness.
 *
 * Closed on purpose: these three are the vocabulary the payload actually uses
 * (`principalChannel.state`, `dbHealth.mode`). A fourth spelling should be added here
 * rather than silently tolerated.
 */
const DISCRIMINATOR_KEYS = ["state", "mode", "status"] as const;

/**
 * Discriminator VALUES that assert an operational state.
 *
 * Only affirmative readings count. `retrying`, `failed`, `unconfigured`, `disabled`,
 * `unavailable`, `starting` and friends are all either faults or healthy-quiet states —
 * neither is a claim that the subsystem is currently working, so neither needs dating
 * to be honest.
 */
const AFFIRMATIVE_VALUES = ["running", "ok", "connected", "healthy", "active", "live"];

/**
 * Keys whose BOOLEAN `true` asserts liveness.
 *
 * Closed and short on purpose. "Any boolean" would drag in unrelated flags — a
 * `hasPendingWork: true` is not a liveness claim and must not demand a timestamp.
 *
 * **`enabled` is deliberately NOT here (PR #3080 R1).** It describes CONFIGURATION, not
 * operation: a subsystem can be enabled and dead, which is this task's entire failure
 * mode rather than an instance of health. Treating it as a liveness assertion would
 * demand a timestamp from a config flag while saying nothing about whether the thing
 * runs. The three that remain are verdicts about current operation.
 */
const BOOLEAN_LIVENESS_KEYS = ["running", "healthy", "ok"];

/**
 * Non-`At` field names that nonetheless date an assertion.
 *
 * The repo's convention is a trailing `At` (`checkedAt`, `lastAttemptAt`,
 * `lastSuccessAt`, `lastProgressAt`, `lastIngestAt`, `lastRecycleAt`, `lastAt`), so
 * the suffix test carries almost everything. `since` is the documented exception —
 * mt#4183 chose it for `principalChannel` to mean "written once at launch", which is a
 * different claim from "last attempted" and reads wrong with an `At` name.
 */
const EXTRA_DATING_KEYS = ["since"];

/**
 * Top-level fields exempt from the invariant, each with the reason it asserts no
 * datable runtime state. SC1 requires these be enumerated in ONE reviewable place
 * rather than discovered per-field; this is that place.
 *
 * Note this list is a backstop, not the primary mechanism — every entry below is
 * ALREADY out of scope because it is not an object, or carries no liveness assertion.
 * It is written down so a reader can see the judgment was made rather than missed.
 */
/**
 * **Monotonic counters: decided, and they need no exemption entry (mt#4186 SC1).**
 *
 * SC1 asks explicitly whether a counter whose RISE is the signal — `survivedExceptions`,
 * `dbRecycle` — should be exempt. **Neither is exempted, because neither is in scope in
 * the first place:** they carry no `state`/`mode`/`status` discriminator and no boolean
 * liveness key, so {@link findLivenessAssertion} returns `null` and the check never asks
 * them for a timestamp. Listing them below would be misleading — it would imply they
 * make a liveness claim that is being forgiven.
 *
 * Both carry a dating field anyway (`survivedExceptions.lastAt`,
 * `dbRecycle.lastRecycleAt`), so if either ever GAINS a liveness discriminator it passes
 * on the day it does, with no change here. That is the intended behaviour: scope is
 * decided by shape, continuously, not by a list somebody has to remember to revisit.
 */
export const DECLARED_EXEMPTIONS: Record<string, string> = {
  status:
    "Top-level HTTP-liveness discriminator, not a subsystem. The response as a whole is dated by processStartedAtMs.",
  service: "Identity field (mt#3148) — asserts which application answered, not a runtime state.",
  version: "Build identity — asserts no runtime state.",
  commit: "Build identity — asserts no runtime state.",
  processStartedAtMs: "Itself a timestamp; dating it would be circular.",
  uptimeSec: "Itself a duration reading; same as above.",
  db: "A bare string, not a sub-object. Its dating field is the sibling dbCheck.checkedAt (mt#3563).",
  consecutiveDegraded: "A counter whose RISE is the signal; a zero is not a liveness claim.",
};

/** One sub-object that asserts liveness with nothing to date it. */
export interface UndatedLivenessAssertion {
  /** The top-level field name on the payload. */
  field: string;
  /** The assertion that triggered the check, rendered for the failure message. */
  assertion: string;
}

/**
 * True when `key` names a field that dates an assertion.
 *
 * The `Ms` suffix is accepted (PR #3080 R1) because the payload already spells epoch
 * stamps that way — `processStartedAtMs` is the in-tree precedent — and a subsystem
 * adding `lastAttemptAtMs` is dating its claim exactly as well as one adding
 * `lastAttemptAt`. Rejecting it would have failed an honest subsystem for its choice of
 * units, which is the opposite of what this rule is for.
 */
function isDatingKey(key: string): boolean {
  return /At(Ms)?$/.test(key) || EXTRA_DATING_KEYS.includes(key);
}

/**
 * True when the value is usable as a date stamp — an ISO string, or `null` meaning
 * "nothing to report yet".
 *
 * `null` COUNTS. A field that is present-but-null still lets a reader distinguish
 * "never reported" from "reported at T", which is the whole point; requiring a
 * non-null would fail every subsystem during its first seconds of life.
 *
 * A finite NUMBER counts too (PR #3080 R1) — an epoch-ms stamp dates an assertion as
 * well as an ISO string does, and `processStartedAtMs` shows the payload already uses
 * that spelling. Non-finite values (`NaN`, `Infinity`) are rejected: they date nothing,
 * and accepting them would let a broken computation satisfy the rule.
 */
function isDatingValue(value: unknown): boolean {
  if (value === null || typeof value === "string") return true;
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Find the liveness assertion a sub-object makes, if any.
 *
 * Returns a rendered description of the assertion, or `null` when the sub-object makes
 * no affirmative liveness claim and therefore owes no timestamp.
 */
function findLivenessAssertion(subObject: Record<string, unknown>): string | null {
  for (const key of DISCRIMINATOR_KEYS) {
    const value = subObject[key];
    if (typeof value === "string" && AFFIRMATIVE_VALUES.includes(value)) {
      return `${key}="${value}"`;
    }
  }
  for (const key of BOOLEAN_LIVENESS_KEYS) {
    if (subObject[key] === true) {
      return `${key}=true`;
    }
  }
  return null;
}

/**
 * The full audit: which sub-objects asserted liveness, split by whether they carry a
 * field dating the claim.
 *
 * **`dated` exists so a caller can prove the check was not VACUOUS.** An empty `undated`
 * is the passing state, but on its own it is also what a check that examined NOTHING
 * returns — and against a payload whose subsystems all happen to sit in a quiet state,
 * that is exactly what would happen. A probe that returns the same answer whether or not
 * the system is broken carries no information (mem#704), so the live-payload test asserts
 * `dated` is non-empty as well: something was actually inspected and found honest.
 *
 * Pure: takes the payload, returns findings — no IO, no module state, so a fixture and a
 * live response are checked by identical code (mt#3632's testable-design shape).
 */
export function auditLivenessAssertions(payload: Record<string, unknown>): {
  undated: UndatedLivenessAssertion[];
  dated: UndatedLivenessAssertion[];
} {
  const undated: UndatedLivenessAssertion[] = [];
  const dated: UndatedLivenessAssertion[] = [];

  for (const [field, value] of Object.entries(payload)) {
    if (field in DECLARED_EXEMPTIONS) continue;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;

    const subObject = value as Record<string, unknown>;
    const assertion = findLivenessAssertion(subObject);
    if (assertion === null) continue;

    const isDated = Object.entries(subObject).some(
      ([key, keyValue]) => isDatingKey(key) && isDatingValue(keyValue)
    );
    (isDated ? dated : undated).push({ field, assertion });
  }

  return { undated, dated };
}

/**
 * Every sub-object on the payload that asserts liveness with no field dating it.
 *
 * An empty array is the passing state. See {@link auditLivenessAssertions} for why a
 * live-payload caller should ALSO assert on the `dated` half rather than this alone.
 */
export function findUndatedLivenessAssertions(
  payload: Record<string, unknown>
): UndatedLivenessAssertion[] {
  return auditLivenessAssertions(payload).undated;
}

/** Render findings for a test failure message that names what to fix. */
export function describeUndatedLivenessAssertions(
  findings: readonly UndatedLivenessAssertion[]
): string {
  return findings
    .map(
      (f) =>
        `\`${f.field}\` asserts ${f.assertion} but carries no field dating it ` +
        `(expected a \`*At\` field, or one of: ${EXTRA_DATING_KEYS.join(", ")})`
    )
    .join("\n");
}
