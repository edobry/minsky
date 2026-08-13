// Per-interceptor COORDINATE data — mt#4038.
//
// `interceptor-descriptions.ts` (mt#4008) answers "what does this one do?" and
// "what failure does it defend against?". This module answers the other half
// the catalog needs: WHERE it sits, WHAT it may do there, HOW it decides, and
// WHAT ROLE it plays — the three axes of `docs/architecture/interceptors.md`
// §2 plus entity-strata dimension 2 (§5).
//
// ---------------------------------------------------------------------------
// WHY A SECOND SIDECAR RATHER THAN MORE FIELDS ON InterceptorDescription
// ---------------------------------------------------------------------------
//
// Measured at authoring time: `interceptor-descriptions.ts` is 1315 raw / 1079
// effective lines against this repo's `max-lines` ERROR ceiling of 1500
// (`skipBlankLines` + `skipComments`, `eslint.config.js`). Four coordinates on
// 92 entities lands within ~50 lines of that ceiling before a single note — so
// folding them in would ship a hand-maintained module one edit away from an
// error-tier lint failure.
//
// This is not a new pattern. It is the convention `interceptor-descriptions.ts`
// records for ITSELF: a dependency-free leaf per `.minsky/hooks/SPEC.md`, keyed
// by `guardName`, taking other modules' metadata as an INPUT rather than
// importing them. `resolveCatalogEntry` already joins `registryFacts` as a
// parameter; this joins as a second one.
//
// The same three exclusions apply here, for the same recorded reasons: not a DB
// table (authored content ABOUT source code, whose correctness is a property of
// a commit — ADR-027 governs runtime STATE, and this is not state), not a
// `GuardRegistration` field (`dispatcher.ts` imports the registry on every
// lifecycle event, and the thin-hooks direction (mem#960) exists to make those
// processes thinner), and never a hand-copied mirror of anything the registry
// already declares.
//
// ---------------------------------------------------------------------------
// DERIVED vs AUTHORED — the split this module maintains
// ---------------------------------------------------------------------------
//
// Axis 1 (interception point) is DERIVED, never authored, wherever a source
// declares it: `GUARD_REGISTRY.event`, `.claude/settings.json`'s registration
// for a standalone hook, or the `precommit` stratum. Authoring a copy of a
// declared value is how a mirror drifts, so `resolveCoordinates` computes it
// from inputs the caller supplies and this file stores it for nobody.
//
// Axes 2 and 3 and the role are AUTHORED, because no source declares them:
// - The registry's `effects` field speaks `GuardOutcome` FIELD NAMES, not the
//   ontology's intervention types. `EFFECT_TO_INTERVENTION` below is the one
//   place that mapping exists; it is exported so no consumer re-derives it.
// - Axis 3 and the role are declared in no source at all (measured: 0 of 92).
//
// STALENESS POSTURE — inherited from `interceptor-descriptions.ts` exactly. A
// name absent here resolves to explicit `undeclared` markers, never to a
// default. A silently-defaulted coordinate is indistinguishable from a real
// one, which is the whole failure this module exists to prevent.
//
// @see mt#4038 — this task
// @see mt#4008 — the description half, whose conventions this mirrors
// @see docs/architecture/interceptors.md — §2 axes, §3 amendments, §5 strata
// @see .minsky/hooks/interceptor-descriptions.ts — the sibling this joins to

// ---------------------------------------------------------------------------
// Axis 1 — interception point (ontology §2)
// ---------------------------------------------------------------------------

/**
 * Where in the trajectory an interceptor sits.
 *
 * The agent-runtime values are literal copies of the harness's own event names
 * — identity with the field, not convergence — so they stay verbatim.
 */
export type InterceptionPoint =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "UserPromptSubmit"
  | "SessionEnd"
  | "MessageDisplay"
  | "pre-commit"
  | "merge-time";

// ---------------------------------------------------------------------------
// Axis 2 — intervention type (ontology §2, amended by §3(a) and §3(b))
// ---------------------------------------------------------------------------

