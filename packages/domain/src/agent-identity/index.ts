/**
 * Agent identity module (ADR-006).
 *
 * Implements the layered agent identity scheme for MCP callers:
 *   Layer 1 (ascribed)  — from clientInfo + process signals
 *   Layer 2 (declared)  — from _meta["io.minsky/agent_id"]
 *   Layer 3 (enforced)  — reserved slot (TODO: see resolve.ts)
 *
 * Primary entry point: `resolveAgentId(inputs)` → agentId string.
 */

// Format (parser/serializer)
export { parseAgentId, serializeAgentId, isValidAgentId } from "./format";
export type { ParsedAgentId, AgentIdScope } from "./format";

// Kind normalization
export { normalizeClientInfoNameToKind, isValidKind, KNOWN_KINDS } from "./kinds";
export type { KnownKind } from "./kinds";

// Layer 1 — ascribed
export { resolveLayer1, buildLayer1HashId, getDefaultProcessSignals } from "./layer1";
export type { ClientInfo, ProcessSignals, Layer1Config } from "./layer1";

// Layer 2 — declared
export { readLayer2, AGENT_ID_META_KEY } from "./layer2";
export type { RequestExtras, RequestMeta } from "./layer2";

// Layer 2 — the ordered key list the declared layer resolves from (mt#3986)
export {
  readDeclaredIdentity,
  buildDeclaredIdentityKeys,
  DEFAULT_DECLARED_IDENTITY_KEYS,
} from "./declared";
export type { DeclaredIdentityKey, DeclaredIdentityHit, DeclaredKeyForm } from "./declared";

// W3C Baggage codec for the reserved `_meta.baggage` key (mt#3986)
export {
  BAGGAGE_META_KEY,
  GEN_AI_CONVERSATION_ID_KEY,
  MAX_BAGGAGE_MEMBERS,
  MAX_BAGGAGE_BYTES,
  parseBaggage,
  readBaggageEntry,
  appendBaggageEntry,
  encodeBaggageValue,
} from "./baggage";

// Priority resolver
export { resolveAgentId, resolveAgentIdParsed, resolveAgentIdWithLayer } from "./resolve";
export type {
  ResolveAgentIdInputs,
  AgentIdResolution,
  IdentityFallbackEvent,
  IdentityLayer,
} from "./resolve";

// Caller identity as seen by a registered command (server-injected, else harness env)
export { resolveCallerActorId } from "./caller";
