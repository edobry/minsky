/**
 * Priority resolver for agent identity (ADR-006).
 *
 * Priority order (highest wins):
 *   Layer 3 (enforced hook) — reserved slot, not yet implemented
 *   Layer 2 (declared `_meta`) — an ORDERED key list; first hit wins (mt#3986)
 *   Layer 1 (ascribed process) — fallback, always produces a value
 *
 * A note on the Layer 2/3 asymmetry, because it reads like a bug and is not.
 * The stdio proxy and the shim STAMP conversation identity, which ADR-006's
 * §Layer 3 amendment calls enforced — the writer always fires, with no caller
 * cooperation. The reader still resolves it at Layer 2, exactly as ADR-006
 * §Implementation Phase 2 says: a stamped id and a cooperating caller's
 * declared id are byte-identical at the same key, so nothing downstream can
 * tell them apart. The reader therefore reports which KEY answered, which does
 * carry information, alongside the layer, which cannot.
 *
 * TODO(layer-3): the `layer3Result` slot below stays reserved for a mechanism
 * that could distinguish an enforced identity from a declared one.
 */

import { serializeAgentId, type ParsedAgentId } from "./format";
import { type RequestExtras } from "./layer2";
import {
  readDeclaredIdentity,
  DEFAULT_DECLARED_IDENTITY_KEYS,
  type DeclaredIdentityKey,
} from "./declared";
import { resolveLayer1, type ClientInfo, type ProcessSignals, type Layer1Config } from "./layer1";

/** Which ADR-006 layer answered. */
export type IdentityLayer = 1 | 2 | 3;

/**
 * Emitted when resolution falls through every declared key to Layer 1 — the
 * moment conversation-scoped attribution stops being conversation-scoped.
 *
 * Delivered through an injected sink rather than a logger this module reaches
 * itself, so the event is observable in tests without patching anything, and so
 * the log POLICY (rate, level, redaction) belongs to the wiring rather than the
 * domain.
 */
export interface IdentityFallbackEvent {
  /** Every `_meta` key that was consulted, in order. */
  readonly keysTried: readonly string[];
  /** The layer that ultimately answered. */
  readonly layer: IdentityLayer;
  /** The resolved id. REDACT before logging — a conversation id is an attribution key. */
  readonly agentId: string;
}

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
   * The ordered `_meta` key list to resolve declared identity from.
   * Defaults to `DEFAULT_DECLARED_IDENTITY_KEYS`; pass the result of
   * `buildDeclaredIdentityKeys(<configured protocol key>)` to extend it.
   */
  declaredKeys?: readonly DeclaredIdentityKey[];
  /** Notified when resolution falls through to Layer 1. */
  onFallback?: (event: IdentityFallbackEvent) => void;
  /**
   * Layer 3 pre-resolved value (enforced hook result).
   * Reserved for future use — pass undefined until Layer 3 ships.
   */
  layer3Result?: ParsedAgentId;
}

/** A resolution plus the provenance a caller needs to log or audit it. */
export interface AgentIdResolution {
  readonly agentId: string;
  readonly parsed: ParsedAgentId;
  readonly layer: IdentityLayer;
  /** The `_meta` key that answered, or null when Layer 1 or Layer 3 answered. */
  readonly keyThatAnswered: string | null;
  readonly keysTried: readonly string[];
}

/**
 * Resolve the agentId for an incoming MCP tool call, reporting where it came
 * from.
 *
 * This is the implementation the other two entry points delegate to; the
 * fallback sink fires exactly once per call regardless of which one is used.
 */
export function resolveAgentIdWithLayer(inputs: ResolveAgentIdInputs): AgentIdResolution {
  const declaredKeys = inputs.declaredKeys ?? DEFAULT_DECLARED_IDENTITY_KEYS;
  const keysTried = declaredKeys.map((k) => k.key);

  // Layer 3 — enforced (reserved slot, not yet implemented)
  if (inputs.layer3Result) {
    const agentId = serializeAgentId(inputs.layer3Result);
    if (agentId) {
      return {
        agentId,
        parsed: inputs.layer3Result,
        layer: 3,
        keyThatAnswered: null,
        keysTried: [],
      };
    }
  }

  // Layer 2 — declared, resolved from the ordered key list
  const declared = readDeclaredIdentity(inputs.extras, declaredKeys, inputs.clientInfo?.name);
  if (declared) {
    const agentId = serializeAgentId(declared.parsed);
    if (agentId) {
      return {
        agentId,
        parsed: declared.parsed,
        layer: 2,
        keyThatAnswered: declared.key,
        keysTried,
      };
    }
  }

  // Layer 1 — ascribed fallback (always succeeds).
  //
  // Reached three ways: no declared key answered, OR a higher layer produced a
  // parsed id that would not serialize. The second case falls through here
  // rather than pairing a Layer 1 STRING with a Layer 2 `parsed` and
  // `layer: 2` — a resolution whose three fields disagree is exactly the
  // silent-misattribution shape this task exists to eliminate, and it would
  // also skip the fallback notification (PR #2877 R1).
  const parsed = resolveLayer1(inputs.clientInfo, inputs.signals, inputs.layer1Config);
  const agentId = serializeAgentId(parsed) ?? `${parsed.kind}:${parsed.scope}:${parsed.id}`;

  inputs.onFallback?.({ keysTried, layer: 1, agentId });

  return { agentId, parsed, layer: 1, keyThatAnswered: null, keysTried };
}

/**
 * Resolve the agentId for an incoming MCP tool call.
 *
 * Returns the serialized agentId string (never null — Layer 1 always
 * produces a value as the last-resort fallback).
 */
export function resolveAgentId(inputs: ResolveAgentIdInputs): string {
  return resolveAgentIdWithLayer(inputs).agentId;
}

/**
 * Resolve and return the parsed agentId (for callers that need structured access).
 */
export function resolveAgentIdParsed(inputs: ResolveAgentIdInputs): ParsedAgentId {
  return resolveAgentIdWithLayer(inputs).parsed;
}
