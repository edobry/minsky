/**
 * mt#5044 SC1 — does a task's title describe the same subject as its `## Summary`?
 *
 * ## What this measures, and why coverage rather than similarity
 *
 * A title is one line; a Summary is paragraphs. Any symmetric measure (Jaccard, cosine over
 * bags) is therefore dominated by the length difference and reports "dissimilar" for every
 * well-matched pair — it would be measuring the register, not the agreement.
 *
 * So the measure is **asymmetric containment**: of the content words the TITLE spends, how many
 * does the Summary also use? A title whose subject the Summary discusses scores high however
 * long the Summary runs. A title about a different subject scores low even when both are about
 * the same broad area — which is the discriminating case, and the one the originating incident
 * sits in (mt#5042: two compaction tasks, disjoint subjects, one shared noun).
 *
 * ## Deliberately lexical, and deliberately NOT embeddings
 *
 * Two independent reasons, and either alone would settle it:
 *
 * 1. **Egress.** Embedding this corpus would send every task spec to a third-party provider.
 *    A measurement script has no business doing that (mem#1056).
 * 2. **It would measure the wrong thing.** The failure being detected is that an author wrote
 *    a title for subject A over a spec for subject B. Both are usually in the SAME DOMAIN, so
 *    a semantic index — which orders by meaning — scores them as neighbours. That is
 *    `claim-confidence.mdc`'s ranking-axis bound seen from the other side: here the shared
 *    spelling IS the signal, so an exact-token measure is the correct instrument rather than
 *    the cheap one.
 *
 * ## Known limitation, stated rather than hidden
 *
 * Normalization is a conservative plural strip, so morphological variants that are not plurals
 * ("compaction" vs "compact") do not unify. That biases coverage DOWNWARD — it can make a
 * well-matched pair look worse, never a mismatched pair look better. For a measurement whose
 * question is "how many pairs are near-zero", a downward bias inflates the candidate set, which
 * is the safe direction: every flagged pair is then hand-classified anyway. {@link overlapReport}
 * returns the raw-vs-normalized pair so the sensitivity is visible rather than assumed.
 *
 * Pure: no IO, no clock, no network. The measurement shell is
 * `scripts/measure-title-summary-overlap.ts`.
 */

/**
 * Words that carry no subject information. Kept SHORT on purpose: the length floor below already
 * removes most function words, and every entry here is a word that could otherwise create false
 * agreement between two unrelated texts.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "that",
  "this",
  "with",
  "from",
  "into",
  "when",
  "then",
  "than",
  "them",
  "they",
  "their",
  "there",
  "these",
  "those",
  "what",
  "which",
  "while",
  "would",
  "could",
  "should",
  "have",
  "here",
  "does",
  "done",
  "been",
  "being",
  "were",
  "will",
  "some",
  "such",
  "only",
  "also",
  "each",
  "every",
  "more",
  "most",
  "much",
  "must",
  "over",
  "under",
  "about",
  "after",
  "before",
  "because",
  "never",
  "always",
  "still",
  "just",
  "even",
  "both",
  "same",
  "other",
  "another",
  "where",
  "whose",
  "whether",
]);

/**
 * Minimum length for a plain word to count as content.
 *
 * Four keeps domain-bearing short nouns ("spec", "task", "hook", "gate") while dropping the
 * articles and prepositions a stoplist would otherwise have to enumerate.
 */
const MIN_WORD_LENGTH = 4;

/**
 * A token containing one of these is an identifier — a symbol name, a task ref, a config key —
 * and counts as content at ANY length, because `mt#5042`, `db`, or `id` carry more subject
 * information than a long common word does.
 */
