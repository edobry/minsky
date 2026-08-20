/**
 * Prose — the cockpit's single shared Markdown renderer (mt#2550).
 *
 * Many cockpit surfaces hold agent/user-authored free text that contains
 * Markdown (task specs, memory bodies, ask questions, assistant turns). Before
 * this component each widget rendered such text ad-hoc as `<pre>`/monospace,
 * losing all Markdown structure. `<Prose>` is the cross-cutting fix: drop it in
 * at every PROSE render site.
 *
 * Design (see mt#2550 spec):
 *   - **Always render, never detect.** Markdown is a superset of plain text, so
 *     plain prose renders identically — there is no "is this Markdown?" sniff.
 *     The prose-vs-code/data decision is made by the CALLER (the render site),
 *     not at runtime.
 *   - **Safe by construction.** react-markdown builds React elements from a
 *     remark/rehype AST and never uses dangerouslySetInnerHTML. Raw HTML
 *     (`rehype-raw`) is deliberately NOT enabled, so embedded `<script>` /
 *     `<img onerror>` render inert as text. No DOMPurify needed.
 *   - **Entity-linkification composes via a rehype plugin** (mt#2518's tokenizer
 *     reused) that runs AFTER Markdown parse over leaf text nodes, skipping code
 *     spans/blocks. Pass `entityIndex` (from `useEntityIndex`) to enable it.
 *
 * @see ../lib/entity-linkifier.tsx — tokenizer + rehypeEntityLinks plugin
 * @see ../lib/use-entity-index.ts — the id-set hook callers pass in
 */
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { rehypeEntityLinks, pathToEntity, type EntityIndex } from "../lib/entity-linkifier";
import { minskyUriToPath, parseMinskyUri, type RoutableEntityType } from "../lib/entity-codec";
import { EntityRef } from "./EntityRef";
import { Check } from "lucide-react";

/**
 * URL transform that admits the `minsky://` deeplink scheme (mt#2797).
 *
 * Agents emit markdown deeplinks — `[mt#2779](minsky://task/mt%232779)` — in
 * terminal chat per the cockpit-deeplinks rule, and stored transcripts must
 * keep resolving them. react-markdown's defaultUrlTransform strips protocols
 * outside its safe list to '' (so the `a` override saw no href and rendered a
 * dead blue span). Pass `minsky:` URLs through untouched — the `a` override
 * maps them to in-SPA routes via the entity codec — and defer to the default
 * transform for everything else (javascript: etc. still stripped).
 */
function urlTransformWithMinsky(value: string): string {
  if (value.startsWith("minsky://")) return value;
  return defaultUrlTransform(value);
}

