/**
 * `requireAskRepository` — name WHY the repository is unavailable (mt#3636).
 *
 * The eight ask commands previously each threw "AskRepository unavailable —
 * persistence provider does not support SQL". That is loud, which already puts
 * `asks_*` ahead of the task read path this task fixes (that one answered with
 * an empty list). But it cannot tell an operator whether Postgres was never
 * configured or is configured and unreachable — and those need opposite
 * responses. The discriminating detail was on the placeholder all along.
 *
 * Lives in its own file rather than appended to `asks.test.ts`, which is at the
 * 1500-line ceiling.
 *
 * No mocks: `UnconfiguredPersistenceProvider` is the real class, and the
 * container is a hand-written double satisfying the two methods
 * `requireAskRepository` actually calls — the same shape `asks.test.ts`'s
 * `fakeContainer` uses.
 */

import { describe, test, expect } from "bun:test";
import type { AppContainerInterface } from "@minsky/domain/composition/types";
import { UnconfiguredPersistenceProvider } from "@minsky/domain/persistence/unconfigured-provider";
import { requireAskRepository } from "./asks";

/** The verbatim boot failure from the 2026-08-03 incident. */
const BOOT_FAILURE = "getaddrinfo ENOTFOUND";

/** Container whose persistence binding is whatever the test supplies. */
function containerWith(provider: unknown): AppContainerInterface {
  return {
    has: (key: string) => key === "persistence",
    get: (_key: string) => provider,
  } as unknown as AppContainerInterface;
}

/** Await a rejection and return it as an Error, without narrowing games. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  return (await promise.then(
    () => new Error("expected a rejection, got a resolved value"),
    (e: unknown) => e
  )) as Error;
}

describe("requireAskRepository (mt#3636)", () => {
  test("configured-but-unavailable: the error carries the boot failure", async () => {
    const provider = new UnconfiguredPersistenceProvider(BOOT_FAILURE, true);

    const error = await rejection(requireAskRepository(containerWith(provider), "asks.list"));

    expect(error.message).toContain("asks.list");
    expect(error.message).toContain(BOOT_FAILURE);
    expect(error.message).toContain("Postgres IS configured");
  });

  test("deliberately unconfigured: the error points at the config instead", async () => {
    const provider = new UnconfiguredPersistenceProvider(
      "no Postgres connection configured",
      false
    );

    const error = await rejection(requireAskRepository(containerWith(provider), "asks.create"));

    expect(error.message).toContain("asks.create");
    expect(error.message).toContain("persistence.postgres.connectionString");
    expect(error.message).not.toContain("failed to initialize at boot");
  });

  test("no container at all still throws, naming the operation", async () => {
    const error = await rejection(requireAskRepository(undefined, "asks.get"));

    expect(error.message).toContain("asks.get");
    expect(error.message).toContain("AskRepository unavailable");
  });

  test("a healthy provider returns a repository rather than throwing", async () => {
    const fakeDb = { select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }) };
    const container = containerWith({ getDatabaseConnection: async () => fakeDb });

    await expect(requireAskRepository(container, "asks.list")).resolves.toBeDefined();
  });
});
