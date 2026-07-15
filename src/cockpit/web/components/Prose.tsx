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
import type { PluggableList } from "react-markdown";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { rehypeEntityLinks, type EntityIndex } from "../lib/entity-linkifier";
import { minskyUriToPath } from "../lib/entity-codec";

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
  a: ({ href, children, className }) => {
    // Defensive: an anchor with no destination (shouldn't occur for
    // react-markdown-generated links) renders as plain inline text, not a
    // dangling <a href={undefined}>.
    if (!href) {
      return <span className={cn("text-primary", className)}>{children}</span>;
    }
    // minsky:// deeplinks (admitted by urlTransformWithMinsky) resolve to SPA
    // routes via the shared entity codec; an unparseable URI degrades to the
    // same non-link span as the no-href case (mt#2797).
    if (href.startsWith("minsky://")) {
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
    // Entity links and internal markdown links resolve to SPA routes (href
    // starts with "/", always produced by entityToPath); render as react-router
    // <Link>. Everything else is an external link → open in a new tab.
    if (href.startsWith("/")) {
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
