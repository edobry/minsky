// Changed-output-label extraction — the pure core (mt#3959).
//
// Answers one question about a unified diff: which operator-facing output
// LABELS did this change remove or rename? Those label strings are the tokens
// the sweep in ./stale-signal-sweep.ts then looks for across the durable
// corpus, because an artifact quoting `extracted=0` was reading the OLD
// meaning and nothing retracts it when the label is fixed.
//
// ## Why the removed side, and why subtract the added side
//
// The signal worth chasing is a label whose MEANING just changed, and the only
// mechanical evidence of that is the label disappearing from a rendering site.
// A label present on both sides of the hunk was merely moved — its meaning is
// intact, and reporting it would fire on every refactor that touches a log
// line. So: collect labels from removed lines, subtract every label still
// emitted by an added line IN THE SAME FILE, and report the difference.
//
// mt#3911 is the originating case and survives that subtraction: it removed
// `extracted=${extractionResult?.turnsWritten}` and added a render-from-shape
// loop that emits no literal `extracted=` at all.
//
// ## Why this is not a general "did the output change" detector
//
// It deliberately only sees `<label>=<value>` rendering — the shape Minsky's
// CLI counters actually use. A prose message that changed wording is out of
// reach and stays out of scope: there is no token to carry into a corpus grep,
// which is the whole mechanism. Narrowness is the point; the FP budget belongs
// to the corpus scan, not to label detection.

/** A label that a diff stopped emitting, with the file that emitted it. */
export interface ChangedOutputLabel {
  /** The label WITH its `=`, e.g. `extracted=` — the exact corpus-grep token. */
  readonly text: string;
  /** Repo-relative path of the file whose rendering site dropped it. */
  readonly file: string;
}

/**
 * Shortest label worth carrying into a corpus grep.
 *
 * `n=` or `id=` match half the corpus as substrings and carry no subject. Four
 * characters before the `=` is the point where a label reads as a name rather
 * than a variable — `rows=` qualifies, `id=` does not.
 */
export const MIN_LABEL_LENGTH = 4;

/**
 * Cap on labels carried out of one diff.
 *
 * A diff that drops more than this many distinct labels is a rewrite of an
 * output surface, not a label correction, and grepping the corpus for each is
 * both slow and uninformative. The overflow is always reported by the caller
 * rather than silently dropped (`hook-observers.mdc` no-silent-caps).
 */
export const MAX_LABELS = 8;

/**
 * `<label>=` inside a rendered literal.
 *
 * The leading boundary keeps `sExtracted=` from matching as `extracted=`. The
 * trailing `(?!=)` rejects `==` / `===`, which is a comparison rather than a
 * rendering.
 *
 * **No value-position lookahead**, and that is a correction (PR #2974 R1). The
 * first cut required `${`, a quote, or end-of-string after the `=`, on the
 * theory that this distinguished a rendering site from an assignment. Two
 * things were wrong with it. The quote branch became unreachable the moment
 * {@link literalSpans} started stripping quotes before matching — the regex
 * only ever sees a span's interior. And the remaining branches rejected
 * `extracted=0` and `status=ok`: a LITERAL value is the commonest output shape
 * there is, and it is exactly the form the originating incident's artifacts
 * quote (`extracted=0`, `extracted=104`).
 *
 * The assignment-vs-rendering job the lookahead was doing is already done, and
 * done better, by the literal-span constraint: an assignment in code is not
 * inside a string.
 */
const LABEL_EMIT = /(?:^|[^A-Za-z0-9_])([A-Za-z][A-Za-z0-9_]{2,})=(?!=)/g;

/**
 * The contents of every quoted / backticked span on the line, concatenated.
 *
 * A label only counts when it is emitted INSIDE a literal. This is the
 * discriminator that separates a rendering site from an attribute or an
 * assignment, and it was added after the SC4 backtest measured what the
 * cheaper "line contains a quote somewhere" test actually matches: JSX
 * attributes. `className=`, `testid=`, `type=` and `target=` fired on every
 * React commit in the 60-day window — the attribute NAME sits outside the
 * quotes, so `className="flex"` looked identical to `` `count=${n}` `` to a
 * test that only asked whether a quote appeared anywhere on the line.
 *
 * Inside the span, `className="flex items-center"` contributes `flex
 * items-center` — no `=`, no match. A real rendering site contributes
 * `Session ${id}: extracted=${n}`, which still matches.
 */
export function literalSpans(line: string): string {
  return literalSpanList(line).join("\n");
}

/** Matches a quoted or backticked span, honouring backslash escapes. */
const LITERAL_SPAN = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

/**
 * Each literal's interior, as separate entries.
 *
 * The array form matters for callers that test IDENTITY rather than presence:
 * concatenating first lets a match straddle two spans that were never adjacent
 * in the source (PR #2982 R1).
 */
