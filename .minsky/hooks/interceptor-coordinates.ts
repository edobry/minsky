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
  // Added by mt#4129 — hooks were registered at each of these in
  // `.claude/settings.json` while the model had no value for them, so
  // `derivePoint`'s `POINTS` gate dropped them and the catalog carried neither
  // the hook nor a gap. One of THREE copies of this union; see the header on
  // `src/cockpit/web/hooks/useInterceptors.ts` for why the duplication is forced
  // and which test pins the three together.
  | "SessionStart"
  | "StopFailure"
  | "Notification"
  | "PermissionRequest"
  | "PreCompact"
  | "PostCompact"
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
  /**
   * Entity-strata DIMENSION 1 (ontology §5) — authored ONLY where it is not
   * derivable. Every other stratum derives: a harness-event point is the agent
   * conversation, `pre-commit` is repo/VCS, `subject: "system"` is the
   * interception system itself. The one underivable case is `"delivery"`: the
   * merge gates' SUBJECT is the delivery trajectory while their declared point
   * stays `PreToolUse` (mechanism truth — mechanism decides who is bound), so
   * nothing in a declared source separates them from the other PreToolUse
   * denials. mt#4011's lifecycle spine places them at the merge station from
   * this field; the `point` field is deliberately NOT re-authored to
   * `merge-time` for them, which would overwrite mechanism truth with subject
   * truth.
   */
  readonly trajectory?: "delivery";
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
};

// ---------------------------------------------------------------------------
// The authored coordinates
// ---------------------------------------------------------------------------

const deny: Intervention = { type: "deny" };
// Re-added 2026-08-17 (mt#4198) on the terms the removal note set: `allow` lost
// its last author when `policy-coverage` was retired (mt#4197), and
// `ask-permission-bridge` declares one — it emits `permissionDecision: "allow"`
// for a command covered by a verified operator-approved ask.
const allow: Intervention = { type: "allow" };
const mutate: Intervention = { type: "mutate" };
const injectAgent: Intervention = { type: "inject", audience: "agent" };
const recordReview: Intervention = { type: "record", audience: "review" };
const recordFramework: Intervention = { type: "record", audience: "framework" };
const recordOperator: Intervention = { type: "record", audience: "operator" };
/** The three ADR-028 dispatcher entrypoints: they run other guards, not a check. */
const delegate: Intervention = { type: "delegate" };

/** A deny gate deciding on structured state — the corpus's most common shape. */
const structuralGate: InterceptorCoordinates = {
  interventions: [deny],
  mechanism: "structural",
  role: "judge",
};

/**
 * A structural deny gate whose SUBJECT is the delivery trajectory — the merge
 * gates. Same shape as `structuralGate` plus the one authored stratum marker;
 * see the `trajectory` field doc for why the point is not re-authored instead.
 */
