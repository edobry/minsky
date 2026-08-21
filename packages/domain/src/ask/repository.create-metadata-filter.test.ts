/**
 * mt#4331 — forbidden metadata keys are filtered at the CREATE boundary, not
 * only scrubbed later on the way through an edit.
 *
 * `sanitizeMetadata` was applied to both sides of the edit merge but to neither
 * create path, so an Ask created with a literal `__proto__` own-key persisted it
 * and kept it indefinitely unless someone happened to edit that Ask.
 *
 * Both create paths are covered, and AT4 asserts they agree — a fake that
 * filtered fewer keys than the Drizzle backend would let these tests pass
 * against behaviour production does not have (ADR-036).
 *
 * Note on constructing the hostile input: an object LITERAL `{ __proto__: x }`
 * sets the prototype rather than creating an own-key, so it cannot express the
 * vector under test. `JSON.parse` is the shape that actually produces a literal
 * `__proto__` own-property, and is also how this input arrives in production —
 * metadata reaches the repository having been parsed from an MCP request body.
 */

import { describe, it, expect } from "bun:test";

import { FakeAskRepository, toInsert } from "./repository";
import type { CreateAskInput } from "./repository";
import { FORBIDDEN_METADATA_KEYS, sanitizeMetadata, stripReservedProvenanceKeys } from "./edit";

const TEST_REQUESTOR = "agent:test";

function makeInput(overrides: Partial<CreateAskInput> = {}): CreateAskInput {
  return {
    kind: "quality.review",
    classifierVersion: "v1.0.0",
    requestor: TEST_REQUESTOR,
    title: "Review this output",
    question: "Does this implementation satisfy the spec?",
    metadata: {},
    ...overrides,
  };
}

/** Metadata carrying a literal own-key named `key`, as JSON.parse produces it. */
function metadataWithOwnKey(key: string, value: unknown): Record<string, unknown> {
  return JSON.parse(`{ ${JSON.stringify(key)}: ${JSON.stringify(value)} }`) as Record<
    string,
    unknown
  >;
}

