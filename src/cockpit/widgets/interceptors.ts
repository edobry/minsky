/**
 * Interceptors widget (mt#4010 slice 1; axes added by mt#4056 slice 1b)
 *
 * Serves the interceptor catalog — one entry per declared interceptor, with its
 * stratum, description, failure classes, provenance, enumerated coverage gaps,
 * and (slice 1b) the three axes plus the computed family filters — to the
 * cockpit's `/interceptors` route.
 *
 * The data is a STATIC generated artifact (`src/generated/interceptor-catalog.json`,
 * built by `scripts/build-interceptor-catalog.ts`), imported rather than read
 * from disk: a bundled `dist/minsky.js` resolves an import correctly and a
 * runtime path relative to the source tree does not. That also makes this
 * widget dependency-free — no DB, no fire log, no filesystem — which is what
 * lets slice 1 ship without mt#4009's aggregation layer.
 *
 * ABSENT, NOT STUBBED (mt#4010 §Slicing decision). This payload deliberately
 * carries NO health state, canary badge, fire count, or cost figure — not even
 * as `null`. A stubbed field implies a value is coming and re-creates the
 * deterrent/dormant/broken conflation SC3 exists to prevent; an absent field
 * says the surface does not answer that question yet. Health and cost arrive in
 * slice 2, on `guard-health` + mt#4007's canary history + mt#4009.
 *
 * @see mt#4010 — this task
 * @see scripts/build-interceptor-catalog.ts — the generator
 * @see src/cockpit/web/hooks/useInterceptors.ts — the frontend consumer
 */
import type { WidgetModule, WidgetContext, WidgetData } from "../types";
import { describeWidgetDegradedReason } from "../db-providers";
import catalogJson from "../../generated/interceptor-catalog.json";

// ---------------------------------------------------------------------------
// Payload shape — mirrored by useInterceptors.ts on the frontend.
//
// Declared here rather than imported from `.minsky/hooks/interceptor-descriptions.ts`:
// `src/` does not import the hook tree (mt#4010 §Data-access decision), which
// is the same reason the catalog is a generated artifact at all. The generator
// is typed against the hook tree's own `CatalogEntry`, so a shape change there
// fails the generator's typecheck rather than silently skewing this view.
// ---------------------------------------------------------------------------

export type InterceptorStratum = "registry" | "standalone" | "precommit" | "retired" | "fixture";

export type InterceptorCoverageGap = "tuningOwnership" | "attentionCost" | "canary";

/**
 * Axis 1 — where in the trajectory an interceptor sits (ontology §2).
 *
 * The six events below `MessageDisplay` were added by mt#4129, additively. Hooks
 * were registered at each of them in `.claude/settings.json` while the model had
 * no value to represent them, so the point resolver dropped them and the catalog
 * carried neither the hook nor a gap — the corpus under-reported itself in a way
 * its own divergence check could not see.
 */
export type InterceptionPoint =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "UserPromptSubmit"
  | "SessionEnd"
  | "MessageDisplay"
  | "SessionStart"
  | "StopFailure"
  | "Notification"
  | "PermissionRequest"
  | "PreCompact"
  | "PostCompact"
  | "pre-commit"
  | "merge-time";

/** Axis 2 — the eight intervention types. */
export type InterventionType =
  | "deny"
  | "allow"
  | "inject"
  | "mutate"
  | "record"
  | "notify-escalate"
  | "delegate"
  | "ask-and-pause";

export type InterventionAudience = "agent" | "principal" | "operator" | "framework" | "review";

export interface Intervention {
  type: InterventionType;
  /** Omitted where the type does not take one (`deny`, `allow`, `mutate`). */
  audience?: InterventionAudience;
}

/** Axis 3 — how it decides. `structural` extends ADR-024's ladder (ontology §2). */
export type DecisionMechanism = "constant" | "structural" | "lexical" | "embedding" | "model";

/** Entity strata, dimension 2 — role on the trajectory (ontology §5). */
export type InterceptorRole = "judge" | "feeder" | "infrastructure";

/** Which coordinate a resolved entry could not establish. */
export type CoordinateGap = "point" | "interventions" | "mechanism" | "role";

