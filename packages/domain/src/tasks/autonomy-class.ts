/**
 * Computed autonomy class (mt#5130, Prioritization Phase 1c).
 *
 * Every open task resolves to one of `principal-gated` / `pull-only` /
 * `contained`, COMPUTED from signals by this pure module and never stored as a
 * writable field — so a producer (the EngProd miner, a handoff, any agent-filed
 * task) cannot self-authorize (RFC 3ae937f0 §"Autonomy is a computed floor,
 * default-deny, with principal-gated dominant"). The consumers —
 * `TaskRoutingService` behind `tasks_available`/`tasks_route`, and the
 * pointing candidate set — read the class here and default to deny:
 * `principal-gated` and `unknown` are never served.
 *
 * Dominance is the rule order in `computeAutonomyClass`: any principal-gated
 * signal wins, `contained` needs every one of its conjuncts, `pull-only` is the
 * else branch, and `unknown` is reserved for inputs that were not available
 * (spec signals not loaded) — never a default for a well-formed task.
 *
 * The DB shell that loads the two spec sections in bulk is
 * `autonomy-class-store.ts`; this file is what the unit tests exercise.
 */

import {
  CONFIG_SURFACE_PATTERNS,
  LOCAL_APP_DEPLOY_SURFACE_PATTERNS,
} from "../deployment/deploy-surface";
import { POINTING_AUTONOMY_CLASSES } from "../storage/schemas/pointings-schema";

export const TASK_AUTONOMY_CLASSES = [...POINTING_AUTONOMY_CLASSES, "unknown"] as const;
export type TaskAutonomyClass = (typeof TASK_AUTONOMY_CLASSES)[number];

/** A class a consumer may serve without a person in the loop. */
export function isServableClass(cls: TaskAutonomyClass): boolean {
  return cls === "pull-only" || cls === "contained";
}

export interface AutonomyClassResult {
  class: TaskAutonomyClass;
  /** Human-readable, one per signal that decided the class. */
  reasons: string[];
}

/**
 * The spec-derived inputs. `null` for a section means the spec exists and the
 * section is absent; the whole object is `undefined` when the spec was not
 * loaded at all, which is the one condition that yields `unknown`.
 */
export interface AutonomySpecSignals {
  /** The `## Scope` section body. */
  scope: string | null;
  /** The `## Summary` section body (capped by the loader). */
  summary: string | null;
  /** The spec's `Origin:` line, when present. */
  origin: string | null;
}

