/**
 * Flakiness-attribution matcher — mt#3658.
 *
 * Recognizes a task spec that makes a claim about a test failure's MODE —
 * "it's flaky", "it fails under load", or the denial, "it is not
 * load-dependent, it fails deterministically" — without recording the
 * ISOLATION CONTROL that would settle it.
 *
 * The control is one command: run the file alone. It costs ~30 seconds and it
 * discriminates. A spec that skips it is routing the work toward a
 * tolerance-shaped remedy (a bigger timeout, a retry, a quarantine lane) on an
 * unchecked premise — and in every recorded incident the premise was wrong in
 * one direction or the other:
 *
 * - **mt#3557** filed three CI timeouts as flaky. Run alone they FAILED: the
 *   tests were resolving live Telegram credentials and sending real messages to
 *   the principal's channel on every full-suite run. Every tolerance-shaped fix
 *   would have preserved the live sends.
 * - **mt#3551** filed a wall-clock assertion "failing at ~5002ms against a 5s
 *   bound." That was bun's DEFAULT per-test timeout, not the assertion; the
 *   real bound is 13s and is never reached.
 * - **mt#3719** filed the DENIAL — "not load-dependent and not timing-dependent
 *   … it fails deterministically." The control falsified it four minutes later:
 *   the file passes alone (3 pass), its whole directory passes together (1533
 *   tests), and only the 802-file run fails. The cause was cross-file pollution
 *   of a module-level singleton — order-dependence, the class the spec ruled out
 *   by assertion.
 *
 * ## Why the denial fires too
 *
 * A spec asserting a failure is NOT in some class is making a causal claim about
 * failure mode exactly as much as one asserting it IS, and it is the more
 * dangerous shape: it reads as the careful, already-investigated verdict, so a
 * reader is less likely to ask for the control. mt#3719 is that case.
 *
 * ## Rung placement
 *
 * Rung 1 (deterministic), and on the merits. ADR-024's ladder governs the
 * `UserPromptSubmit` guidance-hook family, which matches trigger phrases in the
 * agent's own prose; this reads a TOOL CALL's payload, like the
 * execution-evidence merge gate. But ADR-024's Decision clause ALSO requires
 * matchers to be built on this shared framework "so all guidance hooks consume
 * one mechanism instead of divergent regex copies" — which is why the matcher
 * lives here and `.minsky/hooks/` holds a thin adapter, following the mt#3918
 * precedent rather than shipping a second self-contained regex file.
 *
 * Do NOT answer a paraphrase miss by widening the pattern lists. That is the
 * arms race ADR-024's `## Context` exists to end; Rung 2 (embedding nomination)
 * is the documented escalation and it is evidence-gated on measured recurring
 * misses.
 *
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 * @see packages/domain/src/detectors/negative-existence-claim.ts — the Rung-1 precedent
 * @see .claude/skills/create-task/SKILL.md — §2b, the authoring-side requirement
 */

/**
 * Phrases ATTRIBUTING a failure to flakiness.
 *
 * Taken from `/create-task` §2b's own trigger list, which is the text agents are
 * told to watch for — the two must stay recognizably the same vocabulary or the
 * prose and the detector are measuring different things.
 */
export const FLAKINESS_ATTRIBUTION_PATTERNS: readonly RegExp[] = [
  /\bflak(?:y|iness)\b/i,
  /\bintermittent(?:ly)?\b/i,
  /\bload[- ]?(?:dependent|sensitive)\b/i,
  /\bunder\s+(?:parallelism|contention|load)\b/i,
  /\bpasses\s+in\s+isolation\b/i,
  /\btiming[- ]?(?:dependent|sensitive)\b/i,
  /\brace[- ]?condition\b/i,
];

/**
 * Phrases DENYING a failure mode — the mt#3719 shape.
 *
 * Kept separate from the attribution list, not merged into it, because the
 * record reports which family matched: the two shapes have the same remedy but
 * a false-positive review needs to size them independently. A denial is also the
 * likelier false positive (a spec may legitimately deny a class it DID test),
 * which is exactly what the control evidence is checked for.
 */