export function literalSpanList(line: string): string[] {
  const spans: string[] = [];
  for (const m of line.matchAll(LITERAL_SPAN)) {
    if (m[2]) spans.push(m[2]);
  }
  return spans;
}

/**
 * The line with every literal's INTERIOR blanked out, quotes retained.
 *
 * The dual of {@link literalSpanList}, for callers that need to reason about
 * code STRUCTURE — brackets, parens — without a character inside a string being
 * mistaken for syntax. Retaining the quotes keeps offsets stable so a caller
 * can still tell that a literal was present.
 */
export function stripLiterals(line: string): string {
  return line.replace(LITERAL_SPAN, (_m, quote: string, body: string) =>
    body ? `${quote}${" ".repeat(body.length)}${quote}` : `${quote}${quote}`
  );
}

/**
 * A comment line emits nothing, on either side of the hunk.
 *
 * This is load-bearing rather than tidiness, and it was found by running the
 * extractor against mt#3911's REAL diff instead of a reduced fixture. That
 * commit's added side carries the explanatory comment
 * `// list. The previous line printed \`extracted=${turnsWritten}\` — the wrong`,
 * which counts as an added `extracted=` emission and cancels the removed one.
 * The detector then reports nothing on the exact diff it exists to catch — and
 * it fails that way SILENTLY, since a cancelled label is indistinguishable from
 * a label that was never dropped.
 *
 * The shape generalizes past this one commit: a PR that fixes a mislabelled
 * signal is unusually likely to NAME the old label in a comment explaining the
 * fix, so this cancellation is correlated with true positives rather than
 * randomly distributed.
 *
 * Matches only a line whose FIRST non-whitespace is a comment marker. A
 * trailing comment after code is left alone deliberately — stripping `//`
 * mid-line would corrupt any string containing `://`.
 */
function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

/**
 * Test files never carry operator-facing output — they ASSERT on it, so a
 * removed label there is a changed expectation, not a changed signal.
 */
export function isExcludedPath(path: string): boolean {
  return (
    path.includes(".test.") ||
    path.includes(".spec.") ||
    path.startsWith("docs/") ||
    path.endsWith(".md")
  );
}

/** Labels emitted by one line, deduped. */
function labelsOnLine(line: string): string[] {
  if (isCommentLine(line)) return [];
  const rendered = literalSpans(line);
  if (!rendered) return [];
  const out = new Set<string>();
  for (const m of rendered.matchAll(LABEL_EMIT)) {
    const label = m[1];
    if (label && label.length >= MIN_LABEL_LENGTH) out.add(`${label}=`);
  }
  return [...out];
}

/**
 * Extract the output labels a unified diff STOPPED emitting.
 *
 * Pure: takes the diff text, returns tokens. Never throws on malformed input —
 * a diff it cannot parse yields no labels, which the caller records as a clean
 * evaluation rather than a failure.
 */
export function extractChangedOutputLabels(diff: string): ChangedOutputLabel[] {
  if (!diff) return [];

  // Per-file removed/added label sets, so the subtraction is scoped to the file
  // that actually changed rather than pooled across the whole diff (a label
  // dropped in one file and coincidentally emitted in another is still a
  // dropped signal for the first file's readers).
  const removed = new Map<string, Set<string>>();
  const added = new Map<string, Set<string>>();
  let file = "";

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      // `+++ b/path/to/file.ts` — the post-image path names the file even for a
      // pure deletion hunk, and `/dev/null` marks a deleted file we skip.
      const raw = line.slice(4).trim();
      file = raw === "/dev/null" ? "" : raw.replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git") || line.startsWith("@@")) continue;
    if (!file || isExcludedPath(file)) continue;

    if (line.startsWith("-")) {
      const found = labelsOnLine(line.slice(1));
      if (found.length > 0) {
        const set = removed.get(file) ?? new Set<string>();
        found.forEach((l) => set.add(l));
        removed.set(file, set);
      }
    } else if (line.startsWith("+")) {
      const found = labelsOnLine(line.slice(1));
      if (found.length > 0) {
        const set = added.get(file) ?? new Set<string>();
        found.forEach((l) => set.add(l));
        added.set(file, set);
      }
    }
  }

  const out: ChangedOutputLabel[] = [];
  for (const [path, labels] of removed) {
    const stillEmitted = added.get(path) ?? new Set<string>();
    for (const text of labels) {
      if (!stillEmitted.has(text)) out.push({ text, file: path });
    }
  }

  // Stable order so the warning text and the calibration record are
  // reproducible across runs on the same diff.
  out.sort((a, b) => a.text.localeCompare(b.text) || a.file.localeCompare(b.file));
  return out;
}
