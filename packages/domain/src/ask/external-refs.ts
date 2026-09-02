/**
 * External-artifact reference linkification for ask bodies (mt#2918).
 *
 * An ask body that cites an artifact the principal must read in order to
 * decide is only decidable if that artifact is reachable from the body itself
 * (`humility.mdc §Escalation packaging`). The corpus-internal citation
 * convention — cross-link by page id, because titles drift — is correct for
 * specs and memories and wrong here, and nothing marked the boundary. Asks
 * 827117cc and 755ddc6a both asked the principal to accept an RFC while citing
 * it as a bare Notion page id; the principal approved one and reported that it
 * was unclear how they were supposed to answer it (mem#623 R2).
 *
 * Why this module exists rather than an extension of the cockpit linkifier:
 * `src/cockpit/web/lib/entity-linkifier.tsx` resolves refs against a Minsky
 * id-set at RENDER time, and already covers `mt#N`, `PR #N`, UUIDs, and the
 * `mem#N`/`ask#N`/`ws#N` short-id aliases in ask bodies (`AskDetail.tsx` feeds
 * `ask.question` through `<Prose entityIndex>`). A Notion page id has no entry
 * in any Minsky index, so no amount of display-surface work reaches it. That
 * is the boundary this module sits on, and the whole of what it claims.
 *
 * ## What it does NOT do
 *
 * **It never probes the destination.** The temptation is a reachability check,
 * and the evidence against it is in this task's own history: during the
 * mt#3142 outage an ask's Railway console link was reported as 404 by the
 * principal, and an HTTP probe returned 200 for that URL, for a deliberately
 * garbage UUID, and for a string that was not a UUID at all — only an unknown
 * TOP-LEVEL route 404'd. Railway's dashboard is an SPA: the server answers 200
 * with an app shell for any `/project/<anything>` and the error the human sees
 * is rendered client-side after hydration. Six materially different URLs
 * producing one answer is a probe with zero discriminating power, and a check
 * that cannot fail is not a check — it would pass on dead links while
 * attaching the appearance of verification. So the warning below reports only
 * what is known for certain: that a reference was found and could not be
 * turned into a link.
 *
 * @see mem#623 — the linked-reference-actionability family (R1-R6)
 * @see src/cockpit/web/lib/entity-linkifier.tsx — the Minsky-entity half, at render time
 */

/** A 32-hex Notion page id, dashed (canonical UUID) or bare. */
import { blankSameLength } from "../text/prose-elision";

const NOTION_ID_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32}";

/**
 * A "Notion" cue followed by an id.
 *
 * The cue is REQUIRED, and that is the design decision this pattern encodes.
 * A Notion page id is a UUID, and so is a Minsky ask / memory / workspace id —
 * they are indistinguishable by shape. Linkifying an uncued UUID would happily
 * rewrite an ask's own id into a Notion URL. Requiring the cue makes the
 * transform zero-false-positive against Minsky entities, and it covers the
 * originating incident verbatim, whose text was `Notion 3a0937f0-…`.
 *
 * The intervening span is deliberately narrow — optional `page` / `id` words,
 * separators, and quoting characters — so the cue has to actually be
 * introducing the id rather than merely appearing in the same paragraph.
 */
const NOTION_CUE = String.raw`\bnotion\b[\s:—–-]*(?:page[\s:—–-]*)?(?:id[\s:—–-]*)?["'\`]?`;

const TRAILING_QUOTE = String.raw`["'\`]?`;

const NOTION_CUED_ID_RE = new RegExp(`${NOTION_CUE}(${NOTION_ID_BODY})${TRAILING_QUOTE}`, "gi");

/**
 * A "Notion" cue followed by something id-SHAPED that is not a valid id — a
 * truncated paste, a stray character, a run of the wrong length. This is the
 * population the warning speaks for: the reference is unmistakably meant to be
 * an artifact citation, and the transform cannot resolve it.
 *
 * Bounded at 8 to stay clear of ordinary prose, and matched only when the
 * valid-id pattern above did not already claim the same position.
 */
