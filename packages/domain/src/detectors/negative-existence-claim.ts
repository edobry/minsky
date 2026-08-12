/**
 * Negative-existence-claim matcher — mt#3918.
 *
 * Recognizes one narrow, mechanizable slice of the
 * `assertion-without-verification` family:
 *
 *   A NEGATIVE EXISTENCE CLAIM — "X is never called", "nothing implements Y",
 *   "zero call sites" — written into a durable artifact, justified by a search
 *   that returned ZERO OR ONE hits, about a capability a task in DONE status
 *   claims to have delivered.
 *
 * All three conjuncts are machine-checkable. The matcher does NOT judge whether
 * the claim is true — an intractable question. It says: you are asserting
 * absence from a thin search, about something a shipped task delivered; read
 * that task's diff before this lands.
 *
 * ## Why this lives in the domain package rather than in the hook
 *
 * ADR-024's Decision clause requires the guidance-hook ladder be "built on the
 * shared `packages/domain/src/detectors/` framework so all guidance hooks
 * consume one mechanism instead of divergent regex copies." There is no Rung-1
 * matcher in that framework to resolve through — `embedding-nomination` is Rung
 * 2, and mt#1035's `Detector` interface models the Ask-routing surface, which no
 * guidance hook implements. So the clause is satisfied the only way it can be at
 * Rung 1: the matcher lives HERE, and `.minsky/hooks/` holds a thin adapter.
 *
 * mt#3999 reads the same surface with a narrower third conjunct and is required
 * by its own spec to consume this extraction rather than ship a second copy. A
 * hook-local matcher would have forced it to import from the hooks tree.
 *
 * ## Rung placement
 *
 * Rung 1, ADR-024's default stopping point, and on the merits rather than by
 * default: a claim-phrase match, a hit count, and a task-status lookup are all
 * deterministic. Do NOT answer a paraphrase miss by widening
 * {@link NEGATIVE_EXISTENCE_PATTERNS} — that is the arms race ADR-024's
 * `## Context` exists to end. Rung 2 (embedding nomination) is the documented
 * escalation, and it is evidence-gated: measured recurring paraphrase misses,
 * not an opening move.
 *
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 * @see .minsky/hooks/negative-existence-claim-detector.ts — the adapter
 */

/** Tool names whose result is a SEARCH whose hit count bounds a negative claim. */
export const SEARCH_TOOL_NAMES: readonly string[] = [
  "Grep",
  "Glob",
  "mcp__minsky__session_grep_search",
  "mcp__minsky__tasks_search",
  "mcp__minsky__repo_search",
  "mcp__minsky__git_search",
  "mcp__minsky__transcripts_search-text",
];

/**
 * Shell commands that make a `Bash`/`session_exec` call a search.
 *
 * Keyed on the command's FIRST token so a pipeline is classified by what
 * produced its input, matching how `chained-verification-commands` reads a
 * command string. A `| grep` filter downstream of a non-search producer is not
 * itself the search the claim rests on.
 */
export const SEARCH_COMMAND_LEADERS: readonly string[] = ["grep", "rg", "ag", "ack", "ugrep"];

/**
 * Negative-existence claim phrases.
 *
 * Deliberately SMALL. The discriminating power here is not the phrase family —
 * it is the conjunction with a thin search and a DONE task, which is already
 * suspicious independent of how the sentence is worded. A large corpus would buy
 * recall this detector does not need and precision it cannot afford.
 */
export const NEGATIVE_EXISTENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:is|are|was|were)\s+never\s+(?:called|invoked|used|referenced|read|reached)\b/i,
  /\bnothing\s+(?:calls?|invokes?|implements?|references?|reads?|uses?|consumes?)\b/i,
  /\b(?:zero|no)\s+(?:production\s+)?(?:call\s*sites?|callers?|consumers?|references?|implementors?|implementations?)\b/i,
  /\bno\s+(?:one|other\s+\w+)\s+(?:calls?|reads?|uses?|references?)\b/i,
  /\b(?:has|have)\s+no\s+(?:callers?|consumers?|references?|call\s*sites?)\b/i,
  /\bnot\s+called\s+(?:anywhere|from\s+anywhere)\b/i,
  /\bnever\s+(?:fires?|runs?|executes?)\b/i,
];

