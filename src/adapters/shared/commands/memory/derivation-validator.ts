/**
 * Derivation-Discipline Validator
 *
 * Checks whether a memory's content appears to be derivable from a
 * first-order source (code, git history, task specs, rules, quoted blocks)
 * rather than representing a genuine cross-conversation insight.
 *
 * Per mt#960 rubric: memories should capture context that is NOT already
 * recoverable from code/specs/rules. If the validator fires, the caller
 * should surface the error and require an explicit `force: true` to proceed.
 *
 * @see mt#960 Memory quality rubric
 * @see mt#1007 MCP + CLI command surface (caller)
 */

export interface DerivationIssue {
  /** Category of the first-order source the content appears to derive from */
  source: "code" | "git" | "task" | "rule" | "quoted";
  /** Human-readable description of why the content was flagged */
  message: string;
}

// ─── Heuristic regexes (case-insensitive) ────────────────────────────────────

/** Matches content that refers to a named code artifact. */
const CODE_RE = /^The (file|function|class|method|variable|constant|type|interface)\s+/i;

/** Matches content that cites a specific git commit hash. */
const GIT_COMMIT_RE = /^The commit\s+[a-f0-9]{7,40}\b/i;

/** Matches content that references git command output. */
const GIT_OUTPUT_RE = /^Git (log|blame|status|diff)\s+(shows|says|output)/i;

/** Matches content that refers to a task by its identifier. */
const TASK_RE = /^Task\s+(mt|md|gh)#\d+\s+(status|spec|title)/i;

/** Matches content that cites a named rule. */
const RULE_RE = /^Rule\s+["']?[^"']+["']?\s+says/i;

// ─── Fenced-block ratio helper ────────────────────────────────────────────────

/**
 * Returns the fraction of the content's total characters that live inside
 * fenced code blocks (``` ... ```).  A ratio > 0.9 suggests the memory is
 * merely quoting source material rather than synthesising insight.
 */
function fencedBlockRatio(content: string): number {
  const totalChars = content.length;
  if (totalChars === 0) return 0;

  let blockChars = 0;
  let insideBlock = false;

  // Split on triple-backtick delimiters (handles both opening and closing).
  const segments = content.split(/```/);

  for (let i = 0; i < segments.length; i++) {
    // Even-indexed segments are outside blocks; odd-indexed are inside.
    if (i % 2 === 1) {
      blockChars += (segments[i] ?? "").length;
      insideBlock = !insideBlock;
    }
  }

  // If an odd number of ``` markers appear the last "block" is unclosed;
  // we still count those characters as block content.
  return blockChars / totalChars;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check whether `content` appears to be derivable from a first-order source.
 *
 * Returns a `DerivationIssue` describing the first match found, or `null` if
 * the content passes all heuristics.
 *
 * The check is intentionally lightweight (regex + ratio); it does not attempt
 * to resolve references or parse code.  False negatives are acceptable;
 * false positives should be overrideable via `force: true`.
 */
export function checkDerivation(content: string): DerivationIssue | null {
  const trimmed = content.trimStart();

  if (CODE_RE.test(trimmed)) {
    return {
      source: "code",
      message:
        "This appears derivable from code. Memories should capture cross-conversation " +
        "context not in code/specs/rules. See mt#960 rubric.",
    };
  }

  if (GIT_COMMIT_RE.test(trimmed)) {
    return {
      source: "git",
      message:
        "This appears derivable from git. Memories should capture cross-conversation " +
        "context not in code/specs/rules. See mt#960 rubric.",
    };
  }

  if (GIT_OUTPUT_RE.test(trimmed)) {
    return {
      source: "git",
      message:
        "This appears derivable from git. Memories should capture cross-conversation " +
        "context not in code/specs/rules. See mt#960 rubric.",
    };
  }

  if (TASK_RE.test(trimmed)) {
    return {
      source: "task",
      message:
        "This appears derivable from task. Memories should capture cross-conversation " +
        "context not in code/specs/rules. See mt#960 rubric.",
    };
  }

  if (RULE_RE.test(trimmed)) {
    return {
      source: "rule",
      message:
        "This appears derivable from rule. Memories should capture cross-conversation " +
        "context not in code/specs/rules. See mt#960 rubric.",
    };
  }

  if (fencedBlockRatio(content) > 0.9) {
    return {
      source: "quoted",
      message:
        "This appears derivable from quoted. Memories should capture cross-conversation " +
        "context not in code/specs/rules. See mt#960 rubric.",
    };
  }

  return null;
}