/** Computed filters over axis 2, never stored kinds (ontology §4). */
export type InterceptorFamily = "guard" | "detector" | "injector";

/**
 * ONE discriminated value, never two booleans — see the generator's
 * `FamilyState` doc for why. `out-of-model` means "authored, and lands in no
 * family by construction"; `unclassified` means "coordinates were never
 * written down". A UI that renders both the same way is stating a falsehood
 * about one of them.
 */
export type InterceptorFamilyState = "classified" | "out-of-model" | "unclassified";

export interface InterceptorEntry {
  guardName: string;
  /** Null exactly when `undescribed` is true. */
  description: string | null;
  failureClasses: string[];
  provenance: string[];
  stratum: InterceptorStratum | null;
  subject: "trajectory" | "system";
  filenameNote?: string;
  note?: string;
  provenanceStatus: "implementation" | "declaration-only" | "none";
  /** Registry metadata this entity does not have — ALWAYS enumerated, never defaulted. */
  coverageGaps: InterceptorCoverageGap[];
  registered: boolean;
  /** True when no authored description exists — the explicit gap marker. */
  undescribed: boolean;
  /**
   * The implementing hook file's basename, or null when the entry has none BY
   * CONSTRUCTION (a pre-commit step, a retired or fixture name). The join key to
   * the file-keyed install provenance the detail view renders (mt#4229).
   *
   * Derived by the generator from `provenance[0]`, because neither this module
   * nor the web bundle may import `.minsky/hooks/**` to resolve it themselves —
   * see `tests/unit/hook-tree-import-boundary.test.ts`.
   */
  sourceFile: string | null;

  // --- The three axes + computed families (mt#4056 slice 1b) ---
  /** Null exactly when `coordinateGaps` contains `"point"`. */
  point: InterceptionPoint | null;
  pointSource: "registry" | "settings" | "stratum" | "authored" | "none";
  /**
   * Authored dimension-1 stratum marker (mt#4011): `"delivery"` for the merge
   * gates, null where the stratum derives from point/subject.
   */
  trajectory: "delivery" | null;
  interventions: Intervention[];
  mechanism: DecisionMechanism | null;
  role: InterceptorRole | null;
  coordinateGaps: CoordinateGap[];
  families: InterceptorFamily[];
  familyState: InterceptorFamilyState;
  /** True for the names left unauthored BY DECISION, not by omission. */
  deliberatelyUnauthored: boolean;
}

export interface FailureClassDefinition {
  failure: string;
  question: string;
}

export interface InterceptorsPayload {
  /** Entry count — the DECLARED population. */
  population: number;
  /**
   * Names known to one declaration and not the other. Surfaced rather than
   * reconciled: disagreement between the oracle and the descriptions is a
   * finding, not noise.
   */
  divergence: {
    declaredButNotDescribed: string[];
    describedButNotDeclared: string[];
  };
  failureClasses: Record<string, FailureClassDefinition>;
  entries: InterceptorEntry[];
}

/**
 * Validate the imported artifact at the boundary rather than asserting through
 * it.
 *
 * `resolveJsonModule` infers a structural type from the artifact's current
 * CONTENTS — literal unions over the strata that happen to appear today, and
 * `string` where the generator guarantees a union — so a cast would be a claim
 * about a file this module does not own. The generated artifact is normally
 * exactly right (pre-commit regenerates it), which is precisely why a silent
 * mismatch would be invisible: a truncated or hand-edited file would render as
 * a plausible-looking partial catalog.
 *
 * Throws on mismatch; `fetch` below converts that into a DEGRADED widget, so
 * the cockpit says "this is broken" instead of showing a short corpus.
 */
const VALID_STRATA: readonly string[] = [
  "registry",
  "standalone",
  "precommit",
  "retired",
  "fixture",
];

const VALID_PROVENANCE_STATUS: readonly string[] = ["implementation", "declaration-only", "none"];

/**
 * Runtime validation list for `InterceptionPoint` — a FIFTH site carrying these
 * names, and the one that rejects a catalog entry outright.
 *
 * `parseCatalog` throws on a point absent here, so this list going stale does
 * not degrade quietly: it fails the whole parse. mt#4129 added six points to the
 * type union and this list was missed; the pre-commit related-test gate caught
 * it. `tests/unit/interceptor-points.test.ts` now pins it with the rest.
 */
