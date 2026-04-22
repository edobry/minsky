/**
 * Parser and serializer for the agentId format defined in ADR-006.
 *
 * Format: `{kind}:{scope}:{id}[@{parent-agentId}]`
 *
 * Examples:
 *   com.anthropic.claude-code:proc:a1b2c3d4e5f6g7h8
 *   minsky.native-subagent:task:mt#123@com.anthropic.claude-code:proc:a1b2c3d4
 */

import { isValidKind } from "./kinds";

/**
 * Valid scope values per ADR-006.
 * - conv: conversation UUID
 * - run: execution run
 * - proc: process-level fallback (used by Layer 1)
 * - inst: installation
 * - hash: last-resort hash (used for "unknown" kind)
 */
export type AgentIdScope = "conv" | "run" | "proc" | "inst" | "hash";

const VALID_SCOPES: Set<string> = new Set<AgentIdScope>(["conv", "run", "proc", "inst", "hash"]);

/**
 * Parsed representation of an agentId.
 */
export interface ParsedAgentId {
  kind: string;
  scope: AgentIdScope;
  id: string;
  /** Optional parent agentId string (the raw string after `@`) */
  parent?: string;
}

/**
 * Parse an agentId string into its components.
 *
 * Returns `null` for any malformed input so callers can safely fall back
 * to Layer 1 without throwing.
 *
 * Malformed conditions:
 * - Does not match `{kind}:{scope}:{id}` pattern
 * - `kind` fails isValidKind()
 * - `scope` is not in the known scope set
 * - `id` is empty
 * - `@parent` suffix is present but empty
 */
export function parseAgentId(input: string): ParsedAgentId | null {
  if (!input || typeof input !== "string") return null;

  // Split off optional parent: everything after the first `@` is the parent agentId
  const atIdx = input.indexOf("@");
  let core: string;
  let parent: string | undefined;

  if (atIdx !== -1) {
    core = input.slice(0, atIdx);
    const rawParent = input.slice(atIdx + 1);
    if (!rawParent) return null; // `@` with empty parent is malformed
    parent = rawParent;
  } else {
    core = input;
  }

  // Core must be exactly three colon-separated segments
  const firstColon = core.indexOf(":");
  if (firstColon === -1) return null;

  const kind = core.slice(0, firstColon);
  const rest = core.slice(firstColon + 1);

  const secondColon = rest.indexOf(":");
  if (secondColon === -1) return null;

  const scope = rest.slice(0, secondColon);
  const id = rest.slice(secondColon + 1);

  // Validate each component
  if (!isValidKind(kind)) return null;
  if (!VALID_SCOPES.has(scope)) return null;
  if (!id || id.length === 0) return null;
  // id must not contain `@` (that would mean we mis-split)
  if (id.includes("@")) return null;

  return { kind, scope: scope as AgentIdScope, id, parent };
}

/**
 * Serialize a parsed agentId back to its canonical string form.
 *
 * Returns null if the input is not a valid parsed agentId.
 * Round-trips cleanly: `parseAgentId(serializeAgentId(parsed)) ≡ parsed`.
 */
export function serializeAgentId(parsed: ParsedAgentId): string | null {
  if (!parsed) return null;
  if (!isValidKind(parsed.kind)) return null;
  if (!VALID_SCOPES.has(parsed.scope)) return null;
  if (!parsed.id || parsed.id.length === 0) return null;

  const core = `${parsed.kind}:${parsed.scope}:${parsed.id}`;
  if (parsed.parent !== undefined) {
    if (!parsed.parent) return null; // empty parent is invalid
    return `${core}@${parsed.parent}`;
  }
  return core;
}

/**
 * Validate that a string is a well-formed agentId.
 * Convenience wrapper around `parseAgentId`.
 */
export function isValidAgentId(input: string): boolean {
  return parseAgentId(input) !== null;
}
