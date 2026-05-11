/**
 * Fixed-schema adoption signal extraction from task spec text.
 *
 * v1 design: deterministic regex patterns over spec text, no LLM extraction.
 * Each pattern targets a specific kind of adoption-relevant code artifact
 * that can be grepped in the codebase to detect consumer callsites.
 *
 * ## Signal kinds
 *
 * - `function`  — exported function declarations (`export function foo` /
 *                 `export async function foo`)
 * - `class`     — exported class declarations (`export class Foo`)
 * - `hook`      — webhooks.on() registrations (`webhooks.on("event.action"`)
 * - `mcpTool`   — MCP tool command IDs (`id: "session.list"` etc.)
 * - `commandId` — command registry IDs in the same form as mcpTool but
 *                 captured via `commandId:` or `id:` key patterns
 * - `lifecycleState` — task/session lifecycle state references (`STATUS.DONE`,
 *                      `TaskStatus.IN_PROGRESS`, etc.)
 *
 * ## v1 scope note
 *
 * LLM-based extraction is out of scope for v1. The patterns here trade
 * recall (some signals may be missed) for precision (zero false positives
 * from hallucination). Once false-negative rates are measured in production,
 * LLM extraction can be layered on top as a v2 supplement. Tracking task:
 * file when v1 adoption gaps have empirical data.
 *
 * ## TOCTOU note
 *
 * `extractAdoptionSignals` is a pure function over a string. No external
 * state is read or mutated; TOCTOU analysis is N/A for this module.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The kind of adoption signal extracted from a spec. */
export type AdoptionSignalKind =
  | "function"
  | "class"
  | "hook"
  | "mcpTool"
  | "commandId"
  | "lifecycleState";

/** A single adoption signal extracted from a spec body. */
export interface AdoptionSignal {
  /** What kind of artifact this signal represents. */
  kind: AdoptionSignalKind;
  /** The name / identifier extracted from the spec text. */
  name: string;
  /** 1-based line number in the spec where this signal was found. */
  sourceLine: number;
}

// ---------------------------------------------------------------------------
// Extraction patterns
// ---------------------------------------------------------------------------

/**
 * Patterns for each signal kind.
 *
 * Each entry is: [kind, pattern, captureGroupIndex].
 * The pattern is applied line-by-line. captureGroupIndex selects which regex
 * capture group holds the signal name.
 *
 * Patterns are purposefully narrow to avoid false positives. Spec prose often
 * contains code examples; only lines that look like actual declarations are
 * matched.
 */
const SIGNAL_PATTERNS: Array<[AdoptionSignalKind, RegExp, number]> = [
  // export function foo / export async function foo
  // Allow leading whitespace so indented code blocks (fenced under markdown
  // with leading spaces) are matched too. PR #1034 R1 NB1.
  ["function", /^\s*export\s+(?:async\s+)?function\s+(\w+)/, 1],
  // export class Foo
  ["class", /^\s*export\s+class\s+(\w+)/, 1],
  // webhooks.on("event.action") — hook registrations
  ["hook", /webhooks\.on\(\s*["']([^"']+)["']/, 1],
  // id: "session.list" / id: "tasks.get" — MCP tool IDs (dot-separated namespaced form)
  // Matches quoted strings that look like <namespace>.<command>
  ["mcpTool", /\bid\s*:\s*["']([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)["']/, 1],
  // commandId: "session.list" (explicit commandId key)
  ["commandId", /\bcommandId\s*:\s*["']([^"']+)["']/, 1],
  // STATUS.DONE / TaskStatus.IN_PROGRESS / SessionStatus.MERGED etc.
  // Captures the full qualified reference (e.g. "STATUS.DONE", "TaskStatus.IN_REVIEW")
  ["lifecycleState", /\b(?:STATUS|TaskStatus|SessionStatus|Status)\.([A-Z_][A-Z0-9_]*)/, 1],
];

// ---------------------------------------------------------------------------
// Main extraction function
// ---------------------------------------------------------------------------

/**
 * Extract adoption signals from a task spec string (fixed-schema, no LLM).
 *
 * @param specText - Full text of the task spec (markdown).
 * @returns Array of extracted signals. May be empty if no patterns match.
 */
export function extractAdoptionSignals(specText: string): AdoptionSignal[] {
  const signals: AdoptionSignal[] = [];
  // Track seen (kind+name) pairs to deduplicate signals from the same spec.
  const seen = new Set<string>();

  const lines = specText.split("\n");

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx] ?? "";
    const sourceLine = lineIdx + 1; // 1-based

    for (const [kind, pattern, captureGroup] of SIGNAL_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;

      const name = match[captureGroup];
      if (!name) continue;

      // Deduplicate: same kind+name from different lines counts as one signal.
      const key = `${kind}:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      signals.push({ kind, name, sourceLine });
    }
  }

  return signals;
}

// ---------------------------------------------------------------------------
// Grep pattern builder (for sweeper to use when searching callsites)
// ---------------------------------------------------------------------------

/**
 * Build a codebase grep pattern for a given adoption signal.
 *
 * The returned pattern is intended for use with a case-sensitive grep
 * over source files. It targets the most common callsite form for each
 * signal kind.
 *
 * @returns A string suitable as a grep pattern (not anchored, not a full
 *          regex — callers are responsible for scoping to source files).
 */
export function buildGrepPattern(signal: AdoptionSignal): string {
  switch (signal.kind) {
    case "function":
      // Direct call: functionName( OR import { functionName }
      return signal.name;
    case "class":
      // new ClassName( OR extends ClassName
      return signal.name;
    case "hook":
      // webhooks.on("event.action") or on("event.action")
      return `"${signal.name}"`;
    case "mcpTool":
    case "commandId":
      // id: "session.list" or "session.list" in a registration table
      return `"${signal.name}"`;
    case "lifecycleState":
      // STATUS.DONE or TaskStatus.DONE
      return `.${signal.name}`;
  }
}
