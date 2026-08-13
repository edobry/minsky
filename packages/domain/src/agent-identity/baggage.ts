/**
 * W3C Baggage codec for the MCP `_meta.baggage` key (mt#3986).
 *
 * The MCP 2026-07-28 revision reserves `traceparent`, `tracestate` and
 * `baggage` as unprefixed `_meta` keys for OpenTelemetry trace-context
 * propagation, and requires their values to follow the W3C Trace Context and
 * W3C Baggage formats. OpenTelemetry's MCP semantic conventions prescribe the
 * same transport: propagate context "by injecting it into the MCP request
 * `params._meta` property bag".
 *
 * Carrying a CONVERSATION identifier inside baggage is an extension, not a
 * prescription: `gen_ai.conversation.id` is defined by OpenTelemetry's GenAI
 * conventions as a span attribute, and nothing in either spec says to put it in
 * baggage. Minsky uses the nearest standard attribute name rather than coining
 * one. See mt#3986's `## Planning Audit` for the primary-source verification.
 *
 * Every function here is total: malformed, oversized or absent input yields
 * null, never a throw. A caller reading identity off the wire must be able to
 * fall through to the next key rather than fail a request.
 *
 * @see https://www.w3.org/TR/baggage/
 * @see https://modelcontextprotocol.io/specification/2026-07-28/basic/index
 */

/** The unprefixed `_meta` key MCP reserves for W3C Baggage. */
export const BAGGAGE_META_KEY = "baggage";

/** The baggage entry Minsky reads and writes the conversation id under. */
export const GEN_AI_CONVERSATION_ID_KEY = "gen_ai.conversation.id";

/**
 * W3C Baggage §Limits: a compliant propagator must carry a baggage-string of
 * "64 list-members or less" that is "of size 8192 bytes or less". Past either
 * bound entries may be dropped, but a partial list-member must never be
 * propagated — so we refuse to append rather than emit something truncated.
 */
export const MAX_BAGGAGE_MEMBERS = 64;
export const MAX_BAGGAGE_BYTES = 8192;

const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/**
 * True for the `baggage-octet` production, minus `%`.
 *
 * baggage-octet = %x21 / %x23-2B / %x2D-3A / %x3C-5B / %x5D-7E
 *
 * `%` (0x25) sits inside that range but the spec requires it to be
 * percent-encoded anyway, so that a literal percent can never be mistaken for
 * the start of an escape.
 */
function isBaggageOctet(code: number): boolean {
  if (code === 0x25) return false;
  return (
    code === 0x21 ||
    (code >= 0x23 && code <= 0x2b) ||
    (code >= 0x2d && code <= 0x3a) ||
    (code >= 0x3c && code <= 0x5b) ||
    (code >= 0x5d && code <= 0x7e)
  );
}

/**
 * Percent-encode a value for use as a baggage list-member value.
 *
 * Applied unconditionally even though today's only caller passes a UUID, which
 * needs no encoding: the encoder is what makes it structurally impossible for a
 * future non-UUID identifier to emit a header that violates the grammar.
 */
export function encodeBaggageValue(value: string): string {
  let out = "";
  for (const byte of encoder.encode(value)) {
    out += isBaggageOctet(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function decodeBaggageValue(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding. The spec's remedy is U+FFFD substitution;
    // for an identity lookup an unusable value and an absent one are the same
    // thing, so report absence and let the caller try the next key.
    return null;
  }
}

/**
 * Parse a baggage-string into its entries, in wire order.
 *
 * Returns null — meaning "do not treat this as baggage" — when the input is not
 * a string, is over either W3C limit, or contains a member that does not match
 * the `key = value` grammar. Refusing the WHOLE string on a malformed member is
 * deliberate: the writer's contract is to preserve a caller's baggage verbatim,
 * and a string we cannot fully understand is one we must not rewrite.
 */
export function parseBaggage(raw: unknown): Map<string, string> | null {
  if (typeof raw !== "string") return null;

  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (byteLength(trimmed) > MAX_BAGGAGE_BYTES) return null;

  const members = trimmed.split(",");
  if (members.length > MAX_BAGGAGE_MEMBERS) return null;

  const entries = new Map<string, string>();
  for (const member of members) {
    // Properties (`;key=value`) are metadata about the entry, not part of its
    // value. We neither read nor emit them, but they must not break parsing.
    const withoutProperties = member.split(";")[0] ?? "";
    const eq = withoutProperties.indexOf("=");
    if (eq === -1) return null;

    const key = withoutProperties.slice(0, eq).trim();
    const value = withoutProperties.slice(eq + 1).trim();
    if (key.length === 0) return null;

    const decoded = decodeBaggageValue(value);
    if (decoded === null) return null;

    // First occurrence wins, matching the "leftmost" reading propagators use.
    if (!entries.has(key)) entries.set(key, decoded);
  }

  return entries;
}

/**
 * Read one entry out of a baggage-string.
 *
 * Returns null when the string is absent, unparseable, or carries no such key —
 * the three cases a resolver treats identically as "this key did not answer".
 */
export function readBaggageEntry(raw: unknown, key: string): string | null {
  const entries = parseBaggage(raw);
  if (!entries) return null;
  const value = entries.get(key);
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * Build the baggage-string to emit, merging into whatever the caller already
 * sent. Returns null when nothing should be written, which is every case where
 * writing would lose information or break the grammar:
 *
 * - the caller already declared this key (more-specific caller wins, the same
 *   rule the writers apply to `io.minsky/agent_id`)
 * - the existing value is present but unparseable (never rewrite what we cannot
 *   fully read)
 * - appending would push the result past 64 members or 8192 bytes
 *
 * The existing string is reproduced verbatim rather than re-serialized from the
 * parsed map, so a caller's own spacing, properties and encoding survive
 * untouched.
 */
export function appendBaggageEntry(existing: unknown, key: string, value: string): string | null {
  if (value.length === 0) return null;

  const member = `${key}=${encodeBaggageValue(value)}`;

  if (existing === undefined || existing === null) {
    return byteLength(member) <= MAX_BAGGAGE_BYTES ? member : null;
  }

  if (typeof existing !== "string") return null;

  const trimmed = existing.trim();
  if (trimmed.length === 0) {
    return byteLength(member) <= MAX_BAGGAGE_BYTES ? member : null;
  }

  const entries = parseBaggage(trimmed);
  if (!entries) return null;
  if (entries.has(key)) return null;

  if (entries.size + 1 > MAX_BAGGAGE_MEMBERS) return null;

  const merged = `${trimmed},${member}`;
  if (byteLength(merged) > MAX_BAGGAGE_BYTES) return null;

  return merged;
}