const IDENTIFIER_CHARS = /[_#]/;

/**
 * Extract the body of a top-level `## Summary` section.
 *
 * Returns `null` when the spec has no such section — a distinct outcome from an empty one, and
 * the caller must keep them apart: a spec with no Summary is outside this measurement's
 * denominator rather than a zero-coverage member of it.
 *
 * Heading matching is deliberately level-2 and near-exact: `## Summary`, case-insensitive, with an
 * optional trailing colon and an optional PARENTHESIZED annotation. It does NOT accept
 * `### Summary` or `## Summary of changes` — this is a measurement instrument, and a loose match
 * would silently pull a different section's prose into the comparison, which is the one error that
 * would corrupt the number without looking wrong.
 *
 * The parenthetical is admitted on evidence rather than taste (PR #3691 R1). The first version
 * matched the bare heading only; counting the excluded specs that carry a decorated one found
 * **5 of 4,915** — `## Summary (REFRAMED 2026-06-02 …)`, `(NARROWED …)`, `(re-scoped 2026-04-28)`,
 * `(original diagnosis — REFUTED …)`, `(umbrella)`. Each is a real Summary annotated in place, so
 * excluding them was a small denominator bias. A parenthetical is a safe widening because it
 * annotates the section rather than renaming it; `of changes` renames it, which is why the
 * distinction is drawn there and not at "any trailing text".
 *
 * A fenced code block is skipped while scanning for the terminating heading, so a `## ` line
 * INSIDE a fence cannot truncate the section early.
 */
export function extractSummary(spec: string): string | null {
  if (typeof spec !== "string" || spec.trim() === "") return null;

  const lines = spec.split("\n");
  const startIndex = lines.findIndex((line) =>
    /^##\s+summary\s*(?:\([^)]*\))?\s*:?\s*$/i.test(line.trim())
  );
  if (startIndex === -1) return null;

  let inFence = false;
  let endIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(?:```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // Any level-1 or level-2 heading ends the section; deeper ones are its own subsections.
    if (/^#{1,2}\s+\S/.test(line)) {
      endIndex = i;
      break;
    }
  }

  return lines
    .slice(startIndex + 1, endIndex)
    .join("\n")
    .trim();
}

/**
 * Normalize one raw token. Lowercases, then strips a single trailing plural `s` on words long
 * enough that doing so cannot create a collision between distinct short words.
 *
 * `ss` endings are left alone ("class", "process"), since stripping there yields a non-word and
 * would unify "class" with "cla".
 */
function normalizeToken(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.length > 4 && lower.endsWith("s") && !lower.endsWith("ss")) {
    return lower.slice(0, -1);
  }
  return lower;
}

/**
 * Split text into normalized content tokens.
 *
 * Backticks are stripped rather than their contents dropped: an inline-code identifier such as
 * `tasks_create` is exactly the kind of subject word this measure should count, and titles and
 * summaries differ in whether they bother to fence it.
 */
export function contentTokens(text: string): Set<string> {
  if (typeof text !== "string") return new Set();

  const withoutBackticks = text.replace(/`/g, " ");
  const raw = withoutBackticks.split(/[^A-Za-z0-9_#]+/);

  const out = new Set<string>();
  for (const token of raw) {
    if (token === "") continue;
    // A bare number carries no subject information; a number inside an identifier already
    // survived as part of that identifier.
    if (/^\d+$/.test(token)) continue;

    const isIdentifier = IDENTIFIER_CHARS.test(token);
    if (!isIdentifier && token.length < MIN_WORD_LENGTH) continue;

    const normalized = normalizeToken(token);
    if (!isIdentifier && STOPWORDS.has(normalized)) continue;

    out.add(normalized);
  }
  return out;
}

/** The result of comparing one title against one `## Summary`. */
export interface OverlapReport {
  /** Share of the title's content tokens that also appear in the Summary, in [0, 1]. */
  readonly coverage: number;
  /** The same share computed WITHOUT plural normalization — the sensitivity floor. */
  readonly coverageExact: number;
  /** Title content tokens, normalized. */
  readonly titleTokens: readonly string[];
  /** Title tokens the Summary does NOT use — what makes a low score readable. */
  readonly missingTokens: readonly string[];
  /** Title tokens the Summary shares. */
  readonly sharedTokens: readonly string[];
}

/**
 * Compare a title against a Summary body.
 *
 * A title with no content tokens at all yields `coverage: 1` — vacuously agreeing rather than
 * maximally disagreeing. That direction is chosen so the measurement never reports an
 * unclassifiable degenerate case as its most alarming finding. Scoring it 1 keeps it out of the
 * low tail entirely, which is why nothing further is done with it; an earlier version of this
 * sentence claimed the shell reported such titles separately, and the shell never did (PR #3691
 * R1 caught the claim, not a defect).
 */
export function overlapReport(title: string, summary: string): OverlapReport {
  const titleTokens = contentTokens(title);
  const summaryTokens = contentTokens(summary);

  const shared: string[] = [];
  const missing: string[] = [];
  for (const token of titleTokens) {
    if (summaryTokens.has(token)) shared.push(token);
    else missing.push(token);
  }

  const exactTitle = new Set(
    [...title.replace(/`/g, " ").split(/[^A-Za-z0-9_#]+/)].map((t) => t.toLowerCase())
  );
  const exactSummary = new Set(
    [...summary.replace(/`/g, " ").split(/[^A-Za-z0-9_#]+/)].map((t) => t.toLowerCase())
  );
  let exactShared = 0;
  let exactTotal = 0;
  for (const token of exactTitle) {
    if (token === "" || /^\d+$/.test(token)) continue;
    const isIdentifier = IDENTIFIER_CHARS.test(token);
    if (!isIdentifier && (token.length < MIN_WORD_LENGTH || STOPWORDS.has(token))) continue;
    exactTotal++;
    if (exactSummary.has(token)) exactShared++;
  }

  return {
    coverage: titleTokens.size === 0 ? 1 : shared.length / titleTokens.size,
    coverageExact: exactTotal === 0 ? 1 : exactShared / exactTotal,
    titleTokens: [...titleTokens],
    missingTokens: missing,
    sharedTokens: shared,
  };
}
