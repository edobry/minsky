/**
 * JsonView — a small, dependency-free recursive JSON tree renderer (mt#2552).
 *
 * Tier 1: collapsible object/array nodes, type-colored values, dark-mode styling.
 * Tier 2 (the Minsky value-add): string leaves are entity-enriched — `mt#NNNN` /
 * `minsky://` / UUID refs become in-SPA links (reusing mt#2550's `tokenizeEntities`),
 * URLs become external links, ISO timestamps render as relative-time (raw value in
 * the title), and recognized status enums get a subtle color.
 *
 * Hand-rolled rather than a third-party tree (see mt#2552 Implementation decisions):
 * `@uiw/react-json-view` latest is a 2.0 alpha and `react-json-view-lite` can't host
 * arbitrary-React custom leaves, but the leaves ARE the value here.
 *
 * @see ../lib/entity-linkifier.tsx — tokenizeEntities (Tier-2 leaf linkification)
 */
import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils";
import { tokenizeEntities, type EntityIndex } from "../lib/entity-linkifier";

// Recognized task/ask status enums → subtle leaf color.
const STATUS_COLORS: Record<string, string> = {
  TODO: "text-muted-foreground",
  PLANNING: "text-amber-400",
  READY: "text-sky-400",
  "IN-PROGRESS": "text-blue-400",
  "IN-REVIEW": "text-violet-400",
  DONE: "text-emerald-400",
  COMPLETED: "text-emerald-400",
  CLOSED: "text-muted-foreground",
  BLOCKED: "text-destructive",
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const URL_RE = /^https?:\/\/\S+$/;

function relativeTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const diff = Date.now() - ms;
  const abs = Math.abs(diff);
  const sign = diff >= 0 ? "ago" : "from now";
  const sec = Math.floor(abs / 1000);
  if (sec < 60) return `${sec}s ${sign}`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sign}`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${sign}`;
  const day = Math.floor(hr / 24);
  return `${day}d ${sign}`;
}

/**
 * A multiline string leaf — rendered as a preformatted block so line structure
 * survives (mt#2788). The dominant Minsky tool-result shape is
 * `{success, output: "<many lines>"}`; an inline span collapses its newlines and
 * turns the most common payload into a run-on line. Quotes are dropped here:
 * block presentation reads as text, not as a JSON-quoted scalar. Height is
 * bounded so one giant output can't dominate the turn (mirrors ToolPayload's
 * max-h bounds). Entity refs inside the block still linkify.
 */
function MultilineStringLeaf({
  value,
  entityIndex,
}: {
  value: string;
  entityIndex?: EntityIndex;
}) {
  const tokens = entityIndex && entityIndex.size > 0 ? tokenizeEntities(value, entityIndex) : null;
  const hasLinks = tokens !== null && tokens.some((t) => t.kind === "link");
  return (
    <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border/30 bg-muted/20 px-2 py-1 text-emerald-300/90">
      {hasLinks && tokens
        ? tokens.map((t, i) =>
            t.kind === "text" ? (
              <span key={i}>{t.value}</span>
            ) : (
              <Link
                key={i}
                to={t.to}
                className={cn(
                  "text-primary underline-offset-2 hover:underline",
                  t.mono && "font-mono"
                )}
              >
                {t.text}
              </Link>
            )
          )
        : value}
    </pre>
  );
}

/**
 * A string value leaf with Tier-2 enrichment. Quotes are part of the JSON
 * display for single-line values; multiline values take the block presentation
 * (see MultilineStringLeaf).
 */
function StringLeaf({ value, entityIndex }: { value: string; entityIndex?: EntityIndex }) {
  // Any line-break flavor (\n, \r\n, bare \r) takes the block presentation.
  if (/[\r\n]/.test(value)) {
    return <MultilineStringLeaf value={value} entityIndex={entityIndex} />;
  }
  if (URL_RE.test(value)) {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer noopener"
        className="text-primary underline-offset-2 hover:underline"
      >
        &quot;{value}&quot;
      </a>
    );
  }
  if (ISO_RE.test(value)) {
    return (
      <span className="text-teal-300" title={value}>
        &quot;{relativeTime(value)}&quot;
      </span>
    );
  }
  if (Object.prototype.hasOwnProperty.call(STATUS_COLORS, value)) {
    return <span className={cn("font-medium", STATUS_COLORS[value])}>&quot;{value}&quot;</span>;
  }
  if (entityIndex && entityIndex.size > 0) {
    const tokens = tokenizeEntities(value, entityIndex);
    if (tokens.some((t) => t.kind === "link")) {
      return (
        <span className="text-emerald-300">
          &quot;
          {tokens.map((t, i) =>
            t.kind === "text" ? (
              <span key={i}>{t.value}</span>
            ) : (
              <Link
                key={i}
                to={t.to}
                className={cn(
                  "text-primary underline-offset-2 hover:underline",
                  t.mono && "font-mono"
                )}
              >
                {t.text}
              </Link>
            )
          )}
          &quot;
        </span>
      );
    }
  }
  return <span className="break-all text-emerald-300">&quot;{value}&quot;</span>;
}