const NOTION_CUED_MALFORMED_RE = new RegExp(
  `${NOTION_CUE}([0-9a-f][0-9a-f-]{7,})${TRAILING_QUOTE}`,
  "gi"
);

/**
 * Canonical page-URL form.
 *
 * Taken from the primary source rather than convention: Notion's own API
 * returns `https://app.notion.com/p/<32-hex>?pvs=204` as a page's `url` (read
 * off a live `notion-search` response, 2026-08-10). The `?pvs=` parameter is a
 * view-source marker and is not required to resolve the page, so it is not
 * emitted.
 *
 * Worth recording because the repo's own prose disagrees: `www.notion.so/<id>`
 * outnumbers this form ~158 to 19 across markdown and specs. Those citations
 * are agent-authored, so their majority is not evidence — the API response is.
 * If Notion ever changes shape, re-derive from a live response.
 */
export const NOTION_PAGE_URL_PREFIX = "https://app.notion.com/p/";

/** Strip dashes and lowercase — the form Notion's own page URLs carry. */
export function normalizeNotionId(raw: string): string {
  return raw.replace(/-/g, "").toLowerCase();
}

/** Build the canonical page URL for an already-normalized 32-hex id. */
export function notionPageUrl(normalizedId: string): string {
  return `${NOTION_PAGE_URL_PREFIX}${normalizedId}`;
}

export interface LinkifyExternalRefsResult {
  /** The text with reachable references appended after their citation. */
  text: string;
  /**
   * Artifact-shaped references that could NOT be made reachable, verbatim as
   * they appeared. Drives the `unlinkified-reference` form-lint warning.
   */
  unlinkified: string[];
}

export interface LinkifyExternalRefsOptions {
  /**
   * Additional strings that may carry a full Notion page URL — in practice the
   * ask's own `contextRefs` (mt#4901).
   *
   * A body routinely cites a page by a SHORT PREFIX of its id while the full
   * URL sits in `contextRefs`, where nothing looked. That reference is
   * reachable — the ask is carrying its own index — and reporting it as
   * unlinkifiable was the false positive this option closes.
   */
  knownRefs?: readonly string[];
}

/**
 * A Notion URL token — the host plus the rest of the non-whitespace run.
 *
 * Harvesting is deliberately scoped to a Notion HOST rather than to any
 * id-shaped run, and that narrowing is the whole safety argument for the
 * prefix resolution below. A bare UUID is indistinguishable from a Minsky ask
 * / memory / workspace id (see `NOTION_CUE`'s note), so a candidate set built
 * from every id in the text could resolve a truncated Notion cue against a
 * Minsky entity's id and append a Notion URL that points at nothing. Only an
 * id that already appears inside a Notion URL is admitted.
 */
const NOTION_URL_TOKEN_RE = /(?:app\.notion\.com|(?:www\.)?notion\.so)\/\S*/gi;

const NOTION_ID_ANYWHERE_RE = new RegExp(NOTION_ID_BODY, "gi");

/** Normalized 32-hex ids appearing inside a Notion URL in `source`. */
export function collectNotionIdsFromUrls(source: string): string[] {
  const ids: string[] = [];
  NOTION_URL_TOKEN_RE.lastIndex = 0;
  let urlMatch: RegExpExecArray | null;
  while ((urlMatch = NOTION_URL_TOKEN_RE.exec(source)) !== null) {
    NOTION_ID_ANYWHERE_RE.lastIndex = 0;
    let idMatch: RegExpExecArray | null;
    while ((idMatch = NOTION_ID_ANYWHERE_RE.exec(urlMatch[0])) !== null) {
      ids.push(normalizeNotionId(idMatch[0]));
    }
  }
  return ids;
}

/**
 * Replace fenced blocks and inline code spans with same-length filler.
 *
 * Same-length is the load-bearing part: matches are computed against the
 * elided string and applied to the ORIGINAL by index, so every offset has to
 * survive the elision. A shorter replacement would silently shift every
 * subsequent match.
 *
 * A page id inside a code span is being DISPLAYED, not cited — appending a URL
 * inside a fence would corrupt the block it sits in.
 */
