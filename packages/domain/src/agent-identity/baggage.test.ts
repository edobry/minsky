/**
 * Unit tests for the W3C Baggage codec (mt#3986).
 *
 * The limits asserted here are quoted from https://www.w3.org/TR/baggage/:
 * a compliant propagator carries "64 list-members or less" and a string "of
 * size 8192 bytes or less", and "MUST NOT propagate any partial list-members"
 * past either bound.
 */
import { describe, test, expect } from "bun:test";
import {
  MAX_BAGGAGE_BYTES,
  MAX_BAGGAGE_MEMBERS,
  GEN_AI_CONVERSATION_ID_KEY,
  appendBaggageEntry,
  encodeBaggageValue,
  parseBaggage,
  readBaggageEntry,
} from "./baggage";

const UUID = "2154425b-1c30-4f0e-9d51-0b73b9a2f5a1";

describe("parseBaggage", () => {
  test("parses a single member", () => {
    const entries = parseBaggage("key1=value1");
    expect(entries?.get("key1")).toBe("value1");
  });

  test("parses multiple members and preserves all of them", () => {
    const entries = parseBaggage("key1=value1,key2=value2,key3=value3");
    expect(entries?.size).toBe(3);
    expect(entries?.get("key2")).toBe("value2");
  });

  test("tolerates optional whitespace around the delimiters", () => {
    const entries = parseBaggage("key1 = value1 , key2 = value2");
    expect(entries?.get("key1")).toBe("value1");
    expect(entries?.get("key2")).toBe("value2");
  });

  test("ignores list-member properties but still reads the value", () => {
    const entries = parseBaggage("key1=value1;metadata=some-prop,key2=value2");
    expect(entries?.get("key1")).toBe("value1");
    expect(entries?.get("key2")).toBe("value2");
  });

  test("percent-decodes values", () => {
    const entries = parseBaggage("key1=a%20b%2Cc");
    expect(entries?.get("key1")).toBe("a b,c");
  });

  test("returns null for a non-string input", () => {
    expect(parseBaggage(undefined)).toBeNull();
    expect(parseBaggage(null)).toBeNull();
    expect(parseBaggage(42)).toBeNull();
    expect(parseBaggage({ key1: "value1" })).toBeNull();
  });

  test("returns null for an empty or whitespace-only string", () => {
    expect(parseBaggage("")).toBeNull();
    expect(parseBaggage("   ")).toBeNull();
  });

  test("returns null when a member has no '='", () => {
    expect(parseBaggage("key1=value1,malformed")).toBeNull();
  });

  test("returns null when a member has an empty key", () => {
    expect(parseBaggage("=value1")).toBeNull();
  });

  test("returns null on malformed percent-encoding rather than throwing", () => {
    // A lone '%' is not a valid escape — decodeURIComponent throws on it.
    expect(() => parseBaggage("key1=100%")).not.toThrow();
    expect(parseBaggage("key1=100%")).toBeNull();
  });

  test("returns null past the 64-member limit", () => {
    const atLimit = Array.from({ length: MAX_BAGGAGE_MEMBERS }, (_, i) => `k${i}=v${i}`).join(",");
    expect(parseBaggage(atLimit)?.size).toBe(MAX_BAGGAGE_MEMBERS);

    const over = Array.from({ length: MAX_BAGGAGE_MEMBERS + 1 }, (_, i) => `k${i}=v${i}`).join(",");
    expect(parseBaggage(over)).toBeNull();
  });

  test("returns null past the 8192-byte limit", () => {
    const over = `k=${"x".repeat(MAX_BAGGAGE_BYTES)}`;
    expect(parseBaggage(over)).toBeNull();
  });
});

describe("readBaggageEntry", () => {
  test("reads the requested entry", () => {
    const raw = `other=1,${GEN_AI_CONVERSATION_ID_KEY}=${UUID}`;
    expect(readBaggageEntry(raw, GEN_AI_CONVERSATION_ID_KEY)).toBe(UUID);
  });

  test("returns null when the key is absent", () => {
    expect(readBaggageEntry("other=1", GEN_AI_CONVERSATION_ID_KEY)).toBeNull();
  });

  test("returns null when the whole string is unparseable", () => {
    expect(readBaggageEntry("malformed", GEN_AI_CONVERSATION_ID_KEY)).toBeNull();
  });

  test("returns null for an empty value", () => {
    expect(
      readBaggageEntry(`${GEN_AI_CONVERSATION_ID_KEY}=`, GEN_AI_CONVERSATION_ID_KEY)
    ).toBeNull();
  });
});

