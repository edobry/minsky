/**
 * Tests for the shared uuid-prefix-resolution helper (mt#2696).
 *
 * Covers:
 *  - classifyIdInput: full-UUID passthrough, invalid (empty/short/non-hex), prefix
 *  - resolveCandidates: unique hit, ambiguous, no match
 *  - idPrefixResolutionError: message shaping for each non-resolved kind
 *  - resolveIdPrefix (DB-backed): end-to-end against a minimal fake db,
 *    including the "malformed input never reaches a raw uuid cast" guarantee
 */

import { describe, it, expect } from "bun:test";
import {
  classifyIdInput,
  resolveCandidates,
  resolveIdPrefix,
  resolveIdPrefixOrThrow,
  idPrefixResolutionError,
  type IdPrefixResolverDb,
  type PrefixCandidate,
} from "./id-prefix-resolver";

const FULL_UUID = "d8591800-823b-410b-a5cc-209fb0b7eb6d";
const OTHER_UUID = "ffffffff-1111-2222-3333-444444444444";
const SIBLING_UUID_A = "d8591800-0000-0000-0000-000000000001";
const SIBLING_UUID_B = "d8591800-0000-0000-0000-000000000002";
const FULL_UUID_LABEL = "wave-orchestration";

describe("classifyIdInput", () => {
  it("passes a full, well-formed UUID through without a DB round-trip", () => {
    const result = classifyIdInput(FULL_UUID);
    expect(result).toEqual({ kind: "resolved", id: FULL_UUID });
  });

  it("is case-insensitive on full UUIDs and normalizes to lowercase", () => {
    const result = classifyIdInput(FULL_UUID.toUpperCase());
    expect(result).toEqual({ kind: "resolved", id: FULL_UUID });
  });

  it("rejects empty input as invalid", () => {
    const result = classifyIdInput("");
    expect(result.kind).toBe("invalid");
  });

  it("rejects input shorter than the minimum prefix length as invalid", () => {
    const result = classifyIdInput("d859");
    expect(result.kind).toBe("invalid");
    if (result.kind === "invalid") {
      expect(result.reason).toContain("at least 8 characters");
    }
  });

  it("rejects non-hex input as invalid (never reaches a query)", () => {
    const result = classifyIdInput("not-a-uuid-but-36-characters-long!!");
    expect(result.kind).toBe("invalid");
  });

  it("classifies an unambiguous-length hex fragment as a prefix candidate", () => {
    const result = classifyIdInput("d8591800");
    expect(result).toEqual({ kind: "prefix", normalized: "d8591800" });
  });

  it("normalizes a mixed-case prefix to lowercase", () => {
    const result = classifyIdInput("D8591800");
    expect(result).toEqual({ kind: "prefix", normalized: "d8591800" });
  });

  it("accepts a partial-UUID-with-dashes prefix (longer than 8 chars, non-canonical shape)", () => {
    const result = classifyIdInput("d8591800-823b");
    expect(result).toEqual({ kind: "prefix", normalized: "d8591800-823b" });
  });
});

describe("resolveCandidates", () => {
  it("resolves a unique-prefix hit", () => {
    const candidates: PrefixCandidate[] = [{ id: FULL_UUID, label: FULL_UUID_LABEL }];
    const result = resolveCandidates(candidates, "d8591800");
    expect(result).toEqual({ kind: "resolved", id: FULL_UUID });
  });

  it("returns not_found for zero candidates", () => {
    const result = resolveCandidates([], "ffffffff");
    expect(result).toEqual({ kind: "not_found", input: "ffffffff" });
  });

  it("returns ambiguous for two or more candidates, listing them", () => {
    const candidates: PrefixCandidate[] = [
      { id: SIBLING_UUID_A, label: "memory-a" },
      { id: SIBLING_UUID_B, label: "memory-b" },
    ];
    const result = resolveCandidates(candidates, "d8591800");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.id)).toEqual(candidates.map((c) => c.id));
    }
  });
});

describe("idPrefixResolutionError", () => {
  it("names the prefix in a not_found error, with no Postgres error text", () => {
    const err = idPrefixResolutionError("memory", { kind: "not_found", input: "ffffffff" });
    expect(err.message).toContain("ffffffff");
    expect(err.message).toContain("Memory not found");
    expect(err.message).not.toMatch(/invalid input syntax/i);
  });

  it("lists all candidates (id + label) in an ambiguous error", () => {
    const err = idPrefixResolutionError("memory", {
      kind: "ambiguous",
      input: "d8591800",
      candidates: [
        { id: SIBLING_UUID_A, label: "memory-a" },
        { id: SIBLING_UUID_B, label: "memory-b" },
      ],
    });
    expect(err.message).toContain(SIBLING_UUID_A);
    expect(err.message).toContain("memory-a");
    expect(err.message).toContain(SIBLING_UUID_B);
    expect(err.message).toContain("memory-b");
  });

  it("surfaces the invalid reason verbatim", () => {
    const err = idPrefixResolutionError("ask", {
      kind: "invalid",
      input: "!!!",
      reason: "id prefix must be hexadecimal",
    });
    expect(err.message).toContain("id prefix must be hexadecimal");
  });
});

// ---------------------------------------------------------------------------
// resolveIdPrefix — DB-backed, via a minimal fake
// ---------------------------------------------------------------------------