export function elideCodeRegions(text: string): string {
  // Same-length AND non-matching (mt#4793). Same-length is the offset property documented above.
  // Non-matching is the second, separately load-bearing half, and this call site genuinely needs
  // it: `NOTION_CUE` contains `[\s:—–-]*`, a whitespace-tolerant separator, so a SPACE filler let
  // the cue run straight through a blanked code region and bind `notion` to an id it was never
  // adjacent to — appending a wrong URL into an ask body. `·` is in neither `\s` nor the
  // separator class, so the cue can no longer span an elided span.
  const blank = blankSameLength;
  return text
    .replace(/```[\s\S]*?```/g, blank)
    .replace(/~~~[\s\S]*?~~~/g, blank)
    .replace(/`[^`\n]*`/g, blank);
}

/**
 * Append the canonical Notion URL after each cued page id in `text`, and
 * report the cued references that could not be resolved.
 *
 * Idempotent: a reference whose URL is already present anywhere in the text is
 * left alone, so re-running over an already-transformed body is a no-op.
 */
export function linkifyExternalRefs(
  text: string,
  options: LinkifyExternalRefsOptions = {}
): LinkifyExternalRefsResult {
  const elided = elideCodeRegions(text);

  interface Insertion {
    at: number;
    url: string;
  }
  const insertions: Insertion[] = [];
  const resolvedSpans: Array<[number, number]> = [];

  NOTION_CUED_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NOTION_CUED_ID_RE.exec(elided)) !== null) {
    const rawId = m[1];
    if (!rawId) continue;
    resolvedSpans.push([m.index, m.index + m[0].length]);
    const url = notionPageUrl(normalizeNotionId(rawId));
    // Idempotence: the URL already being present means a prior pass (or the
    // author) already made this reference reachable.
    if (text.includes(url)) continue;
    insertions.push({ at: m.index + m[0].length, url });
  }

  // Candidate ids a truncated cue may be a prefix OF (mt#4901). Two sources,
  // and the second is what makes this idempotent across the two call paths:
  //
  //  - `knownRefs` — the ask's own contextRefs, at normalization time.
  //  - `text` itself — because normalization APPENDS the resolved URL, so on
  //    any later pass the id is present in the body. `computeFormLintMatches`
  //    calls this function with no options at all, over the already-normalized
  //    question; without this second source it would re-report a reference the
  //    normalization step had already made reachable, and the warning would
  //    survive its own fix.
  const candidateIds = [
    ...collectNotionIdsFromUrls(text),
    ...(options.knownRefs ?? []).flatMap(collectNotionIdsFromUrls),
  ];

  const unlinkified: string[] = [];
  NOTION_CUED_MALFORMED_RE.lastIndex = 0;
  while ((m = NOTION_CUED_MALFORMED_RE.exec(elided)) !== null) {
    const start = m.index;
    // Skip anything the valid-id pass already claimed — the malformed pattern
    // is deliberately looser and overlaps it.
    if (resolvedSpans.some(([s, e]) => start >= s && start < e)) continue;

    const truncated = m[1] ? normalizeNotionId(m[1]) : "";
    const matches = truncated
      ? [...new Set(candidateIds.filter((id) => id.startsWith(truncated)))]
      : [];
    // Exactly one, deliberately: an ambiguous prefix resolves to nothing and is
    // reported, rather than guessing between two pages the ask cites.
    const resolved = matches.length === 1 ? matches[0] : undefined;
    if (resolved) {
      const url = notionPageUrl(resolved);
      if (!text.includes(url)) insertions.push({ at: m.index + m[0].length, url });
      continue;
    }

    unlinkified.push(text.slice(m.index, m.index + m[0].length).trim());
  }

  // Apply right-to-left so earlier offsets stay valid.
  let out = text;
  for (const ins of insertions.sort((a, b) => b.at - a.at)) {
    out = `${out.slice(0, ins.at)} (${ins.url})${out.slice(ins.at)}`;
  }

  return { text: out, unlinkified };
}
