/**
 * Coverage-claim path detection core (mt#4426).
 *
 * A comment asserts that coverage — or a convention, or a precedent — lives at a
 * path, and the thing it names does not resolve. The cost is not the broken
 * artifact: it is that **a confident pointer stops the next reader from
 * looking**. Three tasks fixed one instance each before this became a class
 * (mt#4202, mt#3994, mt#4413).
 *
 * This module is the pure detection core. It takes text plus an injected
 * existence check and returns findings; it touches no filesystem and no hook
 * plumbing, so every discrimination below is testable without patching a
 * collaborator (`testing-standards.mdc §Testable Design`).
 *
 * ## Why the naive form is a false-positive generator, measured
 *
 * "A cited `scripts/<name>.ts` that does not exist is a defect with no judgment
 * involved" was written into mt#4413's planning audit and is FALSE. Measured
 * over this repo (2026-08-22, re-measured 2026-08-26): **429 unique
 * `scripts/*.ts` paths cited in `.ts` comments, 111 of which do not resolve from
 * the repo root — and only 2 of those 111 are real.** A true-positive rate of
 * ~1.8% is not a detector, it is noise. The three false classes, and the
 * conjunct that removes each:
 *
 * 1. **Substring capture — the largest class.** `transcripts/` CONTAINS
 *    `scripts/`, so `packages/domain/src/transcripts/turns.ts` yields a bogus
 *    `scripts/turns.ts`. Removed by {@link PATH_PATTERN}'s leading boundary,
 *    which requires the segment to start a path rather than end a word.
 * 2. **Service-local `scripts/` directories.** `scripts/reconcile-schema.ts`
 *    does not exist at the repo root and DOES exist at
 *    `services/reviewer/scripts/reconcile-schema.ts`. Removed by resolving
 *    against the CITING file's package root before the repo root
 *    ({@link candidatePathsFor}).
 * 3. **Illustrative and fixture names** — `scripts/foo.ts`, `scripts/gone.ts`,
 *    `scripts/verify-something.ts`. Removed by TWO conjuncts, because neither
 *    alone suffices — see below.
 *
 * ## Why class 3 needs both conjuncts (measured, not assumed)
 *
 * Comment-scoping was the obvious single answer and it is not enough. Of five
 * sampled class-3 names, `scripts/gone.ts` and `scripts/verify-something.ts`
 * sit in CODE (test-fixture string literals) and are removed by comment-scoping;
 * but `scripts/foo.ts`, `scripts/x.ts` and `scripts/moved.ts` sit in COMMENTS
 * and survive it. Those are removed by the second conjunct: a path is only a
 * finding when a CLAIM phrase ({@link CLAIM_PHRASES}) governs it. `e.g.
 * \`scripts/foo.ts\`` claims nothing.
 *
 * ## What this deliberately does NOT do, and why
 *
 * ADR-024's Rung 1 is a quotation/citation-aware prefilter that elides code
 * spans and quoted runs before matching. **That is correct for its surface and
 * wrong for this one, so this detector does not apply it to inline code spans.**
 * Rung 1 targets trigger phrases in the agent's own PROSE, where a backticked
 * span means "I am mentioning this, not asserting it." In a source comment the
 * opposite holds: a backticked path is the NORMAL way to cite a real one. Both
 * measured true positives are cited in a comment, and ONE OF THE TWO is
 * backticked — so eliding inline code spans would suppress half the real
 * findings while removing none of the three false classes, which the conjuncts
 * above already handle. Recorded because a later reader will otherwise "fix"
 * this toward Rung 1's letter (mem#1067: an over-narrow conjunct's failure
 * direction is a better-looking number).
 *
 * Fenced blocks and quoted prose runs are not elided either, for the same
 * reason: this scans TypeScript comments, not markdown.
 *
 * @see mt#4426 — this task
 * @see mt#4413 / mt#4202 / mt#3994 — the three instances that reached the threshold
 * @see docs/architecture/adr-024-detection-mechanism-ladder-for-guidance-hooks.md
 */

