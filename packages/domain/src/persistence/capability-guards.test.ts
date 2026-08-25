/**
 * mt#4543 AT1 — the capability guards, against the REAL unconfigured provider.
 *
 * The defect these replace was a method-presence check that could never fire, because
 * `UnconfiguredPersistenceProvider` defines the very method the check looked for. So the
 * load-bearing case here is that exact class, constructed for real — not a fake, which
 * would have whatever shape the test author believed it had, which is the belief that
 * produced the defect (mt#4537 / PR #3311 R1).
 *
 * Note what is deliberately NOT asserted: which provider the container resolves. That is
 * ambient state a test does not own — mem#912 records a test that asserted exactly that
 * and passed alone while failing in the gated suite, because a sibling file initialized
 * configuration in the shared process. These construct their subject directly.
 */

import { describe, test, expect } from "bun:test";

import { UnconfiguredPersistenceProvider } from "./unconfigured-provider";
import {
  hasListenCapableSqlConnection,
  hasRawSqlConnection,
  isSqlCapable,
  isVectorCapable,
  type PersistenceCapabilities,
} from "./types";

const SQL_ONLY: PersistenceCapabilities = {
  sql: true,
  transactions: true,
  jsonb: true,
  vectorStorage: false,
  migrations: true,
};

/** A SQL-capable provider exposing capabilities through the METHOD. */
function viaMethod(capabilities: PersistenceCapabilities, extra: Record<string, unknown> = {}) {
  return {
    capabilities,
    getCapabilities: () => capabilities,
    initialize: async () => {},
    close: async () => {},
    getConnectionInfo: () => "test double",
    getDatabaseConnection: async () => ({}),
    ...extra,
  };
}

/** The same, exposing capabilities through the PROPERTY only — the other half of the
 * repo's test doubles, and the reason `readCapabilities` consults both. */
function viaProperty(capabilities: PersistenceCapabilities, extra: Record<string, unknown> = {}) {
  return {
    capabilities,
    initialize: async () => {},
    close: async () => {},
    getConnectionInfo: () => "test double",
    getDatabaseConnection: async () => ({}),
    ...extra,
  };
}

describe("isSqlCapable", () => {
  test("is false for the never-configured placeholder, which DEFINES getDatabaseConnection", () => {
    const provider = new UnconfiguredPersistenceProvider("no connection string");

    // The property that defeated the old idiom, asserted here so the test documents
    // WHY the guard cannot be a method-presence check.
    expect(typeof provider.getDatabaseConnection).toBe("function");
    expect(isSqlCapable(provider)).toBe(false);
  });

  test("is false for the configured-but-failed placeholder too", () => {
    const provider = new UnconfiguredPersistenceProvider(
      "connection refused",
      /* configuredButUnavailable */ true
    );

    expect(provider.configuredButUnavailable).toBe(true);
    expect(isSqlCapable(provider)).toBe(false);
  });

  test("is true for a SQL-capable provider, whichever way it exposes capabilities", () => {
    expect(isSqlCapable(viaMethod(SQL_ONLY))).toBe(true);
    expect(isSqlCapable(viaProperty(SQL_ONLY))).toBe(true);
  });

  test("fails closed on anything that cannot answer the question", () => {
    expect(isSqlCapable(null)).toBe(false);
    expect(isSqlCapable(undefined)).toBe(false);
    expect(isSqlCapable("a string")).toBe(false);
    expect(isSqlCapable({})).toBe(false);
    expect(isSqlCapable({ capabilities: "not an object" })).toBe(false);
    expect(
      isSqlCapable({
        getCapabilities: () => {
          throw new Error("provider is wedged");
        },
      })
    ).toBe(false);
  });
});

describe("isVectorCapable", () => {
  test("separates the vector axis from the sql axis", () => {
    expect(isVectorCapable(viaMethod(SQL_ONLY))).toBe(false);
    expect(isVectorCapable(viaMethod({ ...SQL_ONLY, vectorStorage: true }))).toBe(true);
    expect(isVectorCapable(new UnconfiguredPersistenceProvider("none"))).toBe(false);
  });
});

describe("hasRawSqlConnection / hasListenCapableSqlConnection", () => {
  test("require the capability AND the optional method", () => {
    // SQL-capable but the optional method is absent — a legitimate provider shape, and
    // the reason these are not simply isSqlCapable.
    expect(hasRawSqlConnection(viaMethod(SQL_ONLY))).toBe(false);
    expect(
      hasRawSqlConnection(viaMethod(SQL_ONLY, { getRawSqlConnection: async () => ({}) }))
    ).toBe(true);

    expect(hasListenCapableSqlConnection(viaMethod(SQL_ONLY))).toBe(false);
    expect(
      hasListenCapableSqlConnection(
        viaMethod(SQL_ONLY, { getListenCapableSqlConnection: async () => ({}) })
      )
    ).toBe(true);
  });

  test("reject the unconfigured placeholder even though it defines both methods", () => {
    const provider = new UnconfiguredPersistenceProvider("no connection string");

    // Both methods exist on it and both throw — the presence-only check passed here,
    // which is the whole defect.
    expect(typeof provider.getRawSqlConnection).toBe("function");
    expect(hasRawSqlConnection(provider)).toBe(false);
    expect(hasListenCapableSqlConnection(provider)).toBe(false);
  });
});