const VALID_POINTS: readonly string[] = [
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "SessionEnd",
  "MessageDisplay",
  "SessionStart",
  "StopFailure",
  "Notification",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "pre-commit",
  "merge-time",
];

const VALID_POINT_SOURCES: readonly string[] = [
  "registry",
  "settings",
  "stratum",
  "authored",
  "none",
];

const VALID_INTERVENTION_TYPES: readonly string[] = [
  "deny",
  "allow",
  "inject",
  "mutate",
  "record",
  "notify-escalate",
  "delegate",
  "ask-and-pause",
];

const VALID_AUDIENCES: readonly string[] = [
  "agent",
  "principal",
  "operator",
  "framework",
  "review",
];

const VALID_MECHANISMS: readonly string[] = [
  "constant",
  "structural",
  "lexical",
  "embedding",
  "model",
];

const VALID_ROLES: readonly string[] = ["judge", "feeder", "infrastructure"];

const VALID_FAMILIES: readonly string[] = ["guard", "detector", "injector"];

const VALID_FAMILY_STATES: readonly string[] = ["classified", "out-of-model", "unclassified"];

const VALID_COORDINATE_GAPS: readonly string[] = ["point", "interventions", "mechanism", "role"];

/**
 * Validate one entry's axis coordinates.
 *
 * Split out from {@link validateEntry} to keep both under a readable length;
 * the checks are the same class — closed unions the frontend switches on, plus
 * the two CONSISTENCY invariants that make the gap markers trustworthy. Those
 * two matter more than the union checks: a `point` that disagrees with its own
 * gap list, or a `familyState` that disagrees with `families`, renders as a
 * confident value derived from nothing, which is precisely the failure this
 * catalog exists to make impossible.
 */
function validateEntryCoordinates(
  e: Partial<InterceptorEntry>,
  where: (detail: string) => string
): void {
  if (e.point !== null && !VALID_POINTS.includes(e.point as string)) {
    throw new Error(where(`unknown interception point "${String(e.point)}"`));
  }
  if (!VALID_POINT_SOURCES.includes(e.pointSource as string)) {
    throw new Error(where(`unknown pointSource "${String(e.pointSource)}"`));
  }
  if (e.trajectory !== null && e.trajectory !== "delivery") {
    throw new Error(where(`unknown trajectory "${String(e.trajectory)}"`));
  }
  if (!Array.isArray(e.coordinateGaps)) {
    throw new Error(where("`coordinateGaps` is not an array"));
  }
  for (const gap of e.coordinateGaps) {
    if (!VALID_COORDINATE_GAPS.includes(gap as string)) {
      throw new Error(where(`unknown coordinate gap "${String(gap)}"`));
    }
  }
  // `point` is null EXACTLY when it is reported as a gap. A non-null point
  // alongside a "point" gap claims a resolved axis the resolver said it could
  // not establish; the reverse renders a gap marker over real data.
  if ((e.point === null) !== e.coordinateGaps.includes("point")) {
    throw new Error(where("`point` null-ness disagrees with `coordinateGaps`"));
  }

  if (!Array.isArray(e.interventions)) {
    throw new Error(where("`interventions` is not an array"));
  }
  for (const i of e.interventions) {
    if (typeof i !== "object" || i === null || !VALID_INTERVENTION_TYPES.includes(i.type)) {
      throw new Error(where(`unknown intervention type "${String(i?.type)}"`));
    }
    if (i.audience !== undefined && !VALID_AUDIENCES.includes(i.audience)) {
      throw new Error(where(`unknown intervention audience "${String(i.audience)}"`));
    }
  }

  if (e.mechanism !== null && !VALID_MECHANISMS.includes(e.mechanism as string)) {
    throw new Error(where(`unknown decision mechanism "${String(e.mechanism)}"`));
  }
  if (e.role !== null && !VALID_ROLES.includes(e.role as string)) {
    throw new Error(where(`unknown role "${String(e.role)}"`));
  }

  if (!Array.isArray(e.families)) {
    throw new Error(where("`families` is not an array"));
  }
  for (const f of e.families) {
    if (!VALID_FAMILIES.includes(f as string)) {
      throw new Error(where(`unknown family "${String(f)}"`));
    }
  }
  if (!VALID_FAMILY_STATES.includes(e.familyState as string)) {
    throw new Error(where(`unknown familyState "${String(e.familyState)}"`));
  }
  // The discriminant must agree with the data it discriminates: a
  // `classified` entry has families, and the two zero-family states do not.
  if ((e.familyState === "classified") !== e.families.length > 0) {
    throw new Error(where("`familyState` disagrees with `families`"));
  }
  if ((e.familyState === "unclassified") !== e.coordinateGaps.includes("interventions")) {
    throw new Error(where("`familyState` unclassified-ness disagrees with `coordinateGaps`"));
  }

  if (typeof e.deliberatelyUnauthored !== "boolean") {
    throw new Error(where("missing `deliberatelyUnauthored`"));
  }
}

