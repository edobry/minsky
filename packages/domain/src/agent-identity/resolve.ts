/**
 * Priority resolver for agent identity (ADR-006).
 *
 * Priority order (highest wins):
 *   Layer 3 (enforced hook) — reserved slot, not yet implemented
 *   Layer 2 (declared _meta) — wins if present and valid
 *   Layer 1 (ascribed process) — fallback, always produces a value
 *
 * TODO(layer-3): Layer 3 (Claude Code PreToolUse hook that injects session_id
 * into _meta["io.minsky/agent_id"]) is deferred to a separate follow-up task.
 * When implemented, pass it as `layer3Result` to resolveAgentId(). The slot
 * is already accepted as an optional parameter below.
 */

import { serializeAgentId, type ParsedAgentId } from "./format";
import { readLayer2, type RequestExtras } from "./layer2";
import { resolveLayer1, type ClientInfo, type ProcessSignals, type Layer1Config } from "./layer1";

/**
 * All inputs the resolver needs to determine the agentId.
 */
export interface ResolveAgentIdInputs {
  /** MCP request extras, containing _meta for Layer 2 */
  extras?: RequestExtras;
  /** MCP clientInfo from server.getClientVersion() */
  clientInfo?: ClientInfo;
  /** Process signals for Layer 1 hash (defaults to current process) */
  signals?: ProcessSignals;
  /** Layer 1 hostname-hashing config */
  layer1Config?: Layer1Config;
  /**
   * Layer 3 pre-resolved value (enforced hook result).
   * Reserved for future use — pass undefined until Layer 3 ships.
   * TODO(layer-3): populate from PreToolUse hook injection.
   */
  layer3Result?: ParsedAgentId;
}

/**
 * Resolve the agentId for an incoming MCP tool call.
 *
 * Returns the serialized agentId string (never null — Layer 1 always
 * produces a value as the last-resort fallback).
 */
export function resolveAgentId(inputs: ResolveAgentIdInputs): string {
  const parsed = resolveAgentIdParsed(inputs);
  // serializeAgentId returns null only for invalid ParsedAgentId — Layer 1 always returns valid
  return serializeAgentId(parsed) ?? _layer1Fallback(inputs);
}

/**
 * Resolve and return the parsed agentId (for callers that need structured access).
 */
export function resolveAgentIdParsed(inputs: ResolveAgentIdInputs): ParsedAgentId {
  // Layer 3 — enforced (reserved slot, not yet implemented)
  // TODO(layer-3): when the PreToolUse hook ships, layer3Result will be populated
  if (inputs.layer3Result) {
    return inputs.layer3Result;
  }

  // Layer 2 — declared via _meta
  const layer2 = readLayer2(inputs.extras);
  if (layer2) {
    return layer2;
  }

  // Layer 1 — ascribed fallback (always succeeds)
  return resolveLayer1(inputs.clientInfo, inputs.signals, inputs.layer1Config);
}

/**
 * Emergency fallback: re-run Layer 1 directly (used only if serialize fails, which
 * should not happen in practice since Layer 1 always returns a valid parsed id).
 */
function _layer1Fallback(inputs: ResolveAgentIdInputs): string {
  const parsed = resolveLayer1(inputs.clientInfo, inputs.signals, inputs.layer1Config);
  return `${parsed.kind}:${parsed.scope}:${parsed.id}`;
}