/** Task ids cited in prose, e.g. `mt#2677`. */
const TASK_REF_RE = /\bmt#(\d+)\b/gi;

/** A search call in the turn, paired with the hit count its result carried. */
export interface SearchObservation {
  toolName: string;
  /**
   * Hits the result reported, or `null` when the result's shape could not be
   * counted. A null count is NOT thin — see {@link isThinSearch}.
   */
  hitCount: number | null;
}

/** One matched negative-existence claim. */
export interface ClaimMatch {
  /** The matched text, capped so a record stays bounded. */
  phrase: string;
  /** Surrounding prose, so a reviewer can tell an assertion from a quotation. */
  excerpt: string;
}

export interface NegativeExistenceClaimInput {
  /** Prose the agent wrote INTO a durable artifact this turn, markdown already elided. */
  artifactProse: string;
  /** Search-class calls in the same turn. */
  searches: readonly SearchObservation[];
  /**
   * Which of the prose's cited task ids are DONE. `null` means the lookup could
   * not run — see {@link detectNegativeExistenceClaim} for why that FIRES.
   */
  doneTaskIds: ReadonlySet<string> | null;
}

export interface NegativeExistenceClaimResult {
  matched: boolean;
  claims: ClaimMatch[];
  /** Every `mt#N` the prose cites, whether or not it is DONE. */
  citedTaskIds: string[];
  /** The cited ids the caller resolved to DONE — the tasks whose diff to read. */
  doneTaskIds: string[];
  /** The thin searches that bound the claim. */
  thinSearches: SearchObservation[];
  /** True when conjunct 3 was admitted because the status lookup failed, not because it passed. */
  doneLookupUnavailable: boolean;
}

/** Longest phrase kept in a record; the excerpt carries the context. */
const MAX_PHRASE_CHARS = 120;

/** Characters of surrounding prose kept on each side of a matched phrase. */
const EXCERPT_CONTEXT_CHARS = 80;

/**
 * A search is THIN when it returned zero or one hits.
 *
 * A `null` count — a result shape this matcher could not count — is NOT thin.
 * The asymmetry is deliberate and runs opposite to the DONE-lookup's
 * fail-toward-firing: an uncountable result is evidence about the PARSER, and
 * treating it as thin would make every unfamiliar tool shape a fire. The
 * DONE-lookup's failure mode is different in kind — there the dependency is
 * unavailable, and going quiet would make the detector indistinguishable from a
 * dead one for as long as the database is unreachable.
 */
export function isThinSearch(search: SearchObservation): boolean {
  return search.hitCount !== null && search.hitCount <= 1;
}

/** Every distinct `mt#N` cited in `prose`, normalized to `mt#N`. */
export function extractCitedTaskIds(prose: string): string[] {
  const ids = new Set<string>();
  for (const match of prose.matchAll(TASK_REF_RE)) {
    ids.add(`mt#${match[1]}`);
  }
  return [...ids];
}

/**
 * Every negative-existence claim in `prose`, with surrounding context.
 *
 * ONE match per pattern, deliberately (PR #2905 R1 asked). The record and the
 * advisory both enumerate claims one per line, so an unbounded count is an
 * unbounded render — and the second occurrence of the SAME pattern adds no
 * information a reviewer acts on: the remedy is identical (read the DONE task's
 * diff) and the excerpt already shows where the claim sits. Bounding here is
 * what keeps `renderWorstCase()`'s claim axis posed at a real ceiling rather
 * than an arbitrary sample.
 */
export function extractNegativeExistenceClaims(prose: string): ClaimMatch[] {
  if (!prose) return [];
  const claims: ClaimMatch[] = [];
  const seen = new Set<string>();

  for (const pattern of NEGATIVE_EXISTENCE_PATTERNS) {
    const match = pattern.exec(prose);
    if (!match) continue;
    const phrase = match[0].slice(0, MAX_PHRASE_CHARS);
    if (seen.has(phrase)) continue;
    seen.add(phrase);
    const start = Math.max(0, match.index - EXCERPT_CONTEXT_CHARS);
    const end = Math.min(prose.length, match.index + match[0].length + EXCERPT_CONTEXT_CHARS);
    claims.push({ phrase, excerpt: prose.slice(start, end) });
  }

  return claims;
}