/** The eight intervention types. */
export type InterventionType =
  | "deny"
  | "allow"
  | "inject"
  | "mutate"
  | "record"
  | "notify-escalate"
  | "delegate"
  | "ask-and-pause";

/**
 * Ontology amendment (b): `inject` / `record` / `notify` take an AUDIENCE.
 *
 * `review` is the calibration sense — evidence feeding `/calibration-review`'s
 * deferred decision loop — as distinct from `framework` (state other
 * interceptors consume) and `operator` (STDERR audit diagnostics). Amendment
 * (c) exists precisely because collapsing these three under one word hid the
 * difference.
 */
export type Audience = "agent" | "principal" | "operator" | "framework" | "review";

export interface Intervention {
  readonly type: InterventionType;
  /** Omitted where the type does not take one (`deny`, `allow`, `mutate`). */
  readonly audience?: Audience;
}

// ---------------------------------------------------------------------------
// Axis 3 — decision mechanism
// ---------------------------------------------------------------------------

/**
 * HOW an interceptor decides — what classifier, if any, it contains.
 *
 * `lexical` / `embedding` / `model` are ADR-024's ladder rungs, which the
 * ontology §2 names as "exactly this axis". `constant` is its "no classifier"
 * end: the interceptor always fires.
 *
 * `structural` EXTENDS that set, and the extension is deliberate. ADR-024
 * scopes itself, in its own Context section, to "`UserPromptSubmit` guidance
 * hooks ... that detect behavioral trigger phrases in the agent's own output" —
 * a population whose rungs are all about matching PROSE. Most of this corpus is
 * not that: a migration-collision check, a status-transition validator, and a
 * required-checks merge gate each evaluate a deterministic predicate over
 * structured state. Calling those `constant` would be actively false (they do
 * not always fire) and calling them `lexical` would claim a prose matcher that
 * is not there. Neither ADR-024 nor the ontology is contradicted by naming the
 * case they do not cover; the ladder is unchanged and still governs the
 * detectors it was written for.
 */
export type DecisionMechanism = "constant" | "structural" | "lexical" | "embedding" | "model";

// ---------------------------------------------------------------------------
// Entity strata, dimension 2 — role on the trajectory (ontology §5)
// ---------------------------------------------------------------------------

/**
 * Feeders and infrastructure are exactly the entities that surfaced as
 * falsifiers in ontology §3: they do not judge, and a model built only from
 * judges mishandles them.
 */
export type Role =
  /** Classifies, then intervenes. The deny gates; the calibration-first detectors. */
  | "judge"
  /** Unconditional context provider with a trivial classifier. */
  | "feeder"
  /** Writes state or metadata other interceptors and surfaces consume. */
  | "infrastructure";

export interface InterceptorCoordinates {
  /**
   * Ontology amendment (a): the set of interventions this entity MAY produce,
   * never a single primary. An entity legitimately belongs to more than one
   * computed family, and the catalog has to render that rather than pick one.
   */
  readonly interventions: readonly [Intervention, ...Intervention[]];
  readonly mechanism: DecisionMechanism;
  readonly role: Role;
  /**
   * Interception point for an entity NO source declares — the merge-time gates
   * whose subject is the repo but whose mechanism is an agent-side PreToolUse
   * denial are derived, not authored, so this is rare. Set it only when
   * `resolveCoordinates` would otherwise report `undeclared`.
   */
  readonly point?: InterceptionPoint;
  /** Anything a catalog reader needs that the coordinates cannot carry. */
  readonly note?: string;
}

// ---------------------------------------------------------------------------
// The effect -> intervention mapping (SC2)
// ---------------------------------------------------------------------------