interface FakeRow {
  id: string;
  /** Mirrors the `{ id, label }` shape Drizzle returns from `select({id, label})`. */
  label: string;
}

/**
 * Minimal fake satisfying `IdPrefixResolverDb`. Doesn't parse the Drizzle SQL
 * condition — instead simulates the `<col>::text LIKE '<prefix>%'` semantics
 * directly against the seeded rows by prefix-matching on `id`. Rows are
 * pre-shaped as `{ id, label }` — the same shape the resolver's
 * `select({ id: idColumn, label: labelColumn })` produces from a real
 * Drizzle client. This keeps the test focused on resolveIdPrefix's branching
 * (resolved / not_found / ambiguous / invalid) rather than re-deriving
 * SQL-string parsing.
 */
function createFakeDb(rows: FakeRow[]): IdPrefixResolverDb & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    select(_fields?: unknown) {
      return {
        from(_table: unknown) {
          return {
            // The resolver always calls `.where(sql`...LIKE ${pattern}`)`.
            // We can't easily parse the Drizzle SQL chunk here without a
            // pg dialect renderer, so instead we record that a query fired
            // and derive the intended prefix from the row set the resolver
            // is expected to look up (bound via closure below through the
            // `input` seeded in each `it()` — see `where` shim below).
            where(_cond: unknown) {
              queries.push("query-fired");
              // The fake doesn't introspect `_cond`; each test constructs a
              // fresh fake pre-filtered to the rows the LIKE clause would
              // have matched, so `where()` here is a passthrough.
              return Promise.resolve(rows);
            },
          };
        },
      };
    },
  };
}

// Mimic a minimal Drizzle "column" reference — resolveIdPrefix only needs
// something to interpolate into the `sql` tagged template and to read
// `.label`/`.id` keys off in the returned rows, so a plain marker object
// suffices as the fake table/column shape.
const fakeTable = {} as Record<string, unknown>;
const fakeIdColumn = { name: "id" } as Record<string, unknown>;
const fakeLabelColumn = { name: "name" } as Record<string, unknown>;

describe("resolveIdPrefix (DB-backed)", () => {
  it("passes a full UUID through with no DB query", async () => {
    const db = createFakeDb([]);
    const result = await resolveIdPrefix({
      db,
      table: fakeTable,
      idColumn: fakeIdColumn,
      labelColumn: fakeLabelColumn,
      input: FULL_UUID,
      entityName: "memory",
    });
    expect(result).toEqual({ kind: "resolved", id: FULL_UUID });
    expect(db.queries).toHaveLength(0);
  });

  it("resolves a unique-prefix hit against seeded candidate rows", async () => {
    const db = createFakeDb([{ id: FULL_UUID, label: FULL_UUID_LABEL }]);
    const result = await resolveIdPrefix({
      db,
      table: fakeTable,
      idColumn: fakeIdColumn,
      labelColumn: fakeLabelColumn,
      input: "d8591800",
      entityName: "memory",
    });
    expect(result).toEqual({ kind: "resolved", id: FULL_UUID });
  });

  it("returns a clean not_found (no Postgres error text) for a non-matching prefix", async () => {
    const db = createFakeDb([]);
    const result = await resolveIdPrefix({
      db,
      table: fakeTable,
      idColumn: fakeIdColumn,
      labelColumn: fakeLabelColumn,
      input: "ffffffff",
      entityName: "memory",
    });
    expect(result).toEqual({ kind: "not_found", input: "ffffffff" });
  });

  it("returns ambiguous when two rows share a prefix", async () => {
    const db = createFakeDb([
      { id: FULL_UUID, label: "memory-a" },
      { id: SIBLING_UUID_B, label: "memory-b" },
    ]);
    const result = await resolveIdPrefix({
      db,
      table: fakeTable,
      idColumn: fakeIdColumn,
      labelColumn: fakeLabelColumn,
      input: "d8591800",
      entityName: "memory",
    });
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates.map((c) => c.label).sort()).toEqual(["memory-a", "memory-b"]);
    }
  });

  it("never queries the DB for malformed input — invalid short-circuits before any cast", async () => {
    const db = createFakeDb([]);
    const result = await resolveIdPrefix({
      db,
      table: fakeTable,
      idColumn: fakeIdColumn,
      input: "!!!",
      entityName: "memory",
    });
    expect(result.kind).toBe("invalid");
    expect(db.queries).toHaveLength(0);
  });

  it("resolveIdPrefixOrThrow returns the id on a resolved match", async () => {
    const db = createFakeDb([{ id: FULL_UUID, label: FULL_UUID_LABEL }]);
    const id = await resolveIdPrefixOrThrow({
      db,
      table: fakeTable,
      idColumn: fakeIdColumn,
      labelColumn: fakeLabelColumn,
      input: "d8591800",
      entityName: "memory",
    });
    expect(id).toBe(FULL_UUID);
  });

  it("resolveIdPrefixOrThrow throws a clean error (not a raw SQL error) on not-found", async () => {
    const db = createFakeDb([]);
    await expect(
      resolveIdPrefixOrThrow({
        db,
        table: fakeTable,
        idColumn: fakeIdColumn,
        input: OTHER_UUID.slice(0, 8),
        entityName: "memory",
      })
    ).rejects.toThrow(/not found/i);
  });
});
