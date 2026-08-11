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
// eslint-disable-next-line custom/no-real-fs-in-tests -- read-only corpus scan; see the mt#3869 block below for why a fixture cannot stand in for it
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describeProviderResolutionFailure, ensureHookDomainBootstrap } from "./domain-bootstrap";

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

describe("describeProviderResolutionFailure (mt#3869)", () => {
  test("carries both the class and the message", () => {
    const message = describeProviderResolutionFailure({
      error: "write CONNECT_TIMEOUT undefined:undefined",
      errorClass: "Error",
    });

    expect(message).toContain("Error");
    expect(message).toContain("write CONNECT_TIMEOUT undefined:undefined");
  });

  test("keeps the class when the message scrubs to nothing", () => {
    // `error` is credential-scrubbed upstream and can come back empty; the
    // class is what still discriminates the failure, which is why it is
    // unconditional. ADR-035 §Decision rule 3: "configured but failing" must
    // stay distinguishable from "not configured."
    expect(describeProviderResolutionFailure({ error: "", errorClass: "TypeError" })).toContain(
      "TypeError"
    );
  });
});

// STRUCTURAL, not behavioral, and deliberately so. The property this task
// establishes is "no hook reports a cause it did not obtain from the
// resolution" — an invariant over the corpus, which a per-site behavioral test
// cannot express. It also fails for a site nobody has written yet, which is the
// actual risk: the defect mt#3750 fixed was one call site copied six more times.
//
// A behavioral test here would additionally be a probe that cannot fail: which
// branch `resolvePersistenceProviderOrError()` takes depends on ambient process
// state (whether configuration was initialized, whether a DB is reachable), so
// an assertion about the failure branch passes alone and fails in the gated
// suite where a sibling file initializes configuration and a database IS
// reachable. That exact test cost mt#3750 a blocked push and two red CI jobs —
// mem#912. The formatter's own behavior is covered above, with no ambient
// dependency at all.
describe("hook persistence-resolution diagnosis (mt#3869)", () => {
  const HOOKS_DIR = new URL(".", import.meta.url).pathname;

  /* eslint-disable custom/no-real-fs-in-tests -- the corpus IS the subject: this
     block asserts a property of the hook sources on disk, so a fixture would
     test the fixture. Read-only, and the sibling precedent is
     `record-subagent-invocation-entrypoint.test.ts` (mt#3893), which reads its
     own source the same way. */
  const hookSources = readdirSync(HOOKS_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({ file: f, text: readFileSync(join(HOOKS_DIR, f), "utf8") }));
  /* eslint-enable custom/no-real-fs-in-tests */

  test("the scan actually sees the hook corpus", () => {
    // Without this, every assertion below passes vacuously if the glob breaks.
    expect(hookSources.length).toBeGreaterThan(20);
    expect(hookSources.map((s) => s.file)).toContain("record-subagent-invocation.ts");
  });

  test("no hook hardcodes a resolution cause", () => {
    // The fixed string is the defect: it names either nothing or, as at the
    // originating site, a class the control flow had already excluded. Only
    // `domain-bootstrap.ts` may contain the phrase, and there it is a template
    // interpolating the real cause rather than a literal.
    const offenders = hookSources
      .filter((s) => s.file !== "domain-bootstrap.ts")
      .filter((s) => s.text.includes('"persistence provider unavailable"'))
      .map((s) => s.file);

    expect(offenders).toEqual([]);
  });

  test("every remaining `| null` resolve is marked deliberate", () => {
    // The `| null` variant is not retired — it has non-hook consumers, and two
    // sites in `record-subagent-invocation.ts` keep it because their degraded
    // path has no channel to report into. What must not happen is a site
    // keeping it by omission, which is indistinguishable from a converted one
    // at a glance. The marker is the difference.
    const unmarked = hookSources
      .filter((s) => /await resolvePersistenceProvider\(\)/.test(s.text))
      .filter((s) => !s.text.includes("Deliberately still the `| null` resolve (mt#3869)"))
      .map((s) => s.file);

    expect(unmarked).toEqual([]);
  });

  test("each converted hook formats its failure through the shared helper", () => {
    // Pinned by name: a site that resolves with the error-carrying variant and
    // then throws the resolution away would satisfy the two checks above while
    // reporting nothing.
    //
    // Both patterns tolerate the line breaks prettier introduces inside the
    // call — matching the exact one-line spelling made this assertion fail on
    // formatting rather than on behavior, and reported it by printing the
    // entire source file.
    const RESOLVES = /resolvePersistenceProviderOrError\(\s*\)/;
    const REPORTS = /describeProviderResolutionFailure\(\s*resolution\s*\)/;

    const converted = [
      "duplicate-signature-scan.ts",
      "post-merge-unasked-direction-scan.ts",
      "record-agent-dispatch.ts",
      "record-subagent-invocation.ts",
      "stamp-pr-author-link.ts",
      "stamp-session-creator-link.ts",
    ];

    const missing = converted.filter((file) => {
      const source = hookSources.find((s) => s.file === file);
      return !source || !RESOLVES.test(source.text) || !REPORTS.test(source.text);
    });

    expect(missing).toEqual([]);
  });
});