/**
 * Validate ONE row.
 *
 * The envelope check below is not sufficient on its own: an `entries` array of
 * the right LENGTH carrying malformed rows satisfies every top-level
 * assertion, and the damage then lands per-row in the UI — a missing
 * `guardName` renders a nameless row whose detail link goes nowhere, and a
 * `failureClasses` that is not an array throws inside the render instead of
 * degrading the widget. Row-level failures are the ones that read as a
 * plausible catalog, which is exactly the class this boundary exists to stop.
 *
 * Deliberately checks SHAPE, not the value domains the generator owns:
 * `stratum` and `provenanceStatus` are closed unions the frontend switches on,
 * so an unknown member is a real defect; `description` and the notes are free
 * text and are only type-checked.
 */
function validateEntry(entry: unknown, index: number): InterceptorEntry {
  const where = (detail: string): string =>
    `interceptor catalog entry ${index} (${
      typeof (entry as { guardName?: unknown })?.guardName === "string"
        ? (entry as { guardName: string }).guardName
        : "unnamed"
    }): ${detail}`;

  if (typeof entry !== "object" || entry === null) {
    throw new Error(`interceptor catalog entry ${index} is not an object`);
  }
  const e = entry as Partial<InterceptorEntry>;

  if (typeof e.guardName !== "string" || e.guardName === "") {
    throw new Error(where("missing `guardName`"));
  }
  if (e.description !== null && typeof e.description !== "string") {
    throw new Error(where("`description` is neither a string nor null"));
  }
  if (typeof e.undescribed !== "boolean") {
    throw new Error(where("missing `undescribed`"));
  }
  // The invariant the catalog's honesty rests on: `description` is null
  // EXACTLY when the entry is undescribed. A described row with a null
  // description would render as a blank cell — the absence-vs-declaration
  // conflation this surface exists to prevent.
  if ((e.description === null) !== e.undescribed) {
    throw new Error(where("`description` null-ness disagrees with `undescribed`"));
  }
  if (!Array.isArray(e.failureClasses) || e.failureClasses.some((c) => typeof c !== "string")) {
    throw new Error(where("`failureClasses` is not an array of strings"));
  }
  if (!Array.isArray(e.provenance) || e.provenance.some((p) => typeof p !== "string")) {
    throw new Error(where("`provenance` is not an array of strings"));
  }
  if (!Array.isArray(e.coverageGaps) || e.coverageGaps.some((g) => typeof g !== "string")) {
    throw new Error(where("`coverageGaps` is not an array of strings"));
  }
  if (typeof e.registered !== "boolean") {
    throw new Error(where("missing `registered`"));
  }
  // Validated rather than trusted, for the same reason as the fields above: a
  // silently-absent `sourceFile` would render every entry's install provenance
  // as "unknown" — indistinguishable from a hook that genuinely has none.
  if (e.sourceFile !== null && typeof e.sourceFile !== "string") {
    throw new Error(where("`sourceFile` is neither a string nor null"));
  }

  if (e.stratum !== null && !VALID_STRATA.includes(e.stratum as string)) {
    throw new Error(where(`unknown stratum "${String(e.stratum)}"`));
  }
  if (e.subject !== "trajectory" && e.subject !== "system") {
    throw new Error(where(`unknown subject "${String(e.subject)}"`));
  }
  if (!VALID_PROVENANCE_STATUS.includes(e.provenanceStatus as string)) {
    throw new Error(where(`unknown provenanceStatus "${String(e.provenanceStatus)}"`));
  }
  // The invariant the join's honesty rests on, and the one the generator got
  // wrong first (PR #3087 R1): only an entry whose provenance points at an
  // IMPLEMENTATION may name a source file. A `declaration-only` entry's first
  // pointer is the oracle that declares it — a real path under `.minsky/hooks/`
  // — so a prefix test alone derives the oracle's own basename and the detail
  // view then renders that file's install date as the entry's.
  //
  // Ordered AFTER the status check above, deliberately: this constrains
  // `sourceFile` USING `provenanceStatus`, so validating the status first is
  // what keeps a bad status reported as a bad status. Placed before it, this
  // check shadowed the status error for any row carrying both problems — caught
  // by the pre-commit related-test gate, not by review.
  if (e.provenanceStatus !== "implementation" && e.sourceFile !== null) {
    throw new Error(
      where(
        `\`sourceFile\` is "${String(e.sourceFile)}" on a ${String(
          e.provenanceStatus
        )} entry — only an implementation-backed entry may name a source file`
      )
    );
  }

  validateEntryCoordinates(e, where);

  return e as InterceptorEntry;
}