export interface AutonomyInput {
  id: string;
  kind: string | null | undefined;
  status: string;
  tags: readonly string[];
  title: string;
  spec: AutonomySpecSignals | undefined;
  /**
   * Human-origin evidence. `undefined` means no evidence exists — today's
   * production value, since nothing records a task's origin (mt#5136 adds
   * it). Default-deny applies to the signal itself: only `true` can reach
   * `contained`.
   */
  humanOrigin: boolean | undefined;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

/** A tag that marks a task as a decision the principal reserves. */
export const PRINCIPAL_GATED_TAGS = [
  "rfc",
  "adr",
  "naming",
  "product-surface",
  "vendor",
  "engprod-proposal",
] as const;

/**
 * Markers of a principal-reserved category (`principal-context.mdc §Decisions
 * Eugene reserves`) as they appear in a title or Summary. Deliberately narrow:
 * measured on the 868-task default population (2026-09-13) this set gates 56;
 * a broad set with `name`/`architecture`/`product`/`production` gates 211 on
 * incidental prose. Matched as whole words, case-insensitive.
 */
export const PRINCIPAL_RESERVED_MARKERS = [
  "rename",
  "naming",
  "product name",
  "customer-facing",
  "product surface",
  "vendor",
  "paid plan",
  "signup",
  "pricing",
] as const;

const MARKER_RE = new RegExp(
  `\\b(${PRINCIPAL_RESERVED_MARKERS.map((m) => m.replace(/[-\s]/g, "[-\\s]")).join("|")})\\b`,
  "i"
);

/** `RFC:` / `ADR:` titles are decision records whether or not they carry the tag. */
const DECISION_RECORD_TITLE_RE = /^\s*(rfc|adr)\b/i;

const SECURITY_SURFACE_PATTERNS: readonly RegExp[] = [
  // Every workflow, not only deploy*.yml — CI is a security surface (gate (l) sub-case 1).
  /^\.github\/workflows\//,
  /^\.minsky\/hooks\//,
  /^\.claude\/hooks\//,
  /^packages\/domain\/src\/persistence\//,
  /^packages\/domain\/src\/storage\/migrations\//,
  /^drizzle\.pg\.config\.ts$/,
  /^packages\/domain\/src\/auth\//,
];

/**
 * The listed surface: deploy BOUNDARIES plus security surfaces. NOT
 * `isDeploySurfaceFile` — `DEPLOY_SURFACE_PATTERNS` carries `^src/` and
 * `^packages/domain/src/` for deploy verification (mt#4013), which as an
 * autonomy surface would gate every code task.
 */
export const AUTONOMY_LISTED_SURFACE_PATTERNS: readonly RegExp[] = [
  ...CONFIG_SURFACE_PATTERNS,
  ...LOCAL_APP_DEPLOY_SURFACE_PATTERNS,
  ...SECURITY_SURFACE_PATTERNS,
];

function normalisePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isListedSurface(path: string): boolean {
  const p = normalisePath(path);
  return AUTONOMY_LISTED_SURFACE_PATTERNS.some((re) => re.test(p));
}

/** A leaf that reads as a file even without a directory in front of it. */
const FILE_EXTENSION_RE = /\.(?:ts|tsx|js|mjs|json|md|mdc|ya?ml|toml|sql|sh)$/;

/**
 * Path-shaped tokens in free text: anything with a `/` in it, or a bare file
 * name with a known extension. Trailing punctuation and `:line` suffixes are
 * stripped so `packages/x/y.ts:42,` reads as `packages/x/y.ts`. A backticked
 * prose scope and a bullet list are read the same way.
 */
export function extractScopePaths(text: string | null | undefined): string[] {
  if (!text) return [];
  const out = new Set<string>();
  // Commas and braces split tokens on purpose: a comma-joined list is several
  // paths, and a brace glob is rare enough in a scope to read loosely.
  const tokenRe = /[A-Za-z0-9_.@*~/-]+/g;
  for (const m of text.matchAll(tokenRe)) {
    let tok = m[0].replace(/(?::\d+(?:[–-]\d+)?)?[.;:)]*$/, "");
    tok = normalisePath(tok).replace(/^\/+/, "");
    if (!tok || /^https?$/i.test(tok)) continue;
    if (tok.includes("/") || FILE_EXTENSION_RE.test(tok)) {
      // A URL host is not a repo path.
      if (/^[\w.-]+\.(?:com|io|so|dev|org|net|app)(?:\/|$)/i.test(tok)) continue;
      out.add(tok.replace(/\/+$/, ""));
    }
  }
  return [...out];
}

const DOCS_ONLY_RE = /^(?:docs\/|src\/generated\/)/;

/**
 * The ONE pattern for a `## <Heading>` section body up to the next `## `
 * heading, as a source string valid in both JS `RegExp` and a Postgres ARE
 * (`substring(col from pattern)` returns group 1). `autonomy-class-store.ts`
 * sends it to SQL; `extractSpecSection` compiles it here — one definition, so
 * the two paths cannot drift (PR #3746 R1).
 */
export function specSectionPattern(heading: string): string {
  return `(?:^|\\n)## ${heading}[^\\n]*\\n((?:[^\\n]|\\n(?!## ))*)`;
}

/** Same contract for the spec's `Origin:` line. */
export const SPEC_ORIGIN_PATTERN = "(?:^|\\n)(Origin:[^\\n]*)";

/** A `## <Heading>` section body — the TS side of `specSectionPattern`. */
export function extractSpecSection(content: string, heading: string): string | null {
  const m = new RegExp(specSectionPattern(heading)).exec(content);
  return m ? (m[1] ?? "") : null;
}