describe("mt#4331 — create-path forbidden-key filtering", () => {
  it("the hostile input really does carry a literal own-key (control for AT1-AT3)", () => {
    // If this fails, every assertion below is vacuous — it would mean the test
    // never managed to build the vector it claims to be filtering.
    const hostile = metadataWithOwnKey("__proto__", { polluted: true });
    expect(Object.prototype.hasOwnProperty.call(hostile, "__proto__")).toBe(true);
    expect(Object.keys(hostile)).toContain("__proto__");
  });

  // AT1 — `__proto__` at create is not persisted, and the prototype is unchanged.
  it("AT1: does not persist a literal __proto__ own-key, on either create path", async () => {
    const hostile = metadataWithOwnKey("__proto__", { polluted: true });

    const row = toInsert(makeInput({ metadata: hostile }));
    const rowMeta = row.metadata as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(rowMeta, "__proto__")).toBe(false);
    expect(Object.keys(rowMeta)).not.toContain("__proto__");
    // The row builder's object is not prototype-polluted either. This is the
    // assertion the key-absence checks above CANNOT make: a polluted object has
    // no own `__proto__` key, so key-absence alone is satisfied by the very
    // outcome this task exists to prevent.
    expect(Object.getPrototypeOf(rowMeta)).toBe(Object.prototype);

    const repo = new FakeAskRepository();
    const created = await repo.create(makeInput({ metadata: hostile }));
    expect(Object.prototype.hasOwnProperty.call(created.metadata ?? {}, "__proto__")).toBe(false);

    // The returned record's prototype is untouched — no reparenting took effect.
    //
    // Deliberately NOT asserting `({}).polluted === undefined` here (PR #3197 R1
    // flagged it): this vector reparents the ONE object being copied into, it
    // does not write through to `Object.prototype`, so that assertion would hold
    // whether or not the filter worked. An assertion that passes in the broken
    // case reads as coverage and provides none.
    expect(Object.getPrototypeOf(created.metadata ?? {})).toBe(Object.prototype);
  });

  // AT2 — asserted individually, so a partial filter cannot pass.
  for (const key of ["prototype", "constructor"]) {
    it(`AT2: does not persist a literal ${key} own-key, on either create path`, async () => {
      const hostile = metadataWithOwnKey(key, "hostile");

      const rowMeta = toInsert(makeInput({ metadata: hostile })).metadata as Record<
        string,
        unknown
      >;
      expect(Object.keys(rowMeta)).not.toContain(key);

      const repo = new FakeAskRepository();
      const created = await repo.create(makeInput({ metadata: hostile }));
      expect(Object.keys(created.metadata ?? {})).not.toContain(key);
    });
  }

  // AT3 — the filter is surgical, not a wholesale drop.
  it("AT3: keeps unrelated keys alongside a forbidden one", async () => {
    const mixed = JSON.parse(
      '{ "__proto__": { "polluted": true }, "keepMe": "value", "alsoKeep": 42 }'
    ) as Record<string, unknown>;

    const rowMeta = toInsert(makeInput({ metadata: mixed })).metadata as Record<string, unknown>;
    expect(rowMeta.keepMe).toBe("value");
    expect(rowMeta.alsoKeep).toBe(42);
    expect(Object.keys(rowMeta)).not.toContain("__proto__");

    const repo = new FakeAskRepository();
    const created = await repo.create(makeInput({ metadata: mixed }));
    expect((created.metadata ?? {}).keepMe).toBe("value");
    expect((created.metadata ?? {}).alsoKeep).toBe(42);
    expect(Object.keys(created.metadata ?? {})).not.toContain("__proto__");
  });

  // Each filter is safe on its OWN, so composition order cannot matter (PR #3197
  // R1). This is what makes the create paths correct regardless of nesting —
  // asserting the composed result instead would prove nothing, since both orders
  // yield an identical key set and a swap would regress silently.
  it("each filter copies safely, so neither order can reparent the result", () => {
    const hostile = metadataWithOwnKey("__proto__", { polluted: true });

    // stripReservedProvenanceKeys does NOT filter `__proto__` — that is
    // sanitizeMetadata's job — so it copies the key, and the copy must not
    // reparent. This is the assertion that would have failed before defineOwnKey.
    const strippedAlone = stripReservedProvenanceKeys(hostile);
    expect(Object.getPrototypeOf(strippedAlone)).toBe(Object.prototype);
    expect((strippedAlone as { polluted?: boolean }).polluted).toBeUndefined();

    const sanitizedAlone = sanitizeMetadata(hostile);
    expect(Object.getPrototypeOf(sanitizedAlone)).toBe(Object.prototype);

    // Both compositions are therefore clean, which is the point: the production
    // call sites are correct whichever order a future refactor leaves them in.
    for (const composed of [
      stripReservedProvenanceKeys(sanitizeMetadata(hostile)),
      sanitizeMetadata(stripReservedProvenanceKeys(hostile)),
    ]) {
      expect(Object.getPrototypeOf(composed)).toBe(Object.prototype);
      expect(Object.keys(composed)).not.toContain("__proto__");
    }
  });

  // AT4 — the fake cannot drift more permissive than the real backend.
  it("AT4: the Drizzle row builder and FakeAskRepository.create agree on the key set", async () => {
    const everyForbiddenPlusSafe = JSON.parse(
      `{ ${FORBIDDEN_METADATA_KEYS.map((k) => `${JSON.stringify(k)}: "hostile"`).join(
        ", "
      )}, "safeKey": "kept" }`
    ) as Record<string, unknown>;

    const rowMeta = toInsert(makeInput({ metadata: everyForbiddenPlusSafe })).metadata as Record<
      string,
      unknown
    >;

    const repo = new FakeAskRepository();
    const created = await repo.create(makeInput({ metadata: everyForbiddenPlusSafe }));

    expect(Object.keys(created.metadata ?? {}).sort()).toEqual(Object.keys(rowMeta).sort());
    // And that agreed-upon set is the safe one, so agreeing on a WRONG set fails too.
    expect(Object.keys(rowMeta).sort()).toEqual(["safeKey"]);
  });
});
