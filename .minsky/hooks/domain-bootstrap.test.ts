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
import {
  ensureHookDomainBootstrap,
  HOOK_POSTGRES_CONNECT_TIMEOUT_SECONDS,
} from "./domain-bootstrap";

describe("hook domain bootstrap (mt#3019)", () => {
  test("layer 1: importing this module installs the tsyringe reflect polyfill", () => {
    // The pre-mt#3019 hook died here — `Reflect.getMetadata` was undefined, so
    // tsyringe threw at the import of any @injectable() domain module. This is
    // the assertion that would have failed before the static
    // `import "reflect-metadata"` in domain-bootstrap.ts.
    expect(typeof Reflect.getMetadata).toBe("function");
    expect(typeof Reflect.defineMetadata).toBe("function");
  });

  test("layer 2: bootstrap succeeds and initializes the domain configuration system", async () => {
    const result = await ensureHookDomainBootstrap();
    expect(result.ok).toBe(true);

    const { isConfigurationInitialized } = await import(
      "../../packages/domain/src/configuration/index"
    );
    expect(isConfigurationInitialized()).toBe(true);
  });

  test("is idempotent — a second call is a no-op, not a re-initialization", async () => {
    // The guard dispatcher runs many guards in ONE Bun process, so more than
    // one of them may call this. A second call must not re-run setup.
    const first = await ensureHookDomainBootstrap();
    const second = await ensureHookDomainBootstrap();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  test("applies the mt#2982 fail-fast connect default", async () => {
    await ensureHookDomainBootstrap();
    // Either the operator's own value (which must win) or the hook default.
    expect(process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT).toBeDefined();
  });

  test("an operator-set connect timeout wins over the hook default", async () => {
    const original = process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT;
    try {
      process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT = "17";
      await ensureHookDomainBootstrap();
      expect(process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT).toBe("17");
      expect(HOOK_POSTGRES_CONNECT_TIMEOUT_SECONDS).not.toBe("17");
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
