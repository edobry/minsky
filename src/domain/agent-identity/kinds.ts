/**
 * Kind normalization table for agent identity (ADR-006).
 *
 * Maps `clientInfo.name` values to reverse-domain `kind` strings.
 * Used by the Layer 1 ascribed resolver and the format module.
 */

/**
 * Known kind values per ADR-006 normalization table.
 * These are the canonical kind strings used in agentId format.
 */
export const KNOWN_KINDS = {
  CLAUDE_CODE: "com.anthropic.claude-code",
  CODEX: "com.openai.codex",
  CURSOR: "com.cursor.cursor",
  ZED: "app.zed.zed",
  MINSKY_NATIVE_SUBAGENT: "minsky.native-subagent",
  GITHUB_APP: "github-app",
  UNKNOWN: "unknown",
} as const;

export type KnownKind = (typeof KNOWN_KINDS)[keyof typeof KNOWN_KINDS];

/**
 * Mapping from clientInfo.name values to reverse-domain kind strings.
 * Empirically verified: claude-code from live capture (Claude Code 2.1.117).
 * Other entries from published docs or expected convention.
 */
const CLIENT_INFO_NAME_TO_KIND: Record<string, KnownKind> = {
  // Claude Code — empirically confirmed from live capture (mt#953)
  "claude-code": KNOWN_KINDS.CLAUDE_CODE,
  // OpenAI Codex — from OpenAI docs
  "codex-tui": KNOWN_KINDS.CODEX,
  codex_vscode: KNOWN_KINDS.CODEX,
  // Cursor — expected convention (clientInfo.name not yet empirically verified)
  cursor: KNOWN_KINDS.CURSOR,
  // Zed — expected convention (clientInfo.name not yet empirically verified)
  zed: KNOWN_KINDS.ZED,
};

/**
 * Normalize a clientInfo.name to a reverse-domain kind string.
 *
 * Returns the known kind if recognized, otherwise "unknown".
 * The "unknown" fallback ensures a valid agentId is always produced
 * even for harnesses not yet in the normalization table.
 */
export function normalizeClientInfoNameToKind(clientInfoName: string | undefined): KnownKind {
  if (!clientInfoName) return KNOWN_KINDS.UNKNOWN;
  const normalized = clientInfoName.trim().toLowerCase();
  return CLIENT_INFO_NAME_TO_KIND[normalized] ?? KNOWN_KINDS.UNKNOWN;
}

/**
 * Validate that a string is a valid kind value.
 * Accepts any reverse-domain string — not just ones in the table —
 * so that forward-compatible format round-trips pass validation.
 *
 * A valid kind:
 * - Non-empty
 * - No whitespace
 * - Only printable ASCII except `:` and `@` (reserved as delimiters in the format)
 */
export function isValidKind(kind: string): boolean {
  if (!kind || kind.length === 0) return false;
  // Must not contain format delimiters or whitespace
  return /^[^\s:@]+$/.test(kind);
}
