/**
 * credential-shape-check — a callable answer to "does this text contain an
 * UNMASKED credential?", reusing the vetted shape list that already lives in
 * the transcript-ingest scrubber (mt#4022, family root memory `82fac2c8`).
 *
 * ## Why this exists
 *
 * `CREDENTIAL_SHAPES` (./transcripts/credential-scrubber.ts) has always been
 * a correct, vetted pattern list — but it was reachable only from the
 * transcript-ingest pipeline. An agent at a terminal asking "does this
 * command's output contain a credential?" had nothing to call, so it
 * hand-rolled a regex. That produced a failure in BOTH directions, eleven
 * days apart, from the same absent primitive:
 *
 * - **False negative (mem#808, 2026-08-01).** A hand-rolled `sed` filter
 *   specified `postgres://` while the stored value used `postgresql://`. The
 *   filter matched nothing and passed the credential through unchanged.
 * - **False positive (mem#972, 2026-08-11).** A hand-rolled fail-closed
 *   wrapper tested `postgres(ql)?://[^:\s]+:[^@\s]+@` against
 *   `bun run db:migrate` output and fired — because the pattern also matches
 *   the MASKED rendering (`://***:***@`): three asterisks contain no colon
 *   or whitespace, so the "credential" shape and its own redaction are
 *   indistinguishable to a regex that only asks "does this look like
 *   `user:pass@`?".
 *
 * This module is the callable primitive that ends both failure modes: it
 * reuses `CREDENTIAL_SHAPES` BY CONSTRUCTION (one definition, two consumers
 * — this module and the ingest scrubber), and it tells a real credential
 * apart from its own redaction by asking the ACTUAL masking function whether
 * the matched text is one of its outputs, rather than guessing a second
 * pattern for "looks masked."
 *
 * ## The masked-form problem, solved at the source
 *
 * `maskConnectionString` (./persistence/connection-string.ts) is the only
 * SANCTIONED producer of a rendering shaped like `scheme://user:pass@host` —
 * it always emits exactly `://***:***@`.
 *
 * That sentence read "the ONLY function in this repo" until mt#4963, and it was
 * false when written: six hand-rolled copies were emitting their own renderings
 * (`://***@`, `:<REDACTED>@`), which mt#4910 converted. Two remain by decision
 * rather than by oversight — `getConnectionInfo` (`://***@`) and
 * `runPostgresSchemaMigrations`'s execute path (`host` + `pathname`, no scheme)
 * — so "only sanctioned producer" is the accurate claim and "only function" is
 * not. Read as an invariant this MATTERS: the masked-form exclusion below tests
 * a match by re-masking it, so a rendering some other function produces is not
 * recognized as a mask and is reported as a credential. That is not a bug in the
 * exclusion; it is why the renderings should converge.
 *
 * Because
 * `postgres-url-credentials`'s regex is (correctly) shaped to match
 * `scheme://user:pass@host` in general, it also matches that masked
 * rendering — the exact mem#972 collision.
 *
 * `maskConnectionString` is idempotent: applying it to its OWN output is a
 * no-op (`://***:***@` matches its own regex and rewrites to itself), while
 * applying it to a REAL credential always changes the text (the real
 * user/password segment is replaced). So "does re-masking this matched span
 * change it?" is a direct, source-derived test for "is this span already a
 * mask?" — no second guessed pattern, no independent knowledge of what a
 * mask looks like beyond calling the function that produces one.
 *
 * `maskShape` (../../../scripts/deploy-minsky-mcp.ts) is a SECOND, unrelated
 * masking convention — length-and-category text like `(42 chars)` or
 * `(integer: 5432)`, never a URL. It cannot collide with any shape in
 * `CREDENTIAL_SHAPES` (none of its outputs contain `://`, a `pul-`/`sk-`/
 * `ghp_`/`gho_`/`xox[baprs]-`/`AKIA` sigil, a PEM marker, or a JWT's
 * three-dot-segment shape), so no exclusion rule is needed for it. Its
 * non-collision is asserted directly against the real function in
 * `scripts/deploy-minsky-mcp.test.ts` rather than assumed here.
 *
 * ## What this module does NOT do
 *
 * - It does not change what the ingest scrubber redacts (out of scope per
 *   the mt#4022 spec) — it is a read-only detector, not a rewriter.
 * - It never returns matched text, only shape NAMES (e.g.
 *   `"postgres-url-credentials"`). A tool whose job is to say "there is a
 *   secret here" must not become the thing that prints it — see the CLI
 *   entry point (`../../../src/adapters/shared/commands/security.ts`) and
 *   its subprocess-level test asserting no matched text ever reaches stdout
 *   or stderr, on any path including error paths.
 *
 * @see mt#4022 — this file
 * @see ./transcripts/credential-scrubber.ts — the shared shape list (criterion 4)
 * @see ./persistence/connection-string.ts — maskConnectionString, the source of truth
 *   for the one masked form this module must never flag (criterion 2)
 * @see .minsky/rules/terminal-command-best-practices.mdc §Secret handling — the rule
 *   this module is now cited from (criterion 5)
 */