// Element overrides give the dense, dark cockpit look (the @tailwindcss/typography
// `prose` defaults are tuned for article spacing and clash with mission-control
// density — so we hand-roll a tight set of element styles instead).
const COMPONENTS: Components = {
  a: (props) => {
    const { href, children, className } = props;
    // Entity identity carried by rehypeEntityLinks' makeAnchor (mt#3174) —
    // only ever present on anchors produced from bare mt#NNNN/UUID refs
    // resolved against the entity index, never on markdown-authored links.
    // Read from the raw properties bag (react-markdown's `Components["a"]`
    // prop type has no `data-entity-*` entries — these are additive hast
    // properties, not a typed prop) so no href re-parsing is needed.
    const extra = props as Record<string, unknown>;
    const entityType = extra["data-entity-type"] as RoutableEntityType | undefined;
    const entityId = extra["data-entity-id"] as string | undefined;

    // Defensive: an anchor with no destination (shouldn't occur for
    // react-markdown-generated links) renders as plain inline text, not a
    // dangling <a href={undefined}>.
    if (!href) {
      return <span className={cn("text-primary", className)}>{children}</span>;
    }
    // minsky:// deeplinks (admitted by urlTransformWithMinsky) resolve to an
    // entity via the shared codec; an unparseable URI degrades to the same
    // non-link span as the no-href case (mt#2797).
    //
    // Resolved, they render through <EntityRef> exactly like a linkifier-built
    // anchor does (mt#4351). Until then this branch produced a plain <Link>,
    // so the SAME entity peeked when a bare `mem#728` was linkified and
    // navigated away when an agent had written `[mem#728](minsky://memory/…)`
    // — and the second form is the one `cockpit-deeplinks.mdc` instructs agents
    // to emit, so every reference in a stored conversation was the losing case.
    // The linkifier cannot repair it from its side: `SKIP_TAGS` contains `a`,
    // because re-tokenizing inside an authored link would nest one link in
    // another.
    // `mono={false}`: the label here is prose the author chose, not an id, and
    // the branch this replaced rendered it in the body face (PR #3181 R1).
    if (href.startsWith("minsky://")) {
      const entity = parseMinskyUri(href);
      if (!entity) {
        return <span className={cn("text-primary", className)}>{children}</span>;
      }
      // A URI whose id swallowed a query or fragment is NOT peekable — same
      // class as the path branch below, which `pathToEntity` rejects outright.
      // `parseMinskyUri` takes everything after the type as the id, so
      // `minsky://memory/<uuid>?tab=x` yields the id `<uuid>?tab=x`; peeking
      // that addresses nothing. Keep the pre-mt#4351 rendering for it — a link
      // to the same (already odd) route it produced before, rather than a new
      // way to be wrong. The reviewer flagged only the path branch; this is the
      // same defect one branch up.
      //
      // Tested on the RAW remainder, NOT on the decoded id, and the difference
      // is load-bearing: a task id CONTAINS a `#` (`mt#4351`) — which is why
      // the URI form percent-encodes it as `mt%234351`. Reading the decoded id
      // classified every task deeplink as fragment-bearing and stopped it
      // peeking. Only a LITERAL `#`/`?` in the URI is a fragment or query.
      const rawId = href.slice(href.indexOf("/", "minsky://".length) + 1);
      if (rawId.includes("?") || rawId.includes("#")) {
        const path = minskyUriToPath(href);
        if (!path) {
          return <span className={cn("text-primary", className)}>{children}</span>;
        }
        return (
          <Link
            to={path}
            className={cn("text-primary underline-offset-2 hover:underline", className)}
          >
            {children}
          </Link>
        );
      }
      return (
        <EntityRef type={entity.type} id={entity.id} className={className} mono={false}>
          {children}
        </EntityRef>
      );
    }
    // Entity links carrying resolved (type, id) identity (mt#3174): render
    // through the shared <EntityRef> so the hover-card badge treatment is
    // available. `children` is passed through unchanged as EntityRef's
    // inline content — the visible text stays EXACTLY what the linkifier
    // matched, whether or not a label ever resolves (failure-tolerant, no
    // layout shift; see EntityRef's module doc).
    //
    // `appendLabel` (mt#3189): prose additionally shows the resolved title
    // INLINE, truncated, after the matched text. Without it the title reached
    // the reader only via the hover card — which Radix documents as
    // inaccessible to keyboard users and ignored by screen readers, so a bare
    // `mt#NNNN` was unidentifiable for them and required a click for everyone
    // else. Dense list rows deliberately do NOT set this flag (it would grow
    // their line height); prose is the surface with room for it.
    if (entityType && entityId && href.startsWith("/")) {
      return (
        <EntityRef type={entityType} id={entityId} className={className} appendLabel>
          {children}
        </EntityRef>
      );
    }
    // Internal markdown links resolve to SPA routes; render as react-router
    // <Link>. Everything else is an external link → open in a new tab.
    //
    // One that ADDRESSES AN ENTITY goes through <EntityRef> first (mt#4351).
    // The trigger for the peek is "this href names an entity", not "this href
    // is spelled `minsky://`" — an authored `[the note](/memory/<uuid>)` points
    // at the same entity as the deeplink above and has no business behaving
    // differently. `pathToEntity` is the linkifier's own inverse of
    // `entityToPath`, reused rather than re-derived; a path naming no entity
    // (`/activity`) returns null and falls through unchanged — and so does one
    // carrying a query or fragment (`/memory/<uuid>?tab=details`), which names
    // something WITHIN the entity and whose href only survives verbatim on the
    // <Link> below (PR #3181 R1/R2/R3).
    if (href.startsWith("/")) {
      const entity = pathToEntity(href);
      if (entity) {
        return (
          <EntityRef type={entity.type} id={entity.id} className={className} mono={false}>
            {children}
          </EntityRef>
        );
      }
      return (
        <Link
          to={href}
          className={cn("text-primary underline-offset-2 hover:underline", className)}
        >
          {children}
        </Link>
      );
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className={cn("text-primary underline-offset-2 hover:underline", className)}
      >
        {children}
      </a>
    );
  },
  p: ({ children }) => <p className="mb-2 leading-relaxed last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="mb-1 mt-3 text-base font-semibold first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => <h2 className="mb-1 mt-3 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-medium first:mt-0">{children}</h3>,
  h4: ({ children }) => (
    <h4 className="mb-1 mt-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mb-1 mt-2 text-xs font-semibold text-muted-foreground">{children}</h5>
  ),
  h6: ({ children }) => (
    <h6 className="mb-1 mt-2 text-xs font-medium text-muted-foreground">{children}</h6>
  ),
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => (
    <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  code: ({ className, children }) => {
    // Block code carries a `language-*` class OR spans multiple lines; it is
    // wrapped by the `pre` override below (which owns the block chrome), so the
    // inner <code> stays unstyled. Inline code gets the chip treatment.
    const text = String(children ?? "");
    const isBlock =
      (typeof className === "string" && className.includes("language-")) || text.includes("\n");
    if (isBlock) {
      return <code className={cn("font-mono", className)}>{children}</code>;
    }
    return (
      <code className="rounded bg-muted/50 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-auto rounded border border-border/50 bg-muted/40 p-2 font-mono text-xs">
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border/60 px-2 py-1 text-left font-semibold">{children}</th>
  ),
  td: ({ children }) => <td className="border border-border/60 px-2 py-1 align-top">{children}</td>,
  /**
   * GFM task-list checkbox (mt#3348).
   *
   * `remark-gfm` renders `- [ ] item` as `<input type="checkbox" disabled>`,
   * which keeps `appearance: auto` — so the engine paints native OS chrome
   * inside a dark-mode-first surface. Every task spec rendered on
   * `/tasks/:id` carried these; a source grep never finds them because they
   * are generated at render time.
   *
   * Deliberately NOT the Radix `Checkbox` primitive (`ui/checkbox.tsx`): these
   * are always `disabled` and purely presentational — markdown task state is
   * not editable from this surface, so mounting a real interactive control
   * would advertise an affordance that does not exist.
   *
   * Exposed as `role="img"` with an explicit `aria-label`, NOT as
   * `role="checkbox"` (PR #2417 R1). A checkbox role needs an accessible name,
   * and this element has no text content and no label to point at — a nameless
   * widget role announces "checkbox, checked" with no indication of what. It is
   * also unfocusable and unoperable, so the widget role promised something it
   * could never satisfy. `role="img"` + a label that states the state outright
   * is both nameable and honest about what this is: a state icon.
   *
   * Overriding `input` is react-markdown's documented customization path
   * (the `components` prop keyed by tag name), the same escape hatch the 18
   * other entries in this map use.
   */
  input: ({ type, checked }) => {
    // The only input GFM emits is the task-list checkbox. Anything else would
    // be a native control we never asked for — render nothing rather than
    // leak OS chrome.
    if (type !== "checkbox") return null;
    return (
      <span
        role="img"
        aria-label={checked ? "Completed" : "Not completed"}
        className={cn(
          "mr-1.5 inline-flex h-3 w-3 shrink-0 translate-y-[1px] items-center justify-center rounded-sm border align-text-top",
          checked
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border bg-background"
        )}
      >
        {checked ? <Check className="h-2.5 w-2.5" aria-hidden="true" /> : null}
      </span>
    );
  },
  hr: () => <hr className="my-3 border-border" />,
};

const REMARK_PLUGINS: PluggableList = [remarkGfm];

export interface ProseProps {
  /** Raw Markdown (or plain) text. Empty / whitespace-only renders nothing. */
  children: string | null | undefined;
  /**
   * Optional known-entity id-set. When provided (and non-empty), bare entity
   * references in the text (mt#NNNN, UUIDs, minsky:// URIs) become in-SPA links.
   * Obtain via `useEntityIndex()`.
   */
  entityIndex?: EntityIndex;
  className?: string;
}

/**
 * Render `children` as Markdown with cockpit dark-mode styling and optional
 * entity-linkification. Returns null for empty/whitespace input.
 */
export function Prose({ children, entityIndex, className }: ProseProps) {
  if (!children || children.trim().length === 0) return null;

  const rehypePlugins: PluggableList =
    entityIndex && entityIndex.size > 0 ? [[rehypeEntityLinks, { index: entityIndex }]] : [];

  return (
    <div className={cn("break-words text-sm text-foreground/90", className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={COMPONENTS}
        urlTransform={urlTransformWithMinsky}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}