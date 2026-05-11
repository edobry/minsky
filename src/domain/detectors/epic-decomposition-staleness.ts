/**
 * Epic-decomposition-staleness detector — Shape C of the attention-allocation family.
 *
 * Identifies (epic, candidate-TODO-child) pairs where the epic has a recently-DONE
 * sibling whose scope substantively overlaps the TODO-child's scope. Surfaces
 * the "Sprint-A-superseded children" cluster that recurs after a major delivery
 * lands inside an epic.
 *
 * Sibling Shapes:
 *   Shape A — workaround-firing × stall-age      (mt#1539)
 *   Shape B — lynchpin × inactivity              (mt#1540)
 *   Shape C — epic-shipped × children-stale      (this module, mt#1710)
 *
 * Pure functions only — no I/O, no DI. Callers fetch the snapshots from the
 * task service / task-graph service and pass them in. This makes the detector
 * trivially testable against fixtures and runnable from any surface (CLI,
 * skill step, periodic sweep, hook).
 *
 * Reference: docs/architecture/adr-008-attention-allocation-subsystem.md
 * Reference: memory `Epic-decomposition-children go stale when parent ships major delivery`
 *            (id 4bc8ee1f-1eee-4561-a865-73c067e48d2e)
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stable detector identifier. */
export const DETECTOR_ID = "epic-decomposition-staleness";

/** Versioned ruleset; bump when scope-extraction or scoring rules change. */
export const DETECTOR_VERSION = "v0.1.0";

/** Default delivery-recency window — how recently a DONE sibling must have shipped. */
export const DEFAULT_RECENCY_WINDOW_DAYS = 30;

/** Statuses treated as candidate (open) children. */
export const DEFAULT_TODO_STATUSES = ["TODO", "PLANNING"] as const;

/** Statuses treated as delivery (shipped) siblings. */
export const DEFAULT_DELIVERY_STATUSES = ["DONE"] as const;

/**
 * Minimum overlap-signal count to surface a candidate.
 *
 * 1 = surface even on a single signal type (file overlap OR identifier OR keyword).
 * 2 = require at least two distinct signal types.
 *
 * Default is 1 — false-positive control is the operator's job. The CLI surface
 * lists candidates; the operator confirms/dismisses per pair.
 */
export const DEFAULT_MIN_OVERLAP_SIGNALS = 1;

/**
 * Common-English stopword list for keyword extraction. Deliberately narrow:
 * we want distinctive keywords from a spec's `## Scope` section, not a
 * full NLP tokenizer. Words shorter than `KEYWORD_MIN_LENGTH` are also
 * dropped, which handles most short common words automatically.
 */
const KEYWORD_STOPWORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "along",
  "already",
  "another",
  "around",
  "because",
  "before",
  "behind",
  "below",
  "between",
  "beyond",
  "could",
  "during",
  "either",
  "every",
  "first",
  "found",
  "given",
  "going",
  "having",
  "however",
  "instead",
  "later",
  "least",
  "might",
  "never",
  "often",
  "other",
  "rather",
  "really",
  "should",
  "since",
  "still",
  "their",
  "there",
  "these",
  "those",
  "through",
  "today",
  "under",
  "until",
  "using",
  "where",
  "which",
  "while",
  "whose",
  "without",
  "would",
  "above",
  "below",
  "scope",
  "intent",
  "value",
  "above",
  "level",
  "include",
  "includes",
  "including",
  "without",
  "between",
  "system",
  "subsystem",
  "module",
  "modules",
  "component",
  "components",
  "implementation",
  "implement",
  "implements",
  "implementing",
  "feature",
  "features",
  "function",
  "functions",
  "method",
  "methods",
  "class",
  "classes",
  "interface",
  "interfaces",
  "service",
  "services",
  "support",
  "supports",
  "supported",
  "supporting",
  "current",
  "currently",
  "previous",
  "previously",
  "exists",
  "existing",
  "missing",
  "needed",
  "needs",
  "needed",
  "ready",
  "required",
  "requires",
  "requirement",
  "requirements",
  "appropriate",
]);

/** Minimum keyword length to consider. */
const KEYWORD_MIN_LENGTH = 5;

/** Maximum keywords to extract per signal set (top-N by frequency). */
const KEYWORD_MAX_PER_SPEC = 25;

/** Minimum identifier length to consider (camelCase or snake_case multi-word). */
const IDENTIFIER_MIN_LENGTH = 6;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Snapshot of an epic child task, fetched and passed in by the caller.
 *
 * The caller (CLI command, sweep job, hook) is responsible for resolving
 * the epic's children, reading each child's status / timestamps / spec
 * from the task service, and assembling these snapshots. This keeps the
 * detector pure and trivially testable.
 */