export const FLAKINESS_DENIAL_PATTERNS: readonly RegExp[] = [
  /\bnot\s+(?:a\s+)?flak(?:e|y)\b/i,
  /\bnot\s+load[- ]?(?:dependent|sensitive)\b/i,
  /\bnot\s+timing[- ]?(?:dependent|sensitive)\b/i,
  /\bnot\s+order[- ]?dependent\b/i,
  /\bfails?\s+deterministic(?:ally)?\b/i,
  /\brules?\s+out\s+(?:a\s+)?(?:flake|flakiness|load|timing|order)\b/i,
];

/** The literal marker `/create-task` §2b accepts in place of a control. */
export const UNVERIFIED_MARKER = "UNVERIFIED";

/**
 * A test invocation, as the isolation control is actually written.
 *
 * Bun is the only runner in this repo (`CLAUDE.md`: "Always use `bun`, never
 * `node`/`npm`/`npx`"), so this deliberately does not try to cover other
 * ecosystems' runners — a match on `npm test` here would be evidence of a spec
 * describing some other project.
 */
const TEST_INVOCATION_RE = /\bbun\s+(?:run\s+)?test\b|\bbun\s+scripts\/run-tests/i;

/** Observed pass counts — `17 pass`, `0 fail`, `3 passed`, `1533 tests`. */
const PASS_COUNT_RE = /\b\d+\s+(?:pass(?:ed|ing)?|tests?\s+pass)/i;
const FAIL_COUNT_RE = /\b\d+\s+(?:fail(?:ed|ing|ures?)?)\b/i;

/** Longest matched phrase kept in a record; the excerpt carries the context. */
const MAX_PHRASE_CHARS = 120;

/** Characters of surrounding prose kept on each side of a matched phrase. */
const EXCERPT_CONTEXT_CHARS = 100;

/**
 * How close `UNVERIFIED` must sit to an attribution to excuse it.
 *
 * §2b says the marker goes "near the attribution", and the proximity is what
 * makes it meaningful: a spec that marks some OTHER claim `UNVERIFIED` three
 * sections away has not marked this one. The isolation control is checked
 * document-wide by contrast — a control that was actually run is evidence
 * wherever it is recorded, and specs routinely put run output in a dedicated
 * section well away from the sentence it settles.
 */
const MARKER_PROXIMITY_CHARS = 600;

/** One matched flakiness claim. */
export interface FlakinessClaim {
  /** The matched text, capped so a record stays bounded. */
  phrase: string;
  /** Surrounding prose, so a reviewer can tell an assertion from a quotation. */
  excerpt: string;
  /** Which family matched — an attribution, or its denial (mt#3719). */
  family: "attribution" | "denial";
  /** Offset of the match, used for the marker-proximity test. */
  index: number;
}

export interface FlakinessAttributionResult {
  matched: boolean;
  /** Every claim found, both families. */
  claims: FlakinessClaim[];
  /** True when the spec records a test invocation WITH observed counts. */
  hasIsolationControl: boolean;
  /** True when `UNVERIFIED` sits within {@link MARKER_PROXIMITY_CHARS} of a claim. */
  hasUnverifiedMarker: boolean;
  /**
   * Sizing signal for the false-positive review, NOT a trigger (mt#3658 §The
   * negated form). mt#3719's acceptance test was "with a reachable database, run
   * the file — it passes", which was already true of the UNFIXED code and so
   * could never distinguish a fix. A flakiness-class spec whose acceptance test
   * is a single-file run, when its evidence came from a full-suite run, is
   * asserting a control it did not run. Recorded so a later pass can measure how
   * common that is before deciding whether it earns its own matcher.
   */
  singleFileAcceptanceTestSuspected: boolean;
}