/**
 * `GuardOutcome` field name -> the ontology intervention it produces.
 *
 * The registry declares what a guard WRITES; the ontology names what it DOES.
 * These are different vocabularies and the translation existed nowhere, so
 * every consumer was about to invent its own. `sessionTitle` and the named
 * out-of-band writes map to `record(framework)` per ontology §3(c), which
 * splits the overloaded `record` by audience rather than minting new types.
 *
 * A declared effect absent from this map is NOT silently dropped — see
 * {@link unmappedEffects}.
 */
export const EFFECT_TO_INTERVENTION: Readonly<Record<string, Intervention>> = {
  deny: { type: "deny" },
  additionalContext: { type: "inject", audience: "agent" },
  updatedInput: { type: "mutate" },
  calibration: { type: "record", audience: "review" },
  sessionTitle: { type: "record", audience: "framework" },
  turnAnchorWrite: { type: "record", audience: "framework" },
  "execution-evidence-at-coverage": { type: "record", audience: "review" },
  "execution-evidence-test-first": { type: "record", audience: "review" },
};

/**
 * Declared effect names this map does not cover — the drift alarm for SC2.
 *
 * Takes the declared set as a PARAMETER so the check is a pure function the
 * audit script and the test suite can both run, against the live registry and
 * against a fixture respectively.
 */
export function unmappedEffects(declared: Iterable<string>): string[] {
  const missing = new Set<string>();
  for (const effect of declared) {
    if (!(effect in EFFECT_TO_INTERVENTION)) missing.add(effect);
  }
  return [...missing].sort();
}

/**
 * Names with NO authored coordinates, deliberately — the single source of truth.
 *
 * Five are fire-log TEST FIXTURES whose own descriptions say "Not an
 * interceptor". The sixth, `rationalization-review`, is declared in the oracle
 * and present in the fire log but has no source module in this repo (already
 * `provenanceStatus: "declaration-only"` from mt#4008). For both classes an
 * invented point or mechanism would be fabricated data — exactly what the
 * coverage-gap posture exists to prevent — so they resolve to explicit gaps.
 *
 * Exported so the test suite and `scripts/audit-interceptor-coordinates.ts`
 * consume ONE list. Two hand-maintained copies drift, and the first symptom of
 * that drift is a real interceptor silently exempted from coverage in one
 * surface while the other still checks it (PR #2914 R1).
 */
export const DELIBERATELY_UNAUTHORED_NAMES: readonly string[] = [
  "denier",
  "first-guard",
  "mt3612-live-rewrite",
  "overridden-guard",
  "rationalization-review",
  "second-guard",
];

/**
 * `guardName` -> the `.claude/settings.json` script basename that registers it.
 *
 * Only for the names where the two differ. A substring match happens to resolve
 * both of these, which is exactly why it is not the mechanism: the next pair
 * that merely shares a substring would resolve to the wrong event silently.
 */
export const STANDALONE_SCRIPT_ALIASES: Readonly<Record<string, string>> = {
  "bare-prohibition": "warn-bare-prohibition-dispatch",
  "policy-coverage": "policy-coverage-detector",
};

// ---------------------------------------------------------------------------
// The authored coordinates
// ---------------------------------------------------------------------------

const deny: Intervention = { type: "deny" };
const allow: Intervention = { type: "allow" };
const mutate: Intervention = { type: "mutate" };
const injectAgent: Intervention = { type: "inject", audience: "agent" };
const recordReview: Intervention = { type: "record", audience: "review" };
const recordFramework: Intervention = { type: "record", audience: "framework" };
const recordOperator: Intervention = { type: "record", audience: "operator" };

/** A deny gate deciding on structured state — the corpus's most common shape. */
const structuralGate: InterceptorCoordinates = {
  interventions: [deny],
  mechanism: "structural",
  role: "judge",
};

/** A pre-commit step that regenerates an artifact and re-stages it. */
const regenStep: InterceptorCoordinates = {
  interventions: [mutate],
  mechanism: "structural",
  role: "infrastructure",
};

