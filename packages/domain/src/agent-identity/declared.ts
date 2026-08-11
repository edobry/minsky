/**
 * Ordered key resolution for declared agent identity (mt#3986, ADR-006).
 *
 * Layer 2 used to be one hardcoded `_meta` key. This module makes it a LIST, so
 * the process that writes conversation identity onto the wire is a replaceable
 * writer rather than the only one. The read order is:
 *
 *   1. `_meta["io.minsky/agent_id"]` — a full `{kind}:{scope}:{id}` agentId
 *   2. `_meta["baggage"]` carrying `gen_ai.conversation.id` — a bare conversation id
 *   3. a CONFIGURED `io.modelcontextprotocol/*` key — a bare conversation id
 *
 * First hit wins. Slot 3 is configured rather than hardcoded because no such
 * key exists yet: the 2026-07-28 revision reserves the
 * `io.modelcontextprotocol/` prefix and defines `protocolVersion`, `clientInfo`,
 * `clientCapabilities`, `logLevel`, `subscriptionId` and `serverInfo` under it —
 * none of which carries a conversation identifier. Guessing a name would encode
 * a fact that is not true yet.
 *
 * Forms 2 and 3 carry only an ID, where form 1 carries a whole agentId, so they
 * synthesize the missing parts: the kind comes from `clientInfo` via the same
 * normalization Layer 1 uses, and degrades to `unknown` when `clientInfo` is
 * absent — which the 2026-07-28 revision makes possible per request, since
 * `io.modelcontextprotocol/clientInfo` is optional. A degraded KIND is still a
 * conversation-SCOPED identity, which is the property everything downstream
 * actually keys on; it is not a Layer 1 fallback.
 *
 * @see docs/architecture/adr-006-agent-identity.md
 * @see ./baggage.ts — the W3C Baggage codec and its primary-source citations
 */

import { parseAgentId, type ParsedAgentId } from "./format";
import { normalizeClientInfoNameToKind } from "./kinds";
import { AGENT_ID_META_KEY, type RequestExtras, type RequestMeta } from "./layer2";
import { BAGGAGE_META_KEY, GEN_AI_CONVERSATION_ID_KEY, readBaggageEntry } from "./baggage";

/**
 * How to interpret the value found at a `_meta` key.
 *
 * - `agent-id` — the value IS a serialized agentId
 * - `baggage` — the value is a W3C baggage-string; read `entry` out of it
 * - `conversation-id` — the value is a bare conversation id
 */
export type DeclaredKeyForm = "agent-id" | "baggage" | "conversation-id";

export interface DeclaredIdentityKey {
  /** The `_meta` key to read. */
  readonly key: string;
  readonly form: DeclaredKeyForm;
  /** Which baggage entry to read. Only meaningful for `form: "baggage"`. */
  readonly entry?: string;
}

/**
 * The resolution order, as data.
 *
 * Order is the contract: `io.minsky/agent_id` stays first because a caller that
 * declares a full agentId is more specific than one that only names a
 * conversation — a Minsky-dispatched subagent declares its own grain and must
 * not be overwritten by the conversation it happens to run inside.
 */
export const DEFAULT_DECLARED_IDENTITY_KEYS: readonly DeclaredIdentityKey[] = [
  { key: AGENT_ID_META_KEY, form: "agent-id" },
  { key: BAGGAGE_META_KEY, form: "baggage", entry: GEN_AI_CONVERSATION_ID_KEY },
];

/** Prefixes the MCP spec reserves for its own use. */
const RESERVED_MCP_PREFIXES = ["io.modelcontextprotocol/", "dev.mcp/"];

/**
 * Build the key list, optionally appending a protocol-native key.
 *
 * The protocol key is rejected unless it sits under a prefix MCP actually
 * reserves — configuring an arbitrary key here would let a caller-controlled
 * `_meta` field name identity, which is a different (and unreviewed) threat
 * model from the reserved-prefix one this slot was designed for.
 */
export function buildDeclaredIdentityKeys(protocolKey?: string): readonly DeclaredIdentityKey[] {
  if (!protocolKey) return DEFAULT_DECLARED_IDENTITY_KEYS;

  const trimmed = protocolKey.trim();
  const isReserved = RESERVED_MCP_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  if (!isReserved) return DEFAULT_DECLARED_IDENTITY_KEYS;

  return [...DEFAULT_DECLARED_IDENTITY_KEYS, { key: trimmed, form: "conversation-id" }];
}

export interface DeclaredIdentityHit {
  readonly parsed: ParsedAgentId;
  /** Which `_meta` key produced this identity. */
  readonly key: string;
}

function readMeta(extras: RequestExtras | undefined): RequestMeta | null {
  if (!extras) return null;
  const meta = extras._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  return meta as RequestMeta;
}

function synthesizeFromConversationId(
  conversationId: string,
  clientInfoName: string | undefined
): ParsedAgentId | null {
  const kind = normalizeClientInfoNameToKind(clientInfoName);
  // Round-trip through the canonical parser rather than constructing the object
  // directly, so a conversation id carrying a `:` or `@` can never smuggle a
  // different kind, scope or parent chain into the resolved identity.
  return parseAgentId(`${kind}:conv:${conversationId}`);
}

/**
 * Resolve declared identity by walking the key list in order.
 *
 * Returns the first key that yields a valid identity, along with which key that
 * was, or null when none of them answered. Never throws: a malformed value at
 * any key is indistinguishable from an absent one and falls through to the next.
 */
export function readDeclaredIdentity(
  extras: RequestExtras | undefined,
  keys: readonly DeclaredIdentityKey[] = DEFAULT_DECLARED_IDENTITY_KEYS,
  clientInfoName?: string
): DeclaredIdentityHit | null {
  const meta = readMeta(extras);
  if (!meta) return null;

  for (const candidate of keys) {
    const raw = meta[candidate.key];

    if (candidate.form === "agent-id") {
      if (typeof raw !== "string" || raw.length === 0) continue;
      const parsed = parseAgentId(raw);
      if (parsed) return { parsed, key: candidate.key };
      continue;
    }

    const conversationId =
      candidate.form === "baggage"
        ? readBaggageEntry(raw, candidate.entry ?? GEN_AI_CONVERSATION_ID_KEY)
        : typeof raw === "string" && raw.length > 0
          ? raw
          : null;

    if (!conversationId) continue;

    const parsed = synthesizeFromConversationId(conversationId, clientInfoName);
    if (parsed) return { parsed, key: candidate.key };
  }

  return null;
}