/**
 * A path-like token, anchored so it must START a path segment.
 *
 * The leading `(?<![A-Za-z0-9_/-])` is the whole of false-positive class 1: it
 * rejects the `scripts/` inside `transcripts/`, which is the single largest
 * source of noise in the corpus and is invisible on inspection. A bare `\b`
 * does NOT substitute — in `transcripts/turns.ts` there is no word boundary
 * before `scripts`, since `t` and `s` are both word characters, so `\b` would
 * simply fail to match there for the wrong reason and would still admit
 * `foo-scripts/bar.ts`. The lookbehind states the actual requirement: the
 * segment must not be preceded by a path or identifier character.
 */
const PATH_PATTERN =
  /(?<![A-Za-z0-9_/-])((?:scripts|src|packages|services|tests|docs)\/[A-Za-z0-9._/-]*[A-Za-z0-9._-])/g;

/**
 * A cited path ends at its extension, not at the sentence's punctuation.
 *
 * `…exercised in scripts/verify-setup-local-http.ts.` ends a sentence, and the
 * greedy character class above happily takes that final period into the path.
 * The resulting token then fails to resolve for a reason that has nothing to do
 * with the claim — a false positive that would have fired on prose style. Every
 * one of this module's first three test failures was this single cause,
 * including one that otherwise looked like the substring guard failing.
 *
 * Trailing dots are stripped, and what remains must still carry a file
 * extension; a bare directory reference is not a coverage claim this detector
 * can check.
 */
const EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,5}$/;

/** Strip sentence punctuation from a captured path; `null` when nothing usable remains. */
export function normalizeCitedPath(raw: string): string | null {
  const trimmed = raw.replace(/\.+$/, "");
  return EXTENSION_PATTERN.test(trimmed) ? trimmed : null;
}

/**
 * Phrases that turn a path MENTION into a path CLAIM.
 *
 * Two families, both drawn from the measured instances rather than invented:
 * coverage assertions (mt#4413's `setup-local-http.test.ts` cited a verify
 * script as the home of its AT coverage) and authority citations (`@see X — the
 * precedent this mirrors`, `the existing X convention` — the two live instances
 * found at planning). A path with none of these governing it is an example, a
 * path argument, or a passing mention, and is not this detector's business.
 */
const CLAIM_PHRASES = [
  "covered by",
  "coverage",
  "covers",
  "exercised in",
  "exercised by",
  "verified by",
  "verified in",
  "tested in",
  "tested by",
  "asserted in",
  "asserted by",
  "@see",
  "see also",
  "per the",
  "the existing",
  "precedent",
  "convention",
  "lives in",
  "lives at",
  "implemented in",
] as const;

/** How far before a path a claim phrase may sit and still be read as governing it. */
const CLAIM_WINDOW_CHARS = 160;

/** A comment region lifted out of source, with the line it starts on. */
export interface CommentRegion {
  text: string;
  /** 1-indexed line number of the region's first character. */
  line: number;
}

/**
 * Extract comment regions from TypeScript-ish source.
 *
 * A hand-rolled scanner rather than a regex because `"https://example.com"`
 * contains `//` and a regex cannot tell that from a line comment without
 * tracking string state. Handles single/double/backtick strings and both
 * comment forms; it does not attempt to parse regex literals, whose contents
 * would at worst add a spurious comment region that the claim conjunct then
 * discards.
 */
export function extractCommentRegions(source: string): CommentRegion[] {
  const regions: CommentRegion[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  const advance = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (source[k] === "\n") line++;
  };

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === "\n") {
      line++;
      i++;
      continue;
    }

    // String literals — skipped wholesale so their contents never read as comments.
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      let j = i + 1;
      while (j < n) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === quote) break;
        j++;
      }
      advance(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }

    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < n && source[j] !== "\n") j++;
      regions.push({ text: source.slice(i + 2, j), line });
      i = j;
      continue;
    }

    if (ch === "/" && next === "*") {
      const startLine = line;
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) j++;
      regions.push({ text: source.slice(i + 2, j), line: startLine });
      advance(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }

    i++;
  }

  return regions;
}