const deliveryGate: InterceptorCoordinates = {
  ...structuralGate,
  trajectory: "delivery",
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
    "truncated-outcome-read",
    {
      interventions: [recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Same quote-aware command-string split as `chained-verification-commands`, on a different axis: that one asks whether a non-zero exit is attributable, this one whether the OUTCOME FIELDS survived the pipeline. The decision is a set membership on the pipeline's first-stage leading command and on each later stage's leading token — no prose, no paraphrase. A heredoc body containing the shape cannot fire, because the first stage's command is `cat`.",
    },
  ],
  [
    "nonexistent-search-path",
    {
      interventions: [recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Same quote-aware command-string split as its siblings, and the closest kin is `check-guessed-session-path` rather than the other recorders: both extract paths and decide with an `existsSync`. Two differences make it a separate coordinate. It extracts by ARGUMENT POSITION — walking each search binary's own grammar to tell a path from a pattern, a flag, and a `--include` filter value — where the session-path gate matches a literal substring anywhere in the command. And it records rather than denies, because that grammar walk is the false-positive surface, and its precision is a claim the calibration log has to settle. No prose and no paraphrase axis in either leg; the only judgment is which tokens are paths.",
    },
  ],
  [
    "cli-mcp-substitution",
    {
      interventions: [recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Third guard on the same quote-aware command-string split, and the first whose decision is not about the command alone: it pairs a lookup against a GENERATED oracle (`commandId` on each CLI leaf of the completion manifest) with a fact about the session (no `mcp__minsky__*` tool use in the transcript). Both legs are structural — no prose, no paraphrase axis — which is why ADR-024's ladder does not govern it. The oracle being generated is what keeps coverage from drifting as commands are added, and what keeps the hook off the domain bootstrap a registry import would owe on every Bash call.",
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
  // A numeric threshold comparison over transcript state — no prose is read, so
  // there is no paraphrase exposure to flag. Records only while log-only; when
  // it graduates, its interventions gain `injectAgent` alongside `recordReview`
  // (the silent-stretch-detector shape).
  ["context-fill-gauge", structuralRecorder],
  ["cross-turn-hedge-detector", lexicalRecorder],
  [
    "duplicate-check-search-provenance",
    { interventions: [injectAgent, recordReview], mechanism: "structural", role: "judge" },
  ],
  [
    "duplicate-check-candidate-read",
    {
      interventions: [injectAgent, recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Same session-state question as `duplicate-check-search-provenance`, one step further along: that one asks whether ANY search ran (a membership test over tool NAMES), this asks whether a SPECIFIC candidate's spec was surfaced (tool ARGUMENTS, via `specWasSurfaced`). Scoped to candidates the record NAMES, so it is defeated by omission — that axis is `duplicate-signature-scan`'s, which reaches tasks the record never mentions.",
    },
  ],
  [
    "claim-provenance-scan",
    {
      interventions: [recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Same claim shape as `duplicate-check-search-provenance`, at the spec-WRITE seam rather than only at task creation. `structural` because the discriminating half is a join against session tool-call state — a PR number against a `pull_request_read` for THAT PR, a `tasks_search` against the transcript prefix — with no paraphrase axis. `recordReview` only, like `evidence-record-provenance` and for the same measured reason: a 40-transcript replay put it at 16 fires over 70 claims with one true positive, the dominant false class being prose that DISCUSSES a collision (gate reports, reconciliations) rather than asserting one. The join is exact; the RECOGNITION half is what is unsized, and injecting on it would fire hardest at the most careful gate-(g) work. mt#4190 owns the tune and the graduation.",
    },
  ],
  [
    "criterion-reconciliation-scan",
    {
      interventions: [recordReview],
      mechanism: "lexical",
      role: "judge",
      note: "`lexical`, NOT `structural`, and the distinction is the whole design note. The CONFIRMING half is structural and exact — does this write carry the named criterion's own entry, answerable from the authored text because a marker patch leaves what it omits byte-identical. But the NOMINATING half is a fixed substring set, because the discharging action (editing the criterion) cannot be the trigger: every patch that does not touch a criterion would fire. A guard is placed on the ladder by the surface it MATCHES, and this one matches prose, so ADR-024 governs it and mt#4595's closed-vocabulary carve-out does not apply. Recall is therefore the live risk: planning measured mt#4038, one of its own recorded instances, as matching none of the set, and that miss ships as an asserted test rather than as a widened list.",
    },
  ],
  [
    "warn-unwired-task-relationship",
    {
      interventions: [recordReview],
      mechanism: "structural",
      role: "judge",
      note: "`structural` on the strength of the DISCHARGE half, which has no paraphrase axis at all: at `tasks_create` it is a field on the call (`dependsOn` / `parent`), and at the edit seams a row in `task_relationships`. That is what keeps this off ADR-024's ladder — precision is bounded by the RECOGNITION half alone, and a phrase that half misses is a false negative, i.e. the status quo. `recordReview` only, matching `claim-provenance-scan` and for the same reason: the recognition half is unsized until a replay measures it, and an advisory that fires at careful authors trains its reader to discount the fire that matters (mem#719). What makes this guard worth its budget rather than a fifth memory (mem#530 R1-R4, 84 days) is that the failure is a CONFIDENT WRONG ANSWER rather than silence — an unwired edge makes `tasks_orchestrate` report blocked work as dispatchable, so the cost rises exactly as orchestration is trusted more.",
    },
  ],
  [
    "evidence-record-provenance",
    {
      interventions: [recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Same claim shape as `duplicate-check-search-provenance`, at the commit and PR-body seams. `recordReview` only — no `injectAgent`, unlike that sibling: a pre-ship replay over 40 transcripts measured the negative-control half's fires as mostly false, so the stream is armed and nothing injects until mt#4067 tunes it.",
    },
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
  // Same shape as the sibling above: a lexical pass over the spec prose an agent
  // just authored. Class B adds an exact-substring lookup against the authorizing
  // ask, which sharpens the verdict without changing the mechanism class.
  ["spec-criterion-claim-detector", lexicalDetector],
  [
    "stale-signal-sweep",
    {
      interventions: [recordReview],
      mechanism: "lexical",
      role: "judge",
      note: "Exact substring over three corpora — active task specs, live memories, accepted ADRs — for a label lifted verbatim from the PR's own diff. No similarity metric: the token is not paraphrasable.",
    },
  ],
  [
    "unrendered-result-field-scan",
    {
      interventions: [recordReview],
      mechanism: "lexical",
      role: "judge",
      note: "Diff-only, no corpus and no DB. Positional rather than pattern-based: a field counts as rendered when its name appears in a literal OUTSIDE a logger call, which is the distinction the originating incident turned on.",
    },
  ],
  [
    "new-surface-design-pass",
    {
      interventions: [recordReview],
      mechanism: "lexical",
      role: "judge",
      note: "Joins two exact reads with no paraphrase axis: git status `A` on a render-path path, and a `Skill` tool_use name against a fixed six-skill list. Neither half is a matcher over prose, which is why it ships without ADR-024's ladder above rung 1. The transcript half is what makes it a judge rather than a diff scanner — and why an absent transcript records `skipped` rather than a fire.",
    },
  ],
  [
    "enumeration-scope-check",
    {
      interventions: [recordReview],
      mechanism: "lexical",
      role: "judge",
      note: "Joins two exact reads over the same PR window with no paraphrase axis: the session's own edit-call paths against a fixed serialized-surface list, and its search-call command strings against a fixed directory list. The strictly stronger sibling of the did-a-search-happen shape — it asks whether the sweep that RAN reached the prescribed directory, which is what every recorded gate-(h) failure missed. A subtree does not count as its directory (mt#4215), which is the discrimination that lets it see mt#4252.",
    },
  ],
  [
    "spec-scope-execution-check",
    {
      interventions: [recordReview],
      mechanism: "lexical",
      role: "judge",
      note: "Joins two exact reads with no paraphrase axis: the path list the spec's own in-scope section names, against the session's edit-call paths over the same PR window. Both sides are paths, so there is nothing to paraphrase — the judgment it stands in for is whether a CONDITIONAL enumeration line's condition fired, which is why it records rather than denies. Sibling of `enumeration-scope-check` at the same seam: that one joins sweep-call ARGUMENTS against a prescribed directory list, this one joins the SPEC'S OWN list against the diff. Parses strictly, because the shared extractor's fallback chain answers a different question (which files might collide?) and would supply paths the spec only mentions.",
    },
  ],
  [
    "coverage-claim-path-detector",
    {
      ...structuralRecorder,
      // No `trajectory` — that axis is reserved for the merge-seam
      // interceptors (pinned by `interceptors.test.ts`), and this one fires at
      // AUTHORING time, on the write that introduces the claim.
      note: "Lexical on its trigger, structural on its verdict — and the split is the point. Finding a claim is a text question (a path token, a governing phrase, inside a comment); deciding whether that claim is FALSE is not, it is a filesystem resolution against the citing file's package root. So the judgment this records never rests on prose interpretation: a fire means a named path did not resolve, which is checkable by the reviewer in one command. That is why it can ship at 95.5% measured precision where the naive path-existence form sits at ~1.8% — the conjuncts do the discriminating before the filesystem is ever consulted.",
    },
  ],
  [
    "gate-walk-provenance",
    {
      ...structuralRecorder,
      trajectory: "delivery",
      note: "The merge-seam half of the gate-(h) pair. Reads THREE indexed rows — the stream's earliest task.status_changed, the bound task's created_at, and a → READY row for that task — and asks only whether the task was ever gated, never whether it was gated well (that is enumeration-scope-check's question at `pr`). Structural rather than lexical: no prose is parsed on any path. Its `skipped` outcome is a first-class verdict, not a fallthrough — a pre-horizon task and an unreadable stream both produce one, because absence in this stream is bounded evidence about the stream and not about the gate.",
    },
  ],
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
  ["inject-ask-responses", conditionalFeeder],
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
  // mt#4769 — same coordinates as their two siblings: the same Rung-1 lexical
  // patterns, recording only. What changed is the TEXT they are pointed at, not
  // how they match or what they do about a match.
  ["operator-deferral-artifact-surface-pr", lexicalRecorder],
  ["operator-deferral-artifact-surface-spec", lexicalRecorder],
  ["pre-narration-detector", lexicalDetector],
  ["secret-request-in-chat-detector", lexicalRecorder],
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
  // Hybrid, and classified by the half that can be WRONG. The decision is
  // structural (an entity's live state contradicts the message, or it does
  // not — that half cannot false-positive), but the trigger is a prose gate,
  // so the paraphrase exposure this coordinate is meant to flag lives on the
  // lexical side. Same call as `turn-end-unescalated-incident-scan`, the
  // family's other hybrid.
  ["turn-end-stale-state-assertion-scan", lexicalRecorder],
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
  // Reads the task event ledger — a structured artifact, no phrase matching —
  // then injects. `judge` because it does classify before intervening (is any
  // of this activity not the caller's own?), even though its intervention is
  // only ever advisory: it has no deny path at all (mt#4494).
  ["warn-main-workspace-mutation", structuralInjector],
  ["warn-peer-task-activity", structuralInjector],
  ["warn-stale-forward-reference", structuralInjector],

  // -------------------------------------------------------------------------
  // Standalone stratum — registered directly in .claude/settings.json
  // -------------------------------------------------------------------------
  [
    "ask-permission-bridge",
    {
      interventions: [allow, deny],
      mechanism: "structural",
      role: "judge",
      note: "The corpus's only `allow` author: it emits the harness allow decision when a pending command matches a live grant whose ask verifies server-side as operator-approved. It DENIES on the inverse — a grant whose ask is absent, unapproved, or not operator-attributed — because that combination is a fabrication signal rather than a miss. Every unmatched path defers silently, which is why an `allow`-emitting hook is not a blanket permission widener.",
    },
  ],
  ["bare-prohibition", lexicalDetector],
  ["block-git-gh-cli", structuralGate],
  [
    "block-github-mcp-pr-writes",
    {
      interventions: [deny],
      mechanism: "structural",
      role: "judge",
      note: "Decides on the tool NAME against a fixed denial table, not on the call's content.",
    },
  ],
  ["block-nested-fork-dispatch", structuralGate],
  [
    "block-out-of-band-merge",
    {
      interventions: [deny],
      mechanism: "lexical",
      role: "judge",
      trajectory: "delivery",
      note: "Reads the PR body for a documented coupled step. Its `elideMarkdownNonProse` quotation-aware pass is the shipped pattern ADR-024 rung 1 generalizes from.",
    },
  ],
  ["block-subagent-bypass-merge", deliveryGate],
  ["block-subagent-merge-without-grant", deliveryGate],
  ["bridge-memory-retirement", structuralInjector],
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
  [
    "check-prompt-watermark",
    {
      interventions: [deny],
      mechanism: "structural",
      role: "judge",
      note: "Decides on the ABSENCE of the `minsky:prompt:v1` watermark in a prompt that also references a session path or a session-write tool. Fail-open: a malformed payload allows the dispatch.",
    },
  ],
  ["check-task-spec-read", structuralGate],
  ["deploy-verification-after-merge", structuralInjector],
  ["dispatch-intent-write-gate", structuralGate],
  [
    "dispatch-pretooluse",
    {
      interventions: [delegate],
      mechanism: "structural",
      role: "infrastructure",
      note: "Not a guard: the sole `.claude/settings.json` PreToolUse entry for every registry-migrated guard (ADR-028 D1). It reads stdin once, resolves shared context once, and runs each matched guard's pure function in process. Its own interventions are whatever its delegates emit — which is why the family filters must read the delegates, not this entry.",
    },
  ],
  [
    "dispatch-stop",
    {
      interventions: [delegate],
      mechanism: "structural",
      role: "infrastructure",
      note: "The Stop-event sibling of `dispatch-pretooluse`. `typecheck-on-stop` is a deliberately-standalone Stop entry that predates the framework and is NOT delegated through here.",
    },
  ],
  [
    "dispatch-userpromptsubmit",
    {
      interventions: [delegate],
      mechanism: "structural",
      role: "infrastructure",
      note: "The UserPromptSubmit sibling. Carries the largest delegate set — the guidance detectors plus the per-turn injectors — which is why the merged-context budget in `dispatcher.ts` is a property of THIS entrypoint rather than of any one detector.",
    },
  ],
  ["drive-pr-to-convergence", conditionalFeeder],
  ["drive-ready-to-implementation", conditionalFeeder],
  ["unowned-finding-scan", structuralRecorder],
  [
    "guard-events-ingest-on-session-end",
    {
      interventions: [recordFramework],
      mechanism: "constant",
      role: "infrastructure",
      note: "A LATENCY optimization, not a correctness layer: SessionEnd does not fire on `/exit`, `/clear`, or an async kill (ADR-017, mt#2313), so completeness comes from the cockpit's periodic sweep calling the same command. Dedupe keys make the double-run a no-op.",
    },
  ],
  [
    "inject-success-criteria",
    {
      ...conditionalFeeder,
      note: "Fires with the `session_pr_create` call ALREADY IN FLIGHT, so it cannot shape the body being submitted — it prompts a follow-up `session_pr_edit`. The merge-time coverage cross-reference is the backstop that makes that acceptable.",
    },
  ],
  [
    "linkify-message-display",
    {
      interventions: [mutate],
      mechanism: "lexical",
      role: "infrastructure",
      note: "The corpus's only `MessageDisplay` entity, and its only DISPLAY-surface mutation: it rewrites bare entity refs into deeplinks in what the operator sees while the stored transcript keeps the bare ref. Every failure path is a no-op because the client falls back to the original delta.",
    },
  ],
  [
    "loop-preflight-pr-merge-check",
    {
      interventions: [deny],
      mechanism: "structural",
      role: "judge",
      note: "Reads live PR and task state before the first `/loop` iteration. Fail-open on a partial coverage failure — an unreadable ref permits rather than blocks.",
    },
  ],
  [
    "parallel-work-guard",
    {
      interventions: [deny],
      mechanism: "structural",
      role: "judge",
      note: "Guards `session_start` AND `tasks_dispatch` in existing-task mode, because that path calls `SessionService.start()` in process and would otherwise bypass the sweep entirely. Hosts the advisory `standalone-duplicate-matcher` decision path, which has no registration of its own.",
    },
  ],
  [
    "post-merge-pull",
    {
      interventions: [mutate],
      mechanism: "constant",
      role: "infrastructure",
      note: "Mutates the MAIN working tree rather than the agent's trajectory: it stashes, fast-forwards main, and pops. The only entity here whose intervention lands on the repo checkout.",
    },
  ],
  [
    "post-merge-unasked-direction-scan",
    {
      interventions: [recordReview],
      mechanism: "model",
      role: "judge",
      note: "The corpus's ONLY `model`-mechanism entity — it builds a completion service and runs `UnaskedDirectionAnalyzer` over the merged session's transcript. mt#4038 measured `model: 0` across the fire-log population and read the rung-3 end of ADR-024's ladder as unexercised; that measurement was bounded to the population this hook is absent from, because it never fire-logs. Findings are observational and never block — the merge has already happened.",
    },
  ],
  [
    "post-session-start",
    {
      interventions: [mutate, recordFramework],
      mechanism: "structural",
      role: "infrastructure",
      note: "Labels and colors the iTerm tab for the bound task and writes the session-label state file. The mutation's audience is the operator's terminal, not the agent — the only entity in the corpus whose effect is outside both the conversation and the repo.",
    },
  ],
  [
    "record-conversation-run-state",
    {
      interventions: [recordFramework],
      mechanism: "constant",
      role: "infrastructure",
      note: "ONE script registered under every observed harness event, branching on `hook_event_name`. Fail-open is non-negotiable here (mt#3130): it is git-tracked and reaches every dispatched-subagent workspace, so a conversation whose events do not land degrades to UNKNOWN rather than failing a turn.",
    },
  ],
  [
    "record-subagent-invocation",
    {
      interventions: [recordFramework],
      mechanism: "constant",
      role: "infrastructure",
      note: "Closes the dispatch row the PreToolUse `agent-dispatch-stamp` opened, recovering the parent key from the agent transcript path.",
    },
  ],
  ["require-checks-on-bypass-merge", deliveryGate],
  [
    "require-deploy-verification-before-merge",
    {
      interventions: [deny],
      mechanism: "lexical",
      role: "judge",
      trajectory: "delivery",
      note: "Scans the PR body for a `Deploy verification:` commitment.",
    },
  ],
  [
    "require-execution-evidence-before-merge",
    {
      interventions: [deny, recordReview],
      mechanism: "lexical",
      role: "judge",
      trajectory: "delivery",
      note: "Blocks on a missing `Execution evidence:` marker and writes two calibration streams of its own (per-AT coverage, test-first evidence) — the many-to-many case the registry's list-valued `calibrationLog` exists for.",
    },
  ],
  ["require-growth-justification-before-merge", deliveryGate],
  ["require-review-before-merge", deliveryGate],
  ["require-session-for-main-workspace-edits", structuralGate],
  [
    "session-start",
    {
      interventions: [recordFramework, mutate],
      mechanism: "structural",
      role: "infrastructure",
      note: "Writes the `<harness pid> -> conversation id` mapping the MCP stdio proxy reads to attribute calls to the CURRENT conversation — without it, `/clear`, resume and fork leave the proxy stamping the pre-switch conversation onto every call, so an agent's presence claims land under a stranger's id (ADR-006 Layer 3). Also bootstraps the remote environment, but only in remote/web conversations.",
    },
  ],
  [
    "stamp-ask-conversation",
    {
      interventions: [recordFramework],
      mechanism: "structural",
      role: "infrastructure",
      note: "The ask-side twin of the two `minsky_session_links` writers below, and the same shape for the same reason: only a PostToolUse hook sees the harness conversation id and the record's own id together. It writes a LOCAL file rather than a column — the consumer is a per-turn hook that must not touch the DB (ADR-028 D7(5)), and a DB-writing hook dies silently at bootstrap (mem#672).",
    },
  ],
  [
    "stamp-pr-author-link",
    {
      interventions: [recordFramework],
      mechanism: "structural",
      role: "infrastructure",
      note: "Fires at PR-CREATE rather than merge, because the authorship-relevant conversation is the one that WROTE the code — for dispatched work an implementer subagent creates the PR and the main agent merges it.",
    },
  ],
  [
    "stamp-session-creator-link",
    {
      interventions: [recordFramework],
      mechanism: "structural",
      role: "infrastructure",
      note: "The `session_start` writer of `minsky_session_links` — the dominant creation path, which had no writer while the daemon-spawn and PR-author cases did.",
    },
  ],
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
  [
    "transcript-ingest-on-session-end",
    {
      interventions: [recordFramework],
      mechanism: "constant",
      role: "infrastructure",
      note: "The ONE ingest caller with positive evidence the conversation has terminated (the harness's own SessionEnd event), so it is the only one that may set `ended_at`. Same two-layer shape as its guard-events sibling: this is latency, the sweep is completeness.",
    },
  ],
  [
    "two-strikes-record",
    {
      interventions: [recordReview],
      mechanism: "structural",
      role: "judge",
      note: "Records every tool error and accumulates per-conversation streaks. Default mode is `observation`: it logs would-have-fired events without invoking the second-strike handler, so the corpus rule's 2-strikes discipline is still agent-enforced and this entity is its calibration source.",
    },
  ],
  [
    "typecheck-on-edit",
    {
      interventions: [injectAgent, recordFramework],
      mechanism: "structural",
      role: "infrastructure",
      note: "Two effects, and the second is why the role is infrastructure rather than judge: besides surfacing filtered errors it writes the edited-project-root state file that `typecheck-on-stop` consumes at turn end. It never blocks.",
    },
  ],
  [
    "typecheck-on-stop",
    {
      interventions: [deny],
      mechanism: "structural",
      role: "judge",
      note: "Registered on BOTH Stop and SubagentStop; exit 2 forces the turn to continue until the roots its `typecheck-on-edit` sibling recorded typecheck clean. Role is `judge` rather than the `infrastructure` mt#4129's planning pass grouped the dev-loop hooks under: it classifies (are there type errors in the tracked roots?) and then denies on the answer, which is the role vocabulary's definition of a judge. Its sibling keeps `infrastructure` because it writes the state and never intervenes.",
    },
  ],
  ["validate-task-spec", structuralGate],
  [
    "verify-subagent-model",
    {
      ...structuralInjector,
      note: "Compares the dispatched subagent's `resolvedModel` against the requested tier and surfaces a mismatch. Its subject is the interception system's own provenance rather than the trajectory: it exists because trusting the REQUEST as evidence of the OUTCOME reported an entire Sonnet investigation to the operator as frontier-tier.",
    },
  ],

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
  ["interceptor-catalog-regen", regenStep],
  ["migration-collision-check", structuralGate],
  ["migration-guard-check", structuralGate],
  ["migration-journal-check", structuralGate],
  ["node-shim-check", structuralGate],
  ["conflict-marker-check", structuralGate],
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
  [
    "sql-capability-message-check",
    {
      interventions: [deny],
      mechanism: "lexical",
      role: "judge",
      note: "Same coordinates as `variable-naming-check` and for the same reasons: it denies, it matches phrases in staged source, and the verdict is its own. mt#4398 — the check it runs (`scripts/check-sql-capability-messages.ts`, mt#3661) had no caller at all until then, so it had no coordinates either.",
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
  [
    "policy-coverage",
    {
      interventions: [deny, injectAgent, recordReview],
      mechanism: "structural",
      point: "PreToolUse",
      role: "judge",
      note: "RETIRED 2026-08-16 (mt#4197). Was ontology amendment (a)'s worked example: it selected deny, warn, or allow PER FIRE, so its declaration named a repertoire rather than an outcome. The `allow` member is dropped here because it was the corpus's only use of that constant; the repertoire's point — a capability SET rather than a primary — is unchanged and the amendment it motivated stands on its own.",
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
  /**
   * Authored dimension-1 stratum marker; null for every entity whose stratum
   * derives from its point or subject. See `InterceptorCoordinates.trajectory`.
   */
  readonly trajectory: "delivery" | null;
  readonly note?: string | undefined;
  /**
   * ALWAYS enumerated, never defaulted (SC5). A name with no authored entry
   * reports every coordinate as a gap rather than resolving to a plausible one.
   */
  readonly gaps: readonly CoordinateGap[];
}

/**
 * The representable interception points — kept in lockstep with the
 * `InterceptionPoint` union in `src/cockpit/widgets/interceptors.ts`, which
 * `interceptor-points.test.ts` pins.
 *
 * This set is a GATE, not a filter: `derivePoint` drops a settings-registered
 * event that is absent here, so a missing value renders as no point at all
 * rather than as an unrepresentable one. Six events sat outside it until
 * mt#4129 — the hooks registered at them were dropped silently.
 */
const POINTS = new Set<string>([
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
    trajectory: authored?.trajectory ?? null,
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
 * filters `mutate`, `record(framework)`, or `delegate`. Every name below is a
 * `mutate`-only regen step, a framework-state writer, or a dispatcher
 * entrypoint — precisely the "feeders and infrastructure" §5 names as the
 * entities that surfaced as falsifiers because they do not judge.
 *
 * So this is not a coverage gap to fill by widening a capability set until
 * something matches. It is the corpus reporting that three family words do not
 * partition it. Minting a fourth is a NAMING decision and therefore
 * principal-reserved; until one is made, the catalog should render these as
 * explicitly outside the family filters rather than as blanks.
 *
 * mt#4198 changed the SIZE of that finding without changing its shape: the
 * settings-registered cohort added 13, taking this class from 9 of 106 to
 * **22 of 134** — one entry in six. It also added a THIRD unfiltered
 * intervention type, `delegate`, which had no author at all until the three
 * ADR-028 dispatcher entrypoints were described. The population that was
 * missing from the catalog was disproportionately made of exactly the entities
 * the three family words do not cover, which is what made the gap look smaller
 * than it is: an operator filtering by guard / detector / injector still sees
 * nothing for one entry in six.
 *
 * Asserted as an exact set by the test suite, so a future entity joining or
 * leaving this class is a visible diff rather than a silent drift.
 */
export const OUT_OF_MODEL_NAMES: readonly string[] = [
  "auto-session-title",
  "claude-hooks-compile-regen",
  "code-formatting",
  "completion-manifest-regen",
  "dispatch-pretooluse",
  "dispatch-stop",
  "dispatch-userpromptsubmit",
  "dockerfile-bun-build-regen",
  "dockerfile-workspace-copy-regen",
  "guard-events-ingest-on-session-end",
  "interceptor-catalog-regen",
  "linkify-message-display",
  "post-merge-pull",
  "post-session-start",
  "record-agent-dispatch",
  "record-conversation-run-state",
  "record-subagent-invocation",
  "record-turn-anchor",
  "session-start",
  "stamp-ask-conversation",
  "stamp-pr-author-link",
  "stamp-session-creator-link",
  "transcript-ingest-on-session-end",
];

/** Authored names landing in no family — recomputed, for drift against the constant above. */
export function familylessAuthoredNames(): string[] {
  const out: string[] = [];
  for (const [name, coords] of INTERCEPTOR_COORDINATES) {
    if (familiesOf(coords.interventions).length === 0) out.push(name);
  }
  return out.sort();
}