/** A calibration-first detector that injects an advisory and records evidence. */
const lexicalDetector: InterceptorCoordinates = {
  interventions: [injectAgent, recordReview],
  mechanism: "lexical",
  role: "judge",
};

/** A calibration-first detector that records only — no advisory injected. */
const lexicalRecorder: InterceptorCoordinates = {
  interventions: [recordReview],
  mechanism: "lexical",
  role: "judge",
};

/** Same, deciding on structured state rather than prose. */
const structuralRecorder: InterceptorCoordinates = {
  interventions: [recordReview],
  mechanism: "structural",
  role: "judge",
};

/** An unconditional per-turn context provider. */
const constantFeeder: InterceptorCoordinates = {
  interventions: [injectAgent],
  mechanism: "constant",
  role: "feeder",
};

/** A context provider that fires only when it has something to say. */
const conditionalFeeder: InterceptorCoordinates = {
  interventions: [injectAgent],
  mechanism: "structural",
  role: "feeder",
};

/** An advisory injector that decides on structured state. */
const structuralInjector: InterceptorCoordinates = {
  interventions: [injectAgent],
  mechanism: "structural",
  role: "judge",
};

export const INTERCEPTOR_COORDINATES: ReadonlyMap<string, InterceptorCoordinates> = new Map<
  string,
  InterceptorCoordinates