export function parseCatalog(raw: unknown): InterceptorsPayload {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("interceptor catalog is not an object");
  }
  const c = raw as Partial<InterceptorsPayload>;
  if (!Array.isArray(c.entries)) {
    throw new Error("interceptor catalog has no `entries` array");
  }
  // `population` is DERIVED below, never read from the file (mt#4208).
  //
  // It used to be stored beside `entries` and checked for equality here, and
  // that check broke main twice — 133-vs-134 on 2026-08-17, 139-vs-140 on
  // 2026-08-20. Neither was an authoring mistake. Two branches each append an
  // entry and each bump the count; git unions the `entries` array (the
  // additions sit at different offsets) and resolves the single `population`
  // line without a conflict, because both sides wrote the same number. The
  // result is a file that was individually consistent on every branch and
  // inconsistent after the merge — and the regen hook keys on SOURCE changes,
  // so it does not re-fire on the merge commit that breaks the invariant.
  //
  // A stored duplicate of a derivable value cannot be merged correctly by a
  // line-based merge. Deriving it removes the class rather than the symptom:
  // there is no longer a second copy for a merge to disagree with.
  //
  // The field stays on the returned payload because it has a real consumer —
  // `InterceptorsPage.tsx` renders it as "N declared" — so this changes where
  // the number comes from, not whether callers can read it.
  if (typeof c.failureClasses !== "object" || c.failureClasses === null) {
    throw new Error("interceptor catalog has no `failureClasses` map");
  }
  if (
    typeof c.divergence !== "object" ||
    c.divergence === null ||
    !Array.isArray(c.divergence.declaredButNotDescribed) ||
    !Array.isArray(c.divergence.describedButNotDeclared)
  ) {
    throw new Error("interceptor catalog has no `divergence` report");
  }
  const entries = c.entries.map(validateEntry);
  return {
    // Derived from the array it counts, so the two cannot disagree (mt#4208).
    population: entries.length,
    divergence: c.divergence,
    failureClasses: c.failureClasses,
    entries,
  };
}

export const interceptorsWidget: WidgetModule = {
  id: "interceptors",
  title: "Interceptors",
  // The artifact only changes when the repo does — a commit regenerates it and
  // a cockpit restart picks it up. Polling exists so a long-lived board is not
  // pinned to boot-time data; there is nothing cheaper to poll than a
  // module-level constant.
  updateMode: { type: "polling", intervalMs: 15 * 60_000 },
  async fetch(_ctx: WidgetContext): Promise<WidgetData> {
    try {
      return { state: "ok", payload: parseCatalog(catalogJson) };
    } catch (err) {
      return { state: "degraded", reason: describeWidgetDegradedReason("interceptors", err) };
    }
  },
};