/**
 * Candidate resolutions for a cited path, in the order they should be tried.
 *
 * Package-root FIRST (false-positive class 2): a `services/reviewer/**` file
 * citing `scripts/reconcile-schema.ts` means ITS `scripts/`, and resolving
 * against the repo root manufactures a miss. Repo-root second, for the ordinary
 * case of a top-level script cited from anywhere.
 */
export function candidatePathsFor(citedPath: string, citingFilePath: string): string[] {
  const candidates: string[] = [];
  const normalized = citingFilePath.replace(/^\.\//, "");

  // Walk the citing file's ancestors, nearest first, so a service-local or
  // package-local directory is preferred over the repo root.
  const segments = normalized.split("/").slice(0, -1);
  for (let depth = segments.length; depth > 0; depth--) {
    candidates.push(`${segments.slice(0, depth).join("/")}/${citedPath}`);
  }
  candidates.push(citedPath);

  return candidates;
}

/** One unresolved coverage/authority claim. */
export interface CoverageClaimFinding {
  /** The path as written in the comment. */
  citedPath: string;
  /** The claim phrase that made it a claim rather than a mention. */
  claimPhrase: string;
  /** 1-indexed line of the comment region the claim sits in. */
  line: number;
  /** The claim's immediate context, trimmed — what a reader would have believed. */
  context: string;
}

/**
 * Find comment-borne path claims that do not resolve.
 *
 * @param source - the file's full text.
 * @param citingFilePath - repo-relative path of the file the source belongs to;
 *   decides which package roots a cited path may resolve against.
 * @param exists - injected existence check over repo-relative paths. Injected
 *   rather than reaching for `node:fs` so the discriminations above are testable
 *   without patching a module import.
 */
export function findUnresolvedCoverageClaims(
  source: string,
  citingFilePath: string,
  exists: (repoRelativePath: string) => boolean
): CoverageClaimFinding[] {
  const findings: CoverageClaimFinding[] = [];

  for (const region of extractCommentRegions(source)) {
    PATH_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = PATH_PATTERN.exec(region.text)) !== null) {
      const citedPath = match[1] ? normalizeCitedPath(match[1]) : null;
      if (!citedPath) continue;

      // The citing file naming itself is not a claim about somewhere else.
      if (citedPath === citingFilePath) continue;

      const windowStart = Math.max(0, match.index - CLAIM_WINDOW_CHARS);
      const before = region.text.slice(windowStart, match.index).toLowerCase();

      // The NEAREST preceding phrase, not the first one in the list. A comment
      // routinely contains several ("AT4/AT5 coverage for mt#3816 is exercised
      // in <path>" has two), and list order is arbitrary while proximity is
      // what makes a phrase the one GOVERNING this path. Reporting the wrong
      // one would make the recorded field untrustworthy for calibration review,
      // which is the only consumer that reads it.
      let claimPhrase: string | undefined;
      let claimAt = -1;
      for (const phrase of CLAIM_PHRASES) {
        const at = before.lastIndexOf(phrase);
        if (at > claimAt) {
          claimAt = at;
          claimPhrase = phrase;
        }
      }
      if (!claimPhrase) continue;

      if (candidatePathsFor(citedPath, citingFilePath).some((candidate) => exists(candidate))) {
        continue;
      }

      findings.push({
        citedPath,
        claimPhrase,
        line: region.line,
        context: region.text
          .slice(windowStart, Math.min(region.text.length, match.index + citedPath.length + 40))
          .replace(/\s+/g, " ")
          .trim(),
      });
    }
  }

  return findings;
}