export interface EpicChildSnapshot {
  id: string;
  title: string;
  status: string;
  /**
   * Full spec content (markdown). The detector parses `## Scope` →
   * `**In scope:**` to extract scope signals. If empty, the child is
   * still partitioned by status but contributes no overlap signals.
   */
  spec: string;
  /** Task createdAt — used to require todoChild filed before delivery. */
  createdAt?: Date;
  /**
   * Task updatedAt — used as a proxy for "delivery time" on DONE siblings.
   * The Minsky backend bumps updatedAt on setTaskStatus calls, so this
   * tracks the DONE transition closely (with some imprecision: any later
   * edit also bumps it).
   */
  updatedAt?: Date;
}

/** Scope signals extracted from a spec. */
export interface ScopeSignals {
  /** File paths mentioned in the In-scope section (e.g., `src/foo/bar.ts`). */
  filePaths: Set<string>;
  /**
   * Identifier-like tokens (camelCase, snake_case, kebab-case multi-word) found
   * in the In-scope section. Captures function names, type names, env-vars,
   * config keys.
   */
  identifiers: Set<string>;
  /** Distinctive keywords (≥KEYWORD_MIN_LENGTH chars, not in stopword list). */
  keywords: Set<string>;
}

/** Overlap analysis between two ScopeSignals sets. */
export interface OverlapResult {
  filePaths: string[];
  identifiers: string[];
  keywords: string[];
  /** Number of signal TYPES with at least one match (0..3). */
  signalTypeCount: number;
  /** Total raw overlap-token count across all types. */
  totalTokenCount: number;
}

/** A single (todo-child, delivering-sibling) candidate pair surfaced by the detector. */
export interface EpicStalenessCandidate {
  todoChildId: string;
  todoChildTitle: string;
  todoChildStatus: string;
  todoChildCreatedAt: Date | undefined;
  deliveringSiblingId: string;
  deliveringSiblingTitle: string;
  deliveringSiblingDeliveredAt: Date | undefined;
  overlap: OverlapResult;
}

/** Configurable options for `detectEpicDecompositionStaleness`. */
export interface DetectorOptions {
  /** Window for "recent delivery" (default: 30 days). */
  recencyWindowDays?: number;
  /** Statuses to treat as open candidates (default: TODO, PLANNING). */
  todoStatuses?: readonly string[];
  /** Statuses to treat as deliveries (default: DONE). */
  deliveryStatuses?: readonly string[];
  /** Minimum signal types that must overlap to surface (default: 1). */
  minOverlapSignals?: number;
  /**
   * Optional "now" override — useful for tests. Defaults to `new Date()`.
   * Used for the recency-window calculation.
   */
  now?: Date;
}

// ---------------------------------------------------------------------------
// Scope-signal extraction
// ---------------------------------------------------------------------------

/**
 * Extract the `## Scope` → `**In scope:**` section text from a spec.
 *
 * Looks for the literal heading `## Scope` and scans the body until the next
 * `## ` heading. Within that body, looks for an `In scope` marker (case-
 * insensitive, surrounded by `**` or other markdown emphasis) and returns
 * everything until the next emphasis marker (`**Out of scope`, `**Acceptance`,
 * etc.) or the end of the section.
 *
 * Returns empty string if no scope section found.
 */
export function extractInScopeText(spec: string): string {
  if (!spec) return "";

  // Find the `## Scope` heading
  const scopeHeadingMatch = /^##\s+Scope\b/im.exec(spec);
  if (!scopeHeadingMatch) return "";

  // Body starts after the heading line, ends at next `## ` heading
  const bodyStart = scopeHeadingMatch.index + scopeHeadingMatch[0].length;
  const remainder = spec.slice(bodyStart);
  const nextHeadingMatch = /\n##\s+/.exec(remainder);
  const bodyEnd = nextHeadingMatch ? nextHeadingMatch.index : remainder.length;
  const scopeBody = remainder.slice(0, bodyEnd);

  // Within the scope body, locate "In scope" marker
  const inScopeMatch = /\*?\*?in\s+scope:?\*?\*?/i.exec(scopeBody);
  if (!inScopeMatch) {
    // No explicit "In scope" subsection — return the whole scope body
    return scopeBody;
  }

  const inScopeStart = inScopeMatch.index + inScopeMatch[0].length;
  const afterInScope = scopeBody.slice(inScopeStart);

  // End at "Out of scope" marker, "Acceptance" marker, or next bold heading
  const endMatch = /\*?\*?(out\s+of\s+scope|acceptance|context):?\*?\*?/i.exec(afterInScope);
  const inScopeEnd = endMatch ? endMatch.index : afterInScope.length;

  return afterInScope.slice(0, inScopeEnd);
}