function JsonNode({
  value,
  entityIndex,
  depth,
}: {
  value: unknown;
  entityIndex?: EntityIndex;
  depth: number;
}) {
  if (value === null) return <span className="text-muted-foreground">null</span>;
  if (value === undefined) return <span className="text-muted-foreground">undefined</span>;
  if (typeof value === "boolean") return <span className="text-orange-300">{String(value)}</span>;
  if (typeof value === "number") return <span className="text-orange-300">{value}</span>;
  if (typeof value === "string") return <StringLeaf value={value} entityIndex={entityIndex} />;
  if (typeof value === "object")
    return <CollapsibleNode value={value} entityIndex={entityIndex} depth={depth} />;
  return <span className="text-muted-foreground">{String(value)}</span>;
}

// Cap on the number of object keys named in a collapsed-node preview (mt#2793).
// Above the cap the remaining keys collapse to a trailing ellipsis.
const KEY_PREVIEW_CAP = 4;

/** Object-key preview for a collapsed node: `id, title, status, …`. */
function keyPreview(entries: Array<[string, unknown]>): string {
  const keys = entries.map(([k]) => k);
  const shown = keys.slice(0, KEY_PREVIEW_CAP);
  return keys.length > KEY_PREVIEW_CAP ? `${shown.join(", ")}, …` : shown.join(", ");
}

/** One array element's shape, for the collapsed-array preview. */
function elementKind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "[…]";
  if (typeof v === "object") return "{…}";
  return typeof v; // "string" | "number" | "boolean" | "undefined"
}

/** Array preview for a collapsed node: `3 × {…}` (length + element kind; "mixed" when heterogeneous). */
function arrayPreview(arr: unknown[]): string {
  const kinds = new Set(arr.map(elementKind));
  const kind = kinds.size === 1 ? [...kinds][0] : "mixed";
  return `${arr.length} × ${kind}`;
}

function CollapsibleNode({
  value,
  entityIndex,
  depth,
}: {
  value: object;
  entityIndex?: EntityIndex;
  depth: number;
}) {
  const isArray = Array.isArray(value);
  const entries: Array<[string, unknown]> = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const [open, setOpen] = useState(depth < 2); // deep nodes start collapsed
  const openCh = isArray ? "[" : "{";
  const closeCh = isArray ? "]" : "}";

  if (entries.length === 0) {
    return (
      <span className="text-muted-foreground">
        {openCh}
        {closeCh}
      </span>
    );
  }

  // Collapsed-state preview (mt#2793): a hint of contents instead of a bare
  // key count, so tree scanning is possible without expanding every node.
  const collapsedPreview = isArray ? arrayPreview(value as unknown[]) : keyPreview(entries);

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-muted-foreground hover:text-foreground"
      >
        <span aria-hidden>{open ? "▾" : "▸"}</span> {openCh}
        {open ? "" : ` ${collapsedPreview} ${closeCh}`}
      </button>
      {open && (
        <div className="ml-1 border-l border-border/30 pl-3">
          {entries.map(([k, v]) => (
            <div key={k}>
              {!isArray && (
                <>
                  <span className="text-sky-300">{k}</span>
                  <span className="text-muted-foreground">: </span>
                </>
              )}
              <JsonNode value={v} entityIndex={entityIndex} depth={depth + 1} />
            </div>
          ))}
        </div>
      )}
      {open && <span className="text-muted-foreground">{closeCh}</span>}
    </div>
  );
}

export interface JsonViewProps {
  data: unknown;
  /** Optional id-set; enables entity-link enrichment of string leaves. */
  entityIndex?: EntityIndex;
  className?: string;
}

/** Render `data` as a collapsible, entity-aware JSON tree. */
export function JsonView({ data, entityIndex, className }: JsonViewProps) {
  return (
    <div className={cn("overflow-auto font-mono text-xs leading-relaxed", className)}>
      <JsonNode value={data} entityIndex={entityIndex} depth={0} />
    </div>
  );
}