/**
 * Combine the three conjuncts.
 *
 * Fires only when ALL of: a negative-existence claim is present, at least one
 * same-turn search was thin, and the prose cites a task that is DONE.
 *
 * **Conjunct 3 fails TOWARD firing.** When `doneTaskIds` is `null` the status
 * lookup could not run, and every cited id is admitted rather than dropped. A
 * detector that goes quiet when its dependency is unavailable is
 * indistinguishable from a dead one (ADR-032), and this whole family exists
 * because silent-when-broken costs weeks to notice. The result flags the case as
 * {@link NegativeExistenceClaimResult.doneLookupUnavailable} so a calibration
 * pass can separate these from confirmed hits rather than pooling them.
 *
 * A claim citing NO task never fires, lookup available or not — there is no
 * shipped work to point the agent at, which is the whole remedy.
 */
export function detectNegativeExistenceClaim(
  input: NegativeExistenceClaimInput
): NegativeExistenceClaimResult {
  const claims = extractNegativeExistenceClaims(input.artifactProse);
  const citedTaskIds = extractCitedTaskIds(input.artifactProse);
  const thinSearches = input.searches.filter(isThinSearch);
  const known = input.doneTaskIds;
  const doneLookupUnavailable = known === null;
  const doneTaskIds = known === null ? citedTaskIds : citedTaskIds.filter((id) => known.has(id));

  const matched = claims.length > 0 && thinSearches.length > 0 && doneTaskIds.length > 0;

  return {
    matched,
    claims,
    citedTaskIds,
    doneTaskIds,
    thinSearches,
    doneLookupUnavailable,
  };
}

/**
 * Hit count for a search result body, or `null` when the shape is not countable.
 *
 * Counting is line-based because that is what every covered tool emits: `Grep`
 * and the shell searchers print one match per line, and the MCP searchers render
 * one result per line. An explicit no-matches marker short-circuits to 0 so an
 * empty result is distinguished from an unparseable one — the difference between
 * "the search found nothing" (thin, and the point of the detector) and "this
 * matcher does not understand the output" (not thin, per {@link isThinSearch}).
 */
export function countSearchHits(resultText: string): number | null {
  if (typeof resultText !== "string") return null;
  const trimmed = resultText.trim();
  if (trimmed.length === 0) return 0;
  if (/^(?:no matches found|no results|no files found|\(no matches\))\.?$/i.test(trimmed)) return 0;
  if (/\bfound 0 (?:matches|results|files)\b/i.test(trimmed)) return 0;

  const lines = trimmed.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return 0;

  // An explicit count is authoritative ONLY when it sits on the first or last
  // non-empty line — where tools print a summary. Accepting it anywhere let a
  // mid-body mention ("...the fix in mt#3 found 42 matches...") override the
  // real line count, and a body containing several would silently take the
  // first (PR #2905 R1).
  const edges = [lines[0], lines[lines.length - 1]].filter(
    (line): line is string => typeof line === "string"
  );
  for (const line of edges) {
    const countMatch = /\bfound (\d+) (?:matches|results|files)\b/i.exec(line);
    if (countMatch?.[1] !== undefined) return Number.parseInt(countMatch[1], 10);
  }

  return lines.length;
}

/** True when `toolName` (with its input `command`, for shell tools) is a search. */
export function isSearchCall(toolName: string, command: string | undefined): boolean {
  if (SEARCH_TOOL_NAMES.includes(toolName)) return true;
  if (typeof command !== "string") return false;
  const leader = command.trim().split(/\s+/)[0];
  if (leader === undefined) return false;
  const bare = leader.split("/").pop() ?? leader;
  return SEARCH_COMMAND_LEADERS.includes(bare);
}