/**
 * Extract scope signals from a spec.
 *
 * Pure function — given the same spec, returns the same signals. The
 * extraction strategy is intentionally simple (regex + token splitting)
 * because v0.1 calibration shows it suffices for the mt#1552 cluster.
 */
export function extractScopeSignals(spec: string): ScopeSignals {
  const text = extractInScopeText(spec);
  if (!text) {
    return { filePaths: new Set(), identifiers: new Set(), keywords: new Set() };
  }

  return {
    filePaths: extractFilePaths(text),
    identifiers: extractIdentifiers(text),
    keywords: extractKeywords(text),
  };
}

/** Extract file paths from a text fragment. */
function extractFilePaths(text: string): Set<string> {
  const paths = new Set<string>();

  const pathPattern =
    /([a-zA-Z0-9_.][\w./-]*\/[\w./-]+\.(tsx|ts|jsx|js|mjs|cjs|mdc|md|sql|json|yaml|yml|sh|py|go|rs|toml|css|html))/gi;

  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(text)) !== null) {
    const captured = match[1];
    if (captured !== undefined) paths.add(captured.toLowerCase());
  }

  return paths;
}

/** Extract identifier-like tokens (camelCase, snake_case, multi-word). */
function extractIdentifiers(text: string): Set<string> {
  const idents = new Set<string>();

  const camelOrSnake =
    /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9_]*|[A-Z][a-zA-Z0-9]+[A-Z][a-zA-Z0-9_]*|[a-zA-Z][a-zA-Z0-9]*_[a-zA-Z0-9_]+)\b/g;
  const kebabCase = /\b([a-z][a-z0-9]+-[a-z][a-z0-9-]*[a-z0-9])\b/g;

  let m: RegExpExecArray | null;
  while ((m = camelOrSnake.exec(text)) !== null) {
    const captured = m[1];
    if (captured !== undefined && captured.length >= IDENTIFIER_MIN_LENGTH) {
      idents.add(captured.toLowerCase());
    }
  }
  while ((m = kebabCase.exec(text)) !== null) {
    const captured = m[1];
    if (
      captured !== undefined &&
      captured.length >= IDENTIFIER_MIN_LENGTH &&
      captured.split("-").length >= 2
    ) {
      idents.add(captured.toLowerCase());
    }
  }

  return idents;
}

