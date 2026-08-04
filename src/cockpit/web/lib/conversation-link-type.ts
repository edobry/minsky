/**
 * Display formatting for a `minsky_session_links.link_type` value (mt#3691).
 *
 * The run-detail conversation switcher shows this beside each candidate's
 * label, so an operator can tell the conversation that CREATED the workspace
 * from a subagent that worked in it.
 *
 * INTERIM, by an explicit decision (ask#6947, operator, 2026-08-04). The
 * options were: no chip at all, the raw enum, or operator-facing copy chosen
 * now. The chip ships, and it renders the SAME TERM the column holds — merely
 * formatted for reading. It deliberately does NOT substitute words: "CWD
 * match", never "Working-directory match"; "Subagent spawn", never "Spawned by
 * orchestrator". Substituting a word would COIN operator-facing vocabulary for
 * delegation lineage, and that decision belongs to mt#3695 (the ontology
 * synthesis that owns "what should the UI call each thing?"). Formatting a
 * term coins nothing, which is what makes it shippable ahead of that answer.
 *
 * Retiring task: mt#3695. If it is still TODO 10 days after this ships,
 * escalate rather than letting these formatted enums harden into the de-facto
 * vocabulary (CLAUDE.md §Work Completion — temporary mechanism budget).
 *
 * Purely mechanical, so an unrecognized value formats too: `link_type` is plain
 * `text` in the schema with the writer classes documented in a comment, and a
 * sixth writer must not render blank here just because it postdates this file.
 *
 * @see packages/domain/src/storage/schemas/minsky-session-links-schema.ts — the
 *   column, and the writer classes that populate it
 * @see mt#3690 — the run-detail multiplicity investigation this came out of
 */

/**
 * Segments rendered as all-caps rather than sentence case. Both are initialisms
 * that read as typos when capitalized as words ("Pr author", "Cwd match").
 */
const INITIALISMS = new Set(["pr", "cwd", "id", "url"]);

/**
 * Format a `link_type` for display: `subagent_spawn` -> "Subagent spawn".
 *
 * Underscore-separated segments become space-separated words; the first word is
 * capitalized and the rest are lowercased, except {@link INITIALISMS}, which
 * are upper-cased wherever they appear. An empty or whitespace-only input is
 * returned unchanged — the switcher renders no chip for a candidate without a
 * link type, so this never has to invent a placeholder.
 */
export function formatLinkType(linkType: string): string {
  const words = linkType.split("_").filter((w) => w.trim().length > 0);
  if (words.length === 0) return linkType;
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (INITIALISMS.has(lower)) return word.toUpperCase();
      if (index === 0) return lower.charAt(0).toUpperCase() + lower.slice(1);
      return lower;
    })
    .join(" ");
}