/** Every claim in `spec`, both families, one match per pattern. */
export function extractFlakinessClaims(spec: string): FlakinessClaim[] {
  if (!spec) return [];
  const claims: FlakinessClaim[] = [];
  const seen = new Set<string>();

  const families: ReadonlyArray<[FlakinessClaim["family"], readonly RegExp[]]> = [
    ["denial", FLAKINESS_DENIAL_PATTERNS],
    ["attribution", FLAKINESS_ATTRIBUTION_PATTERNS],
  ];

  // Denials are scanned FIRST so "not load-dependent" is recorded as a denial
  // rather than being swallowed by the attribution pattern it contains.
  for (const [family, patterns] of families) {
    for (const pattern of patterns) {
      const match = pattern.exec(spec);
      if (!match) continue;
      const phrase = match[0].slice(0, MAX_PHRASE_CHARS);
      if (seen.has(phrase.toLowerCase())) continue;
      seen.add(phrase.toLowerCase());
      const start = Math.max(0, match.index - EXCERPT_CONTEXT_CHARS);
      const end = Math.min(spec.length, match.index + match[0].length + EXCERPT_CONTEXT_CHARS);
      claims.push({ phrase, excerpt: spec.slice(start, end), family, index: match.index });
    }
  }

  return claims;
}

/**
 * Whether the spec records an isolation control: a test invocation AND at least
 * one observed count.
 *
 * Both halves are required. A bare command is a plan, not an observation — the
 * whole failure this detects is a spec that says what WOULD settle the question
 * without saying what happened when it was asked.
 */
export function hasIsolationControl(spec: string): boolean {
  if (!spec) return false;
  if (!TEST_INVOCATION_RE.test(spec)) return false;
  return PASS_COUNT_RE.test(spec) || FAIL_COUNT_RE.test(spec);
}

/** Whether `UNVERIFIED` sits near any of `claims`. */
export function hasUnverifiedMarkerNearClaim(
  spec: string,
  claims: readonly FlakinessClaim[]
): boolean {
  if (!spec || claims.length === 0) return false;
  let from = spec.indexOf(UNVERIFIED_MARKER);
  while (from !== -1) {
    for (const claim of claims) {
      if (Math.abs(claim.index - from) <= MARKER_PROXIMITY_CHARS) return true;
    }
    from = spec.indexOf(UNVERIFIED_MARKER, from + 1);
  }
  return false;
}

/**
 * Heuristic for the mt#3719 acceptance-test shape. Deliberately loose — it only
 * annotates a record that already fired, so a false reading costs a reviewer one
 * glance and never costs a fire.
 */
function suspectsSingleFileAcceptanceTest(spec: string): boolean {
  const acceptance = /##\s*Acceptance Tests?([\s\S]*?)(?=\n##\s|\s*$)/i.exec(spec);
  if (!acceptance?.[1]) return false;
  const section = acceptance[1];
  // A single-file run named in the acceptance tests, with no full-suite runner
  // anywhere in the section.
  const namesSingleFile = /\brun\s+the\s+file\b|\.test\.tsx?\b/i.test(section);
  const namesFullSuite = /run-tests-gated|full\s+suite|whole\s+suite/i.test(section);
  return namesSingleFile && !namesFullSuite;
}

/**
 * Fires when a spec makes a flakiness claim and records neither evidence shape.
 *
 * No dependency beyond the spec text, so there is no fail-open/fail-toward
 * asymmetry to reason about here — unlike the negative-existence matcher, whose
 * third conjunct needs a database.
 */
export function detectFlakinessAttribution(spec: string): FlakinessAttributionResult {
  const claims = extractFlakinessClaims(spec ?? "");
  const control = hasIsolationControl(spec ?? "");
  const marker = hasUnverifiedMarkerNearClaim(spec ?? "", claims);

  return {
    matched: claims.length > 0 && !control && !marker,
    claims,
    hasIsolationControl: control,
    hasUnverifiedMarker: marker,
    singleFileAcceptanceTestSuspected:
      claims.length > 0 && suspectsSingleFileAcceptanceTest(spec ?? ""),
  };
}