/** Extract distinctive keywords (lowercase words, length ≥5, not in stopword list). */
function extractKeywords(text: string): Set<string> {
  const counts = new Map<string, number>();

  const wordPattern = /\b([a-zA-Z][a-zA-Z]{4,})\b/g;
  let m: RegExpExecArray | null;
  while ((m = wordPattern.exec(text)) !== null) {
    const captured = m[1];
    if (captured === undefined) continue;
    const word = captured.toLowerCase();
    if (word.length < KEYWORD_MIN_LENGTH) continue;
    if (KEYWORD_STOPWORDS.has(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }

  // Take top-N by frequency, breaking ties alphabetically for determinism
  const sorted = Array.from(counts.entries()).sort((a, b) => {
    const ac = a[1];
    const bc = b[1];
    if (bc !== ac) return bc - ac;
    return a[0].localeCompare(b[0]);
  });

  const top = sorted.slice(0, KEYWORD_MAX_PER_SPEC).map(([word]) => word);
  return new Set(top);
}

// ---------------------------------------------------------------------------
// Overlap analysis
// ---------------------------------------------------------------------------

/**
 * Compute the overlap between two ScopeSignals sets. Pure set-intersection
 * on each signal type, plus a count of how many signal types had any overlap.
 */
export function computeOverlap(a: ScopeSignals, b: ScopeSignals): OverlapResult {
  const filePaths = intersect(a.filePaths, b.filePaths);
  const identifiers = intersect(a.identifiers, b.identifiers);
  const keywords = intersect(a.keywords, b.keywords);

  const signalTypeCount =
    (filePaths.length > 0 ? 1 : 0) +
    (identifiers.length > 0 ? 1 : 0) +
    (keywords.length > 0 ? 1 : 0);

  return {
    filePaths,
    identifiers,
    keywords,
    signalTypeCount,
    totalTokenCount: filePaths.length + identifiers.length + keywords.length,
  };
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const out: string[] = [];
  for (const v of a) if (b.has(v)) out.push(v);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect epic-decomposition-staleness candidates among an epic's children.
 *
 * Pure function. Caller is responsible for:
 *   1. Walking the epic's children via TaskGraphService.listChildren
 *   2. Fetching each child's status/timestamps/spec
 *   3. Assembling EpicChildSnapshot[] and passing it here.
 *
 * Returns candidate (todo, delivery) pairs where:
 *   - todo.status ∈ todoStatuses (default: TODO | PLANNING)
 *   - delivery.status ∈ deliveryStatuses (default: DONE)
 *   - delivery.updatedAt is within recencyWindowDays of `now`
 *   - todo.createdAt < delivery.updatedAt (filed before delivery shipped)
 *   - scope overlap on at least `minOverlapSignals` distinct signal types
 */
export function detectEpicDecompositionStaleness(
  children: EpicChildSnapshot[],
  options?: DetectorOptions
): EpicStalenessCandidate[] {
  const recencyWindowDays = options?.recencyWindowDays ?? DEFAULT_RECENCY_WINDOW_DAYS;
  const todoStatuses = options?.todoStatuses ?? DEFAULT_TODO_STATUSES;
  const deliveryStatuses = options?.deliveryStatuses ?? DEFAULT_DELIVERY_STATUSES;
  const minOverlapSignals = options?.minOverlapSignals ?? DEFAULT_MIN_OVERLAP_SIGNALS;
  const now = options?.now ?? new Date();

  const recencyCutoff = new Date(now.getTime() - recencyWindowDays * 24 * 60 * 60 * 1000);

  const todoSet = new Set(todoStatuses);
  const deliverySet = new Set(deliveryStatuses);

  // Partition
  const todoChildren = children.filter((c) => todoSet.has(c.status));
  const recentDeliveries = children.filter(
    (c) => deliverySet.has(c.status) && c.updatedAt !== undefined && c.updatedAt >= recencyCutoff
  );

  if (todoChildren.length === 0 || recentDeliveries.length === 0) {
    return [];
  }

  // Pre-compute scope signals once per child (avoids re-parsing on each pair)
  const todoSignals = new Map<string, ScopeSignals>();
  for (const c of todoChildren) todoSignals.set(c.id, extractScopeSignals(c.spec));

  const deliverySignals = new Map<string, ScopeSignals>();
  for (const c of recentDeliveries) deliverySignals.set(c.id, extractScopeSignals(c.spec));

  const candidates: EpicStalenessCandidate[] = [];

  for (const todo of todoChildren) {
    const todoSig = todoSignals.get(todo.id);
    if (!todoSig) continue;

    for (const delivery of recentDeliveries) {
      // Skip self-pair (defensive — todo and delivery have different statuses, but check anyway)
      if (todo.id === delivery.id) continue;

      // Require todo filed before delivery shipped
      if (
        todo.createdAt !== undefined &&
        delivery.updatedAt !== undefined &&
        todo.createdAt > delivery.updatedAt
      ) {
        continue;
      }

      const deliverySig = deliverySignals.get(delivery.id);
      if (!deliverySig) continue;

      const overlap = computeOverlap(todoSig, deliverySig);

      if (overlap.signalTypeCount < minOverlapSignals) continue;

      candidates.push({
        todoChildId: todo.id,
        todoChildTitle: todo.title,
        todoChildStatus: todo.status,
        todoChildCreatedAt: todo.createdAt,
        deliveringSiblingId: delivery.id,
        deliveringSiblingTitle: delivery.title,
        deliveringSiblingDeliveredAt: delivery.updatedAt,
        overlap,
      });
    }
  }

  // Sort by todo-child id, then by overlap strength (descending)
  candidates.sort((a, b) => {
    if (a.todoChildId !== b.todoChildId) return a.todoChildId.localeCompare(b.todoChildId);
    if (a.overlap.signalTypeCount !== b.overlap.signalTypeCount) {
      return b.overlap.signalTypeCount - a.overlap.signalTypeCount;
    }
    return b.overlap.totalTokenCount - a.overlap.totalTokenCount;
  });

  return candidates;
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const __TEST_ONLY = {
  extractFilePaths,
  extractIdentifiers,
  extractKeywords,
  KEYWORD_STOPWORDS,
  KEYWORD_MIN_LENGTH,
  KEYWORD_MAX_PER_SPEC,
  IDENTIFIER_MIN_LENGTH,
} as const;