>([
  // -------------------------------------------------------------------------
  // Registry stratum — GUARD_REGISTRY entries, dispatched by dispatcher.ts
  // -------------------------------------------------------------------------
  ["ask-routing-deferral-detector", lexicalDetector],
  [
    "auto-session-title",
    {
      interventions: [recordFramework],
      mechanism: "structural",
      role: "infrastructure",
      note: "Verified against the module: it tests for a label file, emits its contents as a scalar title, and deletes it. No classifier — the decision is file presence. Ontology §3(c) names it the entity the genus definition fits worst; it decides nothing about the trajectory.",
    },
  ],
  ["block-bulk-process-kill", structuralGate],
  ["block-concurrent-bulk-mutation", structuralGate],
  ["block-secret-file-read", structuralGate],
  ["build-claim-injection-detector", lexicalRecorder],
  [
    "calibration-review-cadence-detector",
    {
      interventions: [injectAgent],
      mechanism: "structural",
      role: "judge",
      note: "subject: system (ontology amendment (d)) — it classifies the health of the review loop, not the trajectory.",
    },
  ],
  ["causal-premise-detector", lexicalRecorder],
  [
    "chained-verification-commands",
    {
      interventions: [recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Quote-aware split of a command string, not a prose matcher — a `;` inside quotes cannot manufacture a fire.",
    },
  ],
  [
    "check-guessed-session-path",
    {
      ...structuralGate,
      note: "A regex appears in the module, but it EXTRACTS candidate session paths from the tool input; the decision itself is an `existsSync` on what it extracted. Mechanism is structural, not lexical — extraction is not classification, and a reader who greps for `RegExp` will otherwise think this coordinate is wrong.",
    },
  ],
  ["code-mechanism-assertion-detector", lexicalDetector],
  ["constructed-identifier-batch-detector", structuralRecorder],
  [
    "duplicate-check-search-provenance",
    { interventions: [injectAgent, recordReview], mechanism: "structural", role: "judge" },
  ],
  [
    "duplicate-signature-scan",
    {
      interventions: [recordReview],
      mechanism: "lexical",
      role: "judge",
      note: "Exact substring over task-spec text in one OR-ed query — no similarity metric. The embedding sibling is `standalone-duplicate-matcher`.",
    },
  ],
  ["flakiness-control-detector", lexicalDetector],
  [
    "guard-health-escalation-detector",
    {
      interventions: [injectAgent],
      mechanism: "structural",
      role: "judge",
      note: "subject: system (ontology amendment (d)).",
    },
  ],
  ["inject-current-time", constantFeeder],
  ["inject-dispatch-watchdog", conditionalFeeder],
  ["inject-git-state", constantFeeder],
  ["inject-memory-capture", conditionalFeeder],
  ["inject-prod-state", constantFeeder],
  ["knowledge-acquisition-detector", lexicalRecorder],
  ["mcp-daemon-staleness-detector", structuralInjector],
  [
    "memory-search",
    {
      interventions: [injectAgent],
      mechanism: "embedding",
      role: "feeder",
      note: "The corpus's embedding-rung instance: an embedding round-trip on every non-trivial prompt. ADR-024 §Context cites it as the standing proof that hooks CAN do semantic matching.",
    },
  ],
  ["negative-existence-claim-detector", lexicalRecorder],
  ["operator-deferral-ask-surface", lexicalRecorder],
  ["operator-deferral-detector", lexicalRecorder],
  ["pre-narration-detector", lexicalDetector],
  [
    "record-agent-dispatch",
    {
      interventions: [mutate, recordFramework, recordOperator],
      mechanism: "structural",
      role: "infrastructure",
      note: "Three interventions: it stamps the harness ids into the prompt (mutate), writes the pending dispatch row (record/framework), and emits operator-directed audit lines to STDERR — the third channel ontology amendment (b) added the audience parameter for.",
    },
  ],
  [
    "record-turn-anchor",
    {
      interventions: [recordFramework],
      mechanism: "constant",
      role: "infrastructure",
      note: "Ontology §3(c)'s worked example of record(framework): always returns null, and its only observable effect is a file write other interceptors consume.",
    },
  ],
  ["require-duplicate-check-record", structuralGate],
  ["retrospective-completeness-detector", structuralRecorder],
  ["retrospective-trigger-scanner", lexicalDetector],
  [
    "silent-stretch-detector",
    { interventions: [injectAgent, recordReview], mechanism: "structural", role: "judge" },
  ],
  ["skill-staleness-detector", structuralInjector],
  ["stop-at-decision-scan", structuralRecorder],
  ["substrate-bypass-detector", lexicalDetector],
  ["turn-end-bare-ref-scan", lexicalDetector],
  ["turn-end-retro-scan", lexicalDetector],
  ["turn-end-unescalated-incident-scan", lexicalDetector],
  ["turn-end-untaken-action-scan", lexicalDetector],
  [
    "turn-end-unwalked-task-scan",
    {
      interventions: [injectAgent, recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Tool-call-state-keyed rather than phrase-keyed, which is how it sees the SILENT stop its phrase-keyed siblings cannot.",
    },
  ],
  ["wall-of-text-detector", lexicalRecorder],

  // -------------------------------------------------------------------------
  // Standalone stratum — registered directly in .claude/settings.json
  // -------------------------------------------------------------------------
  ["bare-prohibition", lexicalDetector],
  ["block-git-gh-cli", structuralGate],
  ["block-nested-fork-dispatch", structuralGate],
  [
    "block-out-of-band-merge",
    {
      interventions: [deny],
      mechanism: "lexical",
      role: "judge",
      note: "Reads the PR body for a documented coupled step. Its `elideMarkdownNonProse` quotation-aware pass is the shipped pattern ADR-024 rung 1 generalizes from.",
    },
  ],
  ["block-subagent-bypass-merge", structuralGate],
  ["block-subagent-merge-without-grant", structuralGate],
  ["check-branch-fresh", structuralGate],
  [
    "check-generated-file-edit",
    {
      interventions: [deny],
      mechanism: "lexical",
      role: "judge",
      note: "Matches generated-file banner markers in the target's content.",
    },
  ],
  ["check-task-spec-read", structuralGate],
  ["dispatch-intent-write-gate", structuralGate],
  [
    "policy-coverage",
    {
      interventions: [deny, allow, injectAgent, recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Ontology amendment (a)'s worked example: it selects deny, warn, or allow PER FIRE at runtime, so its declaration names a repertoire rather than an outcome. Decides on a covered-tool set plus path predicates, not on prose.",
    },
  ],
  ["require-checks-on-bypass-merge", structuralGate],
  [
    "require-deploy-verification-before-merge",
    {
      interventions: [deny],
      mechanism: "lexical",
      role: "judge",
      note: "Scans the PR body for a `Deploy verification:` commitment.",
    },
  ],
  [
    "require-execution-evidence-before-merge",
    {
      interventions: [deny, recordReview],
      mechanism: "lexical",
      role: "judge",
      note: "Blocks on a missing `Execution evidence:` marker and writes two calibration streams of its own (per-AT coverage, test-first evidence) — the many-to-many case the registry's list-valued `calibrationLog` exists for.",
    },
  ],
  ["require-growth-justification-before-merge", structuralGate],
  ["require-review-before-merge", structuralGate],
  ["require-session-for-main-workspace-edits", structuralGate],
  [
    "standalone-duplicate-matcher",
    {
      interventions: [injectAgent],
      mechanism: "embedding",
      role: "judge",
      point: "PreToolUse",
      note: "Point is AUTHORED because no registration carries this name: it is a decision path INSIDE a registered hook, reached via `runStandaloneDuplicateGuard` from `parallel-work-guard.ts` (PreToolUse). Verified by reading the call site, not inferred from the name. The advisory embedding probe over task similarity — mem#819 measured that it cannot discriminate at the distances real duplicates sit at, which is why the deny-tier sibling `require-duplicate-check-record` checks for a RECORD instead.",
    },
  ],
  ["tasks-status-set-guard", structuralGate],
  ["validate-task-spec", structuralGate],

  // -------------------------------------------------------------------------
  // Pre-commit stratum — husky steps; bind ANY committer, agent or human
  // -------------------------------------------------------------------------
  ["adr-numbering-collision-check", structuralGate],
  ["bun-build-sync-check", structuralGate],
  ["claude-hooks-compile-regen", regenStep],
  [
    "code-formatting",
    {
      interventions: [mutate],
      mechanism: "structural",
      role: "infrastructure",
      note: "Auto-fix-and-restage, not detect-and-block — it rewrites the commit's payload rather than deciding about it.",
    },
  ],
  ["compile-check", structuralGate],
  ["completion-manifest-regen", regenStep],
  ["deploy-domain-check", structuralGate],
  ["dockerfile-bun-build-regen", regenStep],
  ["dockerfile-workspace-copy-regen", regenStep],
  ["duplicate-generated-content-check", structuralGate],
  ["eslint-rule-tests", structuralGate],
  ["eslint-validation", structuralGate],
  ["fast-related-tests", structuralGate],
  ["hook-permission-check", structuralGate],
  ["immutable-migration-check", structuralGate],
  ["migration-collision-check", structuralGate],
  ["migration-guard-check", structuralGate],
  ["migration-journal-check", structuralGate],
  ["node-shim-check", structuralGate],
  ["nul-byte-check", structuralGate],
  ["rules-compile-check", structuralGate],
  [
    "secret-scanning",
    {
      interventions: [deny],
      mechanism: "lexical",
      role: "judge",
      note: "The classifier is EXTERNAL: the step shells out to gitleaks, whose detection is pattern/entropy matching over staged content, and fails closed when gitleaks is not installed. `lexical` describes gitleaks' mechanism — this is the one entity in the corpus whose classifier does not live in this repo.",
    },
  ],
  ["type-check", structuralGate],
  ["variable-naming-check", { interventions: [deny], mechanism: "lexical", role: "judge" }],

  // -------------------------------------------------------------------------
  // Retired stratum — historical coordinates, kept so a fire-log row from
  // before the retirement still resolves rather than reading as unknown
  // -------------------------------------------------------------------------
  [
    "migration-guard-and-duplicate-content-check",
    {
      ...structuralGate,
      point: "pre-commit",
      note: "RETIRED. Split into `migration-guard-check` and `duplicate-generated-content-check`; coordinates are the combined step's, recorded for historical fire-log rows.",
    },
  ],
  [
    "unit-tests",
    {
      ...structuralGate,
      point: "pre-commit",
      note: "RETIRED. Superseded by `fast-related-tests`, which scopes the run to staged files.",
    },
  ],
]);

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Facts the CALLER reads from the declaring sources. Passing them in — rather
 * than importing `registry.ts` and `.claude/settings.json` here — is what keeps
 * this a dependency-free leaf and what makes every branch below testable
 * against a fixture.
 */
export interface CoordinateResolutionInput {
  /** `guardName` -> lifecycle event, from `GUARD_REGISTRY`. */
  readonly registryEvents: ReadonlyMap<string, string>;
  /** Script basename -> harness event, from `.claude/settings.json`. */
  readonly settingsEvents: ReadonlyMap<string, string>;
  /** `guardName` -> its `interceptor-descriptions.ts` stratum. */
  readonly strata: ReadonlyMap<string, string>;
}

/** Which coordinate a resolved entry could not establish. */
export type CoordinateGap = "point" | "interventions" | "mechanism" | "role";

export interface ResolvedCoordinates {
  readonly guardName: string;
  /** Null exactly when `gaps` contains `"point"`. */
  readonly point: InterceptionPoint | null;
  readonly interventions: readonly Intervention[];
  readonly mechanism: DecisionMechanism | null;
  readonly role: Role | null;
  /** How `point` was established, so a reader can tell derived from authored. */
  readonly pointSource: "registry" | "settings" | "stratum" | "authored" | "none";
  readonly note?: string | undefined;
  /**
   * ALWAYS enumerated, never defaulted (SC5). A name with no authored entry
   * reports every coordinate as a gap rather than resolving to a plausible one.
   */
  readonly gaps: readonly CoordinateGap[];
}

const POINTS = new Set<string>([
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "UserPromptSubmit",
  "SessionEnd",
  "MessageDisplay",
  "pre-commit",
  "merge-time",
]);

function derivePoint(
  guardName: string,
  authored: InterceptorCoordinates | undefined,
  input: CoordinateResolutionInput
): { point: InterceptionPoint | null; source: ResolvedCoordinates["pointSource"] } {
  const fromRegistry = input.registryEvents.get(guardName);
  if (fromRegistry && POINTS.has(fromRegistry)) {
    return { point: fromRegistry as InterceptionPoint, source: "registry" };
  }
  const script = STANDALONE_SCRIPT_ALIASES[guardName] ?? guardName;
  const fromSettings = input.settingsEvents.get(script);
  if (fromSettings && POINTS.has(fromSettings)) {
    return { point: fromSettings as InterceptionPoint, source: "settings" };
  }
  if (input.strata.get(guardName) === "precommit") {
    return { point: "pre-commit", source: "stratum" };
  }
  if (authored?.point) return { point: authored.point, source: "authored" };
  return { point: null, source: "none" };
}

/**
 * Resolve one `guardName`'s coordinates.
 *
 * NEVER returns undefined and never guesses. An unknown name yields nulls with
 * every coordinate enumerated in `gaps`, so a name that reaches the catalog
 * without authored coordinates renders as a gap rather than as a default.
 */
export function resolveCoordinates(
  guardName: string,
  input: CoordinateResolutionInput
): ResolvedCoordinates {
  const authored = INTERCEPTOR_COORDINATES.get(guardName);
  const { point, source } = derivePoint(guardName, authored, input);

  const gaps: CoordinateGap[] = [];
  if (point === null) gaps.push("point");
  if (!authored) gaps.push("interventions", "mechanism", "role");

  return {
    guardName,
    point,
    interventions: authored?.interventions ?? [],
    mechanism: authored?.mechanism ?? null,
    role: authored?.role ?? null,
    pointSource: source,
    note: authored?.note,
    gaps,
  };
}

/** Resolve a whole population. Order is preserved; nothing is filtered. */
export function resolveAllCoordinates(
  guardNames: readonly string[],
  input: CoordinateResolutionInput
): ResolvedCoordinates[] {
  return guardNames.map((name) => resolveCoordinates(name, input));
}

// ---------------------------------------------------------------------------
// The computed families (ontology §4)
// ---------------------------------------------------------------------------

export type Family = "guard" | "detector" | "injector";

/**
 * The family words as FILTERS over axis 2 — computed, never stored.
 *
 * Membership is not exclusive: by ontology amendment (a) `policy-coverage` is
 * both a guard and a detector, which is a property of the model rather than a
 * classification error to resolve.
 *
 * Returns an EMPTY array for an entity with no authored interventions, which a
 * caller must render as "not yet classified" rather than as "belongs to no
 * family" — the two are indistinguishable downstream unless the caller keeps
 * them apart, so check `gaps` alongside this.
 */
export function familiesOf(interventions: readonly Intervention[]): Family[] {
  const types = new Set(interventions.map((i) => i.type));
  const families: Family[] = [];
  if (types.has("deny") || types.has("allow")) families.push("guard");
  if (interventions.some((i) => i.type === "record" && i.audience === "review")) {
    families.push("detector");
  }
  if (types.has("inject")) families.push("injector");
  return families;
}

export interface FamilyClassification {
  readonly families: readonly Family[];
  /**
   * True when coordinates ARE authored and land in none of the three families.
   * This is a real state, not an error — see {@link OUT_OF_MODEL_NAMES}.
   */
  readonly outOfModel: boolean;
  /** True when no coordinates are authored at all. Never conflate with the above. */
  readonly unclassified: boolean;
}

/**
 * Classify a resolved entry into families, keeping the two zero-family cases
 * apart.
 *
 * A UI that renders both as an empty cell tells the reader "belongs to no
 * family" in one case and "we never wrote it down" in the other, which is the
 * absence-vs-declaration conflation this whole module exists to prevent.
 */
export function classifyFamilies(resolved: {
  readonly interventions: readonly Intervention[];
  readonly gaps: readonly CoordinateGap[];
}): FamilyClassification {
  const unclassified = resolved.gaps.includes("interventions");
  const families = familiesOf(resolved.interventions);
  return { families, outOfModel: !unclassified && families.length === 0, unclassified };
}

/**
 * The authored entities that land in NO computed family — a finding about the
 * ONTOLOGY, recorded rather than smoothed over.
 *
 * Ontology §4 defines exactly three family words, all filters over axis 2:
 * guard (deny/allow), detector (record for review), injector (inject). Nothing
 * filters `mutate` or `record(framework)`. Every name below is a `mutate`-only
 * regen step or a framework-state writer — precisely the "feeders and
 * infrastructure" §5 names as the entities that surfaced as falsifiers because
 * they do not judge.
 *
 * So this is not a coverage gap to fill by widening a capability set until
 * something matches. It is the corpus reporting that three family words do not
 * partition it. Minting a fourth is a NAMING decision and therefore
 * principal-reserved; until one is made, the catalog should render these as
 * explicitly outside the family filters rather than as blanks.
 *
 * Asserted as an exact set by the test suite, so a future entity joining or
 * leaving this class is a visible diff rather than a silent drift.
 */
export const OUT_OF_MODEL_NAMES: readonly string[] = [
  "auto-session-title",
  "claude-hooks-compile-regen",
  "code-formatting",
  "completion-manifest-regen",
  "dockerfile-bun-build-regen",
  "dockerfile-workspace-copy-regen",
  "record-agent-dispatch",
  "record-turn-anchor",
];

/** Authored names landing in no family — recomputed, for drift against the constant above. */
export function familylessAuthoredNames(): string[] {
  const out: string[] = [];
  for (const [name, coords] of INTERCEPTOR_COORDINATES) {
    if (familiesOf(coords.interventions).length === 0) out.push(name);
  }
  return out.sort();
}
