/**
 * Interceptors widget (mt#4010 slice 1)
 *
 * Serves the interceptor catalog — one entry per declared interceptor, with its
 * stratum, description, failure classes, provenance and enumerated coverage
 * gaps — to the cockpit's `/interceptors` route.
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
  if (e.stratum !== null && !VALID_STRATA.includes(e.stratum as string)) {
    throw new Error(where(`unknown stratum "${String(e.stratum)}"`));
  }
  if (e.subject !== "trajectory" && e.subject !== "system") {
    throw new Error(where(`unknown subject "${String(e.subject)}"`));
  }
  if (!VALID_PROVENANCE_STATUS.includes(e.provenanceStatus as string)) {
    throw new Error(where(`unknown provenanceStatus "${String(e.provenanceStatus)}"`));
  }

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
  if (typeof c.population !== "number" || c.population !== c.entries.length) {
    throw new Error(
      `interceptor catalog population (${String(c.population)}) does not match its ${c.entries.length} entries`
    );
  }
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
  return {
    population: c.population,
    divergence: c.divergence,
    failureClasses: c.failureClasses,
    entries: c.entries.map(validateEntry),
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
