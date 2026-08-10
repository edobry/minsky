import { describe, expect, test } from "bun:test";

import type { PersistenceConfig } from "../types";
import { VectorCapabilityProbeInconclusiveError } from "../vector-capability-probe";
import { PostgresProviderFactory } from "./postgres-provider-factory";
import { PostgresVectorPersistenceProvider } from "./postgres-provider";

/**
 * Exercises the FACTORY's own branch, not just the classifier it calls
 * (PR #2766 R1). The classifier being right is not evidence the factory acts on
 * it — that is the caller-direction gap the reviewer named.
 *
 * The client is injected via the `deps` parameter rather than patched onto the
 * module, per ADR-036. The double is a tagged-template function because that is
 * what `postgres()` returns and what the factory calls it as.
 */

const CONFIG: PersistenceConfig = {
  backend: "postgres",
  postgres: { connectionString: "postgres://example.invalid:5432/test" },
} as PersistenceConfig;

interface FakeClient {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  ended: boolean;
  queries: string[];
}

/**
 * A stand-in for the postgres-js client.
 *
 * `SELECT 1` always succeeds — the point is to reach the pgvector probe with a
 * healthy connection, so the outcome under test is the probe's ANSWER rather
 * than a connection failure (which already throws and is already covered).
 */
function fakeClient(vectorProbeResult: unknown): FakeClient {
  const client = ((strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    client.queries.push(sql);
    // Route on `pg_extension`, NOT on "SELECT 1": the pgvector query CONTAINS a
    // `SELECT 1` in its subselect, so dispatching on that string sends the
    // capability probe down the connectivity branch. The first draft of this
    // fake did exactly that and the two readable-answer tests failed with an
    // inconclusive-probe error — the fake, not the code, was wrong.
    if (sql.includes("pg_extension")) return Promise.resolve(vectorProbeResult);
    return Promise.resolve([{ "?column?": 1 }]);
  }) as FakeClient;
  client.ended = false;
  client.queries = [];
  Object.defineProperty(client, "end", {
    value: () => {
      client.ended = true;
      return Promise.resolve();
    },
  });
  return client;
}

describe("PostgresProviderFactory capability branch", () => {
  test("a readable 'present' answer yields the vector provider", async () => {
    const client = fakeClient([{ exists: true }]);
    const provider = await PostgresProviderFactory.create(CONFIG, {
      buildClient: () => client as never,
    });

    expect(provider).toBeInstanceOf(PostgresVectorPersistenceProvider);
    expect(client.ended).toBe(false); // adopted by the provider, not closed here
  });

  test("a readable 'absent' answer yields the base provider — not a fault", async () => {
    const client = fakeClient([{ exists: false }]);
    const provider = await PostgresProviderFactory.create(CONFIG, {
      buildClient: () => client as never,
    });

    expect(provider).not.toBeInstanceOf(PostgresVectorPersistenceProvider);
    expect(client.ended).toBe(false);
  });

  test.each([
    ["zero rows", []],
    ["a row with no exists column", [{}]],
    ["a row whose exists is null", [{ exists: null }]],
    ["a row whose exists is the string 'f'", [{ exists: "f" }]],
  ])("throws rather than constructing a provider when the probe returns %s", async (_l, rows) => {
    const client = fakeClient(rows);

    await expect(
      PostgresProviderFactory.create(CONFIG, { buildClient: () => client as never })
    ).rejects.toBeInstanceOf(VectorCapabilityProbeInconclusiveError);
  });

  test("the probed client is ended when the probe is inconclusive, so the pool does not leak", async () => {
    const client = fakeClient([]);

    await expect(
      PostgresProviderFactory.create(CONFIG, { buildClient: () => client as never })
    ).rejects.toBeInstanceOf(VectorCapabilityProbeInconclusiveError);
    expect(client.ended).toBe(true);
  });

  test("the string 'f' throws rather than being read as truthy — the second direction", async () => {
    // Pre-fix, `?? false` left "f" intact and its truthiness selected the VECTOR
    // provider against a database with no pgvector. This asserts the factory no
    // longer does that, at the factory level.
    const client = fakeClient([{ exists: "f" }]);

    await expect(
      PostgresProviderFactory.create(CONFIG, { buildClient: () => client as never })
    ).rejects.toBeInstanceOf(VectorCapabilityProbeInconclusiveError);
  });
});