import { CREDENTIAL_SHAPES } from "../transcripts/credential-scrubber";
import { maskConnectionString } from "../persistence/connection-string";

/** The outcome of scanning a piece of text for unmasked credential shapes. */
export interface CredentialShapeCheckResult {
  /** True when at least one shape matched text that is NOT a known masked rendering. */
  hasUnmaskedCredential: boolean;
  /**
   * Names of the `CredentialShape`s that matched (deduplicated, in
   * `CREDENTIAL_SHAPES` order). Never the matched text itself — see the
   * module doc's "What this module does NOT do".
   */
  matchedShapes: string[];
}

/**
 * Per-shape "is this matched span a known masked rendering?" checks. Keyed
 * by `CredentialShape.name`. Only shapes with an actual, vetted masking
 * function that can re-emit the SAME shape's regex need an entry here —
 * today that is exactly `postgres-url-credentials`, because
 * `maskConnectionString` is the only masker in the repo whose output can
 * collide with a `CREDENTIAL_SHAPES` regex (see module doc). Adding a shape
 * here always means "read the real masking function," never "write a new
 * pattern that looks like a mask."
 */
const MASKED_FORM_CHECKS: Readonly<Record<string, (matchText: string) => boolean>> = {
  "postgres-url-credentials": (matchText) => maskConnectionString(matchText) === matchText,
};

/**
 * Scan `text` for every shape in `CREDENTIAL_SHAPES` and report which ones
 * matched UNMASKED text. A match that is provably a known masked rendering
 * (per `MASKED_FORM_CHECKS`) is excluded — this is what keeps
 * `bun run db:migrate` output (which embeds a masked Postgres connection
 * string, scheme then `***:***@`) from being reported as a hit (AT2 /
 * mem#972), while a genuine Postgres URL carrying real `user:pass@`
 * credentials, under either scheme spelling (AT3 / mem#808), is still
 * reported.
 *
 * Pure and synchronous — never throws on ordinary string input, including
 * the empty string. Never returns matched text, only shape names.
 *
 * Robust to `CREDENTIAL_SHAPES` itself, not just to `text`: `String.matchAll`
 * throws a `TypeError` on a non-global regex, and every shape today IS global
 * (asserted directly in `credential-scrubber.test.ts`) — but this function's
 * "never throws" contract should not silently depend on that invariant
 * holding forever. `globalRegexFor` below scans with a global CLONE of any
 * shape whose regex is missing the `g` flag, so a future misconfigured shape
 * still gets scanned correctly instead of crashing the whole check (mt#4022
 * PR #2900 review).
 */
export function checkForUnmaskedCredentials(text: string): CredentialShapeCheckResult {
  const matchedShapes = new Set<string>();

  if (typeof text !== "string" || text.length === 0) {
    return { hasUnmaskedCredential: false, matchedShapes: [] };
  }

  for (const shape of CREDENTIAL_SHAPES) {
    const scanRegex = globalRegexFor(shape.regex);
    scanRegex.lastIndex = 0;
    const isMaskedForm = MASKED_FORM_CHECKS[shape.name];
    for (const match of text.matchAll(scanRegex)) {
      const matchText = match[0];
      if (isMaskedForm?.(matchText)) {
        continue;
      }
      matchedShapes.add(shape.name);
    }
  }

  return {
    hasUnmaskedCredential: matchedShapes.size > 0,
    matchedShapes: [...matchedShapes],
  };
}

/**
 * Returns `regex` unchanged if it already carries the `g` flag (the case
 * for every `CREDENTIAL_SHAPES` entry today); otherwise returns a global
 * CLONE with the same source and flags plus `g`. `String.matchAll` requires
 * a global regex and throws `TypeError` otherwise — cloning here means a
 * shape regex that loses its `g` flag in a future edit degrades to "still
 * scanned correctly" rather than "the whole check throws."
 *
 * Exported for direct testing of this specific robustness property.
 */
export function globalRegexFor(regex: RegExp): RegExp {
  return regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
}