describe("encodeBaggageValue", () => {
  test("leaves a UUID untouched", () => {
    expect(encodeBaggageValue(UUID)).toBe(UUID);
  });

  test("percent-encodes octets outside the baggage-octet range", () => {
    expect(encodeBaggageValue("a b")).toBe("a%20b");
    expect(encodeBaggageValue("a,b")).toBe("a%2Cb");
    expect(encodeBaggageValue("a;b")).toBe("a%3Bb");
    expect(encodeBaggageValue('a"b')).toBe("a%22b");
    expect(encodeBaggageValue("a\\b")).toBe("a%5Cb");
  });

  test("percent-encodes '%' itself, so a literal percent cannot start an escape", () => {
    expect(encodeBaggageValue("100%")).toBe("100%25");
  });

  test("encodes non-ASCII as UTF-8 bytes that decode back to the original", () => {
    const encoded = encodeBaggageValue("héllo");
    expect(encoded).not.toContain("é");
    expect(decodeURIComponent(encoded)).toBe("héllo");
  });
});

describe("appendBaggageEntry", () => {
  test("creates the string when there is no existing baggage", () => {
    expect(appendBaggageEntry(undefined, GEN_AI_CONVERSATION_ID_KEY, UUID)).toBe(
      `${GEN_AI_CONVERSATION_ID_KEY}=${UUID}`
    );
    expect(appendBaggageEntry(null, GEN_AI_CONVERSATION_ID_KEY, UUID)).toBe(
      `${GEN_AI_CONVERSATION_ID_KEY}=${UUID}`
    );
  });

  test("MERGES into existing baggage, reproducing the original members verbatim", () => {
    const existing = "key1 = value1;prop=x , key2=value%202";
    const merged = appendBaggageEntry(existing, GEN_AI_CONVERSATION_ID_KEY, UUID);

    expect(merged).toBe(`${existing},${GEN_AI_CONVERSATION_ID_KEY}=${UUID}`);
    // The caller's own spacing, properties and encoding survive untouched.
    expect(merged).toContain("key1 = value1;prop=x");
    expect(merged).toContain("key2=value%202");
  });

  test("does NOT clobber a caller that already declared the key", () => {
    const existing = `${GEN_AI_CONVERSATION_ID_KEY}=someone-elses-id`;
    expect(appendBaggageEntry(existing, GEN_AI_CONVERSATION_ID_KEY, UUID)).toBeNull();
  });

  test("refuses to rewrite baggage it cannot fully parse", () => {
    expect(appendBaggageEntry("malformed-no-equals", GEN_AI_CONVERSATION_ID_KEY, UUID)).toBeNull();
  });

  test("refuses when appending would exceed the 64-member limit", () => {
    const full = Array.from({ length: MAX_BAGGAGE_MEMBERS }, (_, i) => `k${i}=v${i}`).join(",");
    expect(appendBaggageEntry(full, GEN_AI_CONVERSATION_ID_KEY, UUID)).toBeNull();

    const oneUnder = Array.from({ length: MAX_BAGGAGE_MEMBERS - 1 }, (_, i) => `k${i}=v${i}`).join(
      ","
    );
    expect(appendBaggageEntry(oneUnder, GEN_AI_CONVERSATION_ID_KEY, UUID)).not.toBeNull();
  });

  test("refuses when appending would exceed the 8192-byte limit", () => {
    const member = `${GEN_AI_CONVERSATION_ID_KEY}=${UUID}`;
    // Sits just under the limit alone, but cannot fit one more member.
    const nearLimit = `k=${"x".repeat(MAX_BAGGAGE_BYTES - member.length)}`;
    expect(nearLimit.length).toBeLessThanOrEqual(MAX_BAGGAGE_BYTES);
    expect(appendBaggageEntry(nearLimit, GEN_AI_CONVERSATION_ID_KEY, UUID)).toBeNull();
  });

  test("never emits a partial list-member when it refuses", () => {
    const full = Array.from({ length: MAX_BAGGAGE_MEMBERS }, (_, i) => `k${i}=v${i}`).join(",");
    const result = appendBaggageEntry(full, GEN_AI_CONVERSATION_ID_KEY, UUID);
    // Null means "write nothing" — the caller keeps the original string, so
    // there is no truncated or half-written member on the wire.
    expect(result).toBeNull();
  });

  test("treats an empty existing string as absent", () => {
    expect(appendBaggageEntry("", GEN_AI_CONVERSATION_ID_KEY, UUID)).toBe(
      `${GEN_AI_CONVERSATION_ID_KEY}=${UUID}`
    );
  });

  test("refuses an empty value", () => {
    expect(appendBaggageEntry(undefined, GEN_AI_CONVERSATION_ID_KEY, "")).toBeNull();
  });

  test("round-trips through the reader", () => {
    const merged = appendBaggageEntry("other=1", GEN_AI_CONVERSATION_ID_KEY, UUID);
    expect(readBaggageEntry(merged, GEN_AI_CONVERSATION_ID_KEY)).toBe(UUID);
    expect(readBaggageEntry(merged, "other")).toBe("1");
  });
});