/** Spec signals from a whole spec's text — for a caller with no bulk loader. */
export function specSignalsFromContent(content: string): AutonomySpecSignals {
  const origin = new RegExp(SPEC_ORIGIN_PATTERN).exec(content);
  return {
    scope: extractSpecSection(content, "Scope"),
    summary: extractSpecSection(content, "Summary"),
    origin: origin ? (origin[1] ?? null) : null,
  };
}

/** Shapes the RFC names for `contained`, each as a predicate over the inputs. */
function containedShape(input: AutonomyInput, scopePaths: readonly string[]): string | null {
  const text = `${input.spec?.summary ?? ""}\n${input.spec?.scope ?? ""}`;
  if (/\b(reproduc\w*|regression|failing)[\s-]+test\b/i.test(text)) {
    return "bugfix with a reproducing test named in the spec";
  }
  if (input.tags.includes("incident") || /incident/i.test(input.spec?.origin ?? "")) {
    return "incident follow-up";
  }
  if (input.tags.includes("cleared-blocker")) return "cleared-blocker re-surface";
  if (scopePaths.length > 0 && scopePaths.every((p) => DOCS_ONLY_RE.test(p))) {
    return "docs-only or generated-only scope";
  }
  return null;
}

// ─── The classifier ──────────────────────────────────────────────────────────

export interface AutonomyClassDeps {
  isListedSurface?: (path: string) => boolean;
}

/**
 * Pure: task row + spec sections + origin evidence in, class + reasons out.
 * Rules in dominance order — see the module comment.
 */
export function computeAutonomyClass(
  input: AutonomyInput,
  deps: AutonomyClassDeps = {}
): AutonomyClassResult {
  const listed = deps.isListedSurface ?? isListedSurface;
  const gated: string[] = [];

  if (input.kind === "umbrella") gated.push("kind umbrella");
  if (input.kind === "state-ops") gated.push("kind state-ops: a shared-state operation");
  for (const tag of input.tags) {
    if ((PRINCIPAL_GATED_TAGS as readonly string[]).includes(tag)) gated.push(`tag ${tag}`);
  }
  if (DECISION_RECORD_TITLE_RE.test(input.title))
    gated.push("title is a decision record (RFC/ADR)");

  const scopePaths = extractScopePaths(input.spec?.scope);
  for (const p of scopePaths) {
    if (listed(p)) gated.push(`scope names listed surface ${p}`);
  }
  const markerText = input.spec ? `${input.title}\n${input.spec.summary ?? ""}` : input.title;
  const marker = MARKER_RE.exec(markerText);
  if (marker) gated.push(`principal-reserved marker "${marker[1]}"`);

  if (gated.length > 0) return { class: "principal-gated", reasons: gated };

  if (input.spec === undefined) {
    return { class: "unknown", reasons: ["spec signals unavailable"] };
  }
  if (input.kind === "work-package") {
    return { class: "pull-only", reasons: ["ADR-046: claimed deliberately"] };
  }

  const notContained: string[] = [];
  if (input.humanOrigin !== true) notContained.push("no human-origin evidence");
  if (input.status !== "READY") notContained.push(`status ${input.status} is not READY`);
  const shape = containedShape(input, scopePaths);
  if (!shape) notContained.push("no contained shape");
  if (notContained.length > 0) return { class: "pull-only", reasons: notContained };

  return {
    class: "contained",
    reasons: ["human origin", "READY", shape as string, "scope outside listed surfaces"],
  };
}

/** Per-class counts, the shape consumers report so an exclusion is visible. */
export interface ExcludedByClass {
  principalGated: number;
  unknown: number;
}

export function emptyExcludedByClass(): ExcludedByClass {
  return { principalGated: 0, unknown: 0 };
}

export function countExcluded(counts: ExcludedByClass, cls: TaskAutonomyClass): void {
  if (cls === "principal-gated") counts.principalGated++;
  else if (cls === "unknown") counts.unknown++;
}
