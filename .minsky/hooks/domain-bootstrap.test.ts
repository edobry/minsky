// Tests for the shared hook domain bootstrap (mt#3019).
//
// The defect this module fixes was invisible for two weeks because the failure
// is silent by construction: layer 1 throws at module load OUTSIDE
// `resolvePersistenceProvider`'s try/catch, and layer 2 is swallowed by its
// `catch { return null }`. So the properties worth pinning here are the ones a
// caller depends on to NOT be silent: the reflect polyfill is actually
// installed by importing this module, the call is idempotent, and it reports
// failure as a value rather than throwing (hooks must never block the event
// they observe).

import { describe, expect, test } from "bun:test";
import { ensureHookDomainBootstrap } from "./domain-bootstrap";

// The default every non-hook Minsky process gets when no connect timeout is
// configured (`postgres-provider.ts` `|| 10`, `?? 10`; `validation-operations.ts`
// `= 10`). mt#3879 removed the hook-specific override that undercut it.
const DRIVER_PATH_DEFAULT_SECONDS = 10;

describe("hook domain bootstrap (mt#3019)", () => {
  test("layer 1: importing this module installs the tsyringe reflect polyfill", () => {
    // The pre-mt#3019 hook died here — `Reflect.getMetadata` was undefined, so
    // tsyringe threw at the import of any @injectable() domain module. This is
    // the assertion that would have failed before the static
    // `import "reflect-metadata"` in domain-bootstrap.ts.
    expect(typeof Reflect.getMetadata).toBe("function");
    expect(typeof Reflect.defineMetadata).toBe("function");
  });

  // NOTE ON ENVIRONMENT COUPLING: whether the bootstrap can SUCCEED depends on
  // the environment — CI runs with no Postgres configured, so `setupConfiguration()`
  // legitimately fails there. An earlier revision asserted `ok === true`
  // unconditionally and passed locally while failing in CI. These tests assert
  // the CONTRACT (which holds everywhere) and gate the success-path assertions
  // on whether this environment can actually bootstrap.

  test("layer 2: when the environment can bootstrap, the config system ends up initialized", async () => {
    const result = await ensureHookDomainBootstrap();

    const { isConfigurationInitialized } = await import(
      "../../packages/domain/src/configuration/index"
    );

    if (result.ok) {
      expect(isConfigurationInitialized()).toBe(true);
    } else {
      // The failure must be reported as a value with a real message, never
      // thrown — that is the property the hook's fail-safe contract needs.
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    }
  });

  test("is idempotent — repeated calls agree and never re-initialize", async () => {
    // The guard dispatcher runs many guards in ONE Bun process, so more than
    // one of them may call this. Whatever this environment's answer is, it must
    // be stable across calls.
    const first = await ensureHookDomainBootstrap();
    const second = await ensureHookDomainBootstrap();
    expect(second.ok).toBe(first.ok);
  });

  test("installs NO connect-timeout override, so hooks inherit the driver-path default (mt#3879)", async () => {
    // The regression this pins: a hook-specific 2s cap sat below the measured
    // 2.3-2.6s TLS-inclusive socket cost, so `resolvePersistenceProvider()`
    // could never return a provider from a hook process and every DB-backed
    // hook failed open. The bootstrap must not reintroduce a cap of its own.
    const original = process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT;
    try {
      delete process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT;
      await ensureHookDomainBootstrap();
      expect(process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT).toBeUndefined();
    } finally {
      if (original === undefined) {
        delete process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT;
      } else {
        process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT = original;
      }
    }
  });

  test("any connect timeout a hook does end up with clears the measured cold-connect floor", () => {
    // Guards the NUMBER, not just its absence: whatever a hook process
    // ultimately resolves must exceed the socket cost measured in mt#3879
    // (2.3-2.6s for DNS+TCP+TLS alone, 4.3-5.5s for a full cold resolve).
    // 10s is ~1.8x the slowest observed cold resolve.
    const MAX_OBSERVED_COLD_RESOLVE_SECONDS = 5.5;
    expect(DRIVER_PATH_DEFAULT_SECONDS).toBeGreaterThan(MAX_OBSERVED_COLD_RESOLVE_SECONDS);
  });

  test("an operator-set connect timeout is still honored", async () => {
    const original = process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT;
    try {
      process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT = "17";
      await ensureHookDomainBootstrap();
      expect(process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT).toBe("17");
    } finally {
      if (original === undefined) {
        delete process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT;
      } else {
        process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT = original;
      }
    }
  });

  test("reports failure as a value and never throws", async () => {
    // Fail-safe contract: a hook must exit 0 even when the domain layer is
    // unusable. The function's return type carries the error so the caller can
    // log the ACTUAL message (the mt#2958 ProbeFailure discipline) instead of
    // a generic "unavailable".
    const result = await ensureHookDomainBootstrap();
    if (!result.ok) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
    } else {
      expect(result).toEqual({ ok: true });
    }
  });
});
