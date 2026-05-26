/**
 * Tests for PersistenceProviderFactory error messages.
 *
 * mt#1280: the factory's error messages were generic before and made the
 * 4.5-hour hosted-MCP outage hard to diagnose. These tests lock in the
 * specific failure-mode messages — they must name the missing config path
 * AND the env var that should populate it, so the next misconfig is not a
 * 4-hour mystery.
 */

import { describe, test, expect } from "bun:test";
import { PersistenceProviderFactory } from "./factory";
import type { PersistenceConfig } from "./types";

describe("PersistenceProviderFactory error messages (mt#1280)", () => {
  test("postgres backend without postgres block names both env vars", async () => {
    const config: PersistenceConfig = {
      backend: "postgres",
    } as PersistenceConfig;

    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /persistence\.backend='postgres' but persistence\.postgres is undefined/
    );
    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /MINSKY_PERSISTENCE_POSTGRES_URL/
    );
    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(/MINSKY_POSTGRES_URL/);
  });

  test("postgres backend with empty connectionString names both env vars", async () => {
    const config: PersistenceConfig = {
      backend: "postgres",
      postgres: { connectionString: "" },
    } as PersistenceConfig;

    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /persistence\.postgres\.connectionString is empty or whitespace/
    );
    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /MINSKY_PERSISTENCE_POSTGRES_URL/
    );
    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(/MINSKY_POSTGRES_URL/);
  });

  test("postgres backend with whitespace-only connectionString fails the same way", async () => {
    const config: PersistenceConfig = {
      backend: "postgres",
      postgres: { connectionString: "   \t\n  " },
    } as PersistenceConfig;

    await expect(PersistenceProviderFactory.create(config)).rejects.toThrow(
      /persistence\.postgres\.connectionString is empty or whitespace/
    );
  });
});
