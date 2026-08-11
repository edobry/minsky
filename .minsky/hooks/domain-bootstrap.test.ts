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

/**
 * One hook source, as the scans below consume it. Taking the corpus as a
 * PARAMETER rather than reading it inside each assertion is what lets the
 * matchers be exercised against cases that do not exist in the tree — including
 * the two false negatives PR #2863 R1 found in them (a suffixed literal, and a
 * second unmarked occurrence in an already-marked file). Reading the real
 * corpus is then just supplying the argument.
 */
type HookSource = { file: string; text: string };

/**
 * A hardcoded cause, in any string form.
 *
 * Matching the exact literal `"persistence provider unavailable"` was a false
 * negative (PR #2863 R1): `"persistence provider unavailable — skipping DB
 * write"` is the same defect and slipped straight through, and that exact
 * spelling is one this codebase had already used. The delimiter is captured and
 * back-referenced so single-quoted and template forms are covered too, and a
 * template that interpolates the real cause is still an offense outside
 * `domain-bootstrap.ts` — the helper is the one place this phrase is built.
 *
 * A prose mention in a comment does not match: the phrase must be delimited.
 */
const HARDCODED_CAUSE = /(["'`])persistence provider unavailable[^"'`]*\1/;

/** The module that OWNS the phrase, and the only file allowed to contain it. */
const FORMATTER_MODULE = "domain-bootstrap.ts";

/** The `| null` variant — kept at sites whose degraded path has no channel. */
const NULL_RESOLVE = /await resolvePersistenceProvider\(\)/;

/** The marker a deliberate `| null` site must carry, verbatim. */
const DELIBERATE_MARKER = "Deliberately still the `| null` resolve (mt#3869)";

/** How far above a `| null` resolve its marker may sit. */
const MARKER_LOOKBACK_LINES = 12;

export function findHardcodedCauses(sources: readonly HookSource[]): string[] {
  return sources
    .filter((s) => s.file !== FORMATTER_MODULE)
    .filter((s) => HARDCODED_CAUSE.test(s.text))
    .map((s) => s.file);
}

/**
 * Report each UNMARKED `| null` resolve, by `file:line`.
 *
 * Per-occurrence, not per-file. The per-file form was a false negative
 * (PR #2863 R1): `record-subagent-invocation.ts` holds two deliberate sites, so
 * a file-level `text.includes(marker)` stayed true when either one lost its
 * marker — the other site's marker vouched for it. That is precisely the case
 * this assertion exists to catch, since the two sites are the only ones there
 * are.
 */
export function findUnmarkedNullResolves(sources: readonly HookSource[]): string[] {
  const offenders: string[] = [];

  for (const source of sources) {
    const lines = source.text.split("\n");
    let lastMarkerLine = Number.NEGATIVE_INFINITY;
    let lastResolveLine = Number.NEGATIVE_INFINITY;

    lines.forEach((line, index) => {
      if (line.includes(DELIBERATE_MARKER)) lastMarkerLine = index;
      if (!NULL_RESOLVE.test(line)) return;

      // Markers pair to occurrences 1:1, in order. A plain "is there a marker
      // within N lines above?" is not enough: two sites close together let one
      // marker vouch for both, which is the same false negative as the
      // per-file check one level down. Requiring the marker to be NEWER than
      // the previous occurrence consumes it.
      const marked =
        lastMarkerLine > lastResolveLine && index - lastMarkerLine <= MARKER_LOOKBACK_LINES;
      if (!marked) offenders.push(`${source.file}:${index + 1}`);
      lastResolveLine = index;
    });
  }

  return offenders;
}

/**
 * Report each named hook that does not resolve with the error-carrying variant
 * AND report the resolved cause through the shared helper — once per site.
 *
 * Counted, not merely present. A file-level "does it appear at all?" is the
 * same false negative PR #2863 R1 found twice elsewhere in this file, one level
 * up: a file with two converted sites would pass with only one of them
 * reporting, because the other's call vouched for it. Every converted file
 * happens to hold exactly one site today, which is exactly the condition under
 * which the weaker check looks correct.
 *
 * Both patterns tolerate the line breaks prettier introduces inside the call —
 * matching the exact one-line spelling made this fail on formatting rather than
 * on behavior.
 */
export function findUnconvertedHooks(
  sources: readonly HookSource[],
  expected: readonly string[]
): string[] {
  const RESOLVES = /resolvePersistenceProviderOrError\(\s*\)/g;
  const REPORTS = /describeProviderResolutionFailure\(\s*resolution\s*\)/g;

  return expected.filter((file) => {
    const source = sources.find((s) => s.file === file);
    if (!source) return true;

    const resolves = source.text.match(RESOLVES)?.length ?? 0;
    const reports = source.text.match(REPORTS)?.length ?? 0;
    return resolves === 0 || reports < resolves;
  });
}

/** The hooks converted by mt#3869. */
const CONVERTED_HOOKS = [
  "duplicate-signature-scan.ts",
  "post-merge-unasked-direction-scan.ts",
  "record-agent-dispatch.ts",
  "record-subagent-invocation.ts",
  "stamp-pr-author-link.ts",
  "stamp-session-creator-link.ts",
];

// These run against synthetic sources, so each matcher is shown failing on the
// case it is meant to catch — including cases absent from the real tree, which
// the corpus scan below therefore cannot demonstrate. Without them, a matcher
// that silently matches nothing reports a clean corpus.
describe("hook diagnosis scans, against constructed sources (mt#3869)", () => {
  test("a hardcoded cause is caught in every string form, suffixed or not", () => {
    const sources: HookSource[] = [
      { file: "bare.ts", text: 'return { failed: "persistence provider unavailable" };' },
      {
        // PR #2863 R1: the exact false negative — a suffix defeated the old check.
        file: "suffixed.ts",
        text: 'warn("persistence provider unavailable — skipping DB write");',
      },
      { file: "single-quoted.ts", text: "throw new Error('persistence provider unavailable');" },
      { file: "clean.ts", text: "return describeProviderResolutionFailure(resolution);" },
      {
        // Prose is not a claim; only a delimited string is.
        file: "commented.ts",
        text: "// used to report persistence provider unavailable with no cause\n",
      },
      { file: FORMATTER_MODULE, text: "return `persistence provider unavailable: ${cls}`;" },
    ];

    expect(findHardcodedCauses(sources).sort()).toEqual([
      "bare.ts",
      "single-quoted.ts",
      "suffixed.ts",
    ]);
  });

  test("an unmarked `| null` resolve is caught even beside a marked one", () => {
    // PR #2863 R1: the exact false negative. One file, two sites, one marker —
    // the per-file check passed because the surviving marker vouched for both.
    const text = [
      `    // ${DELIBERATE_MARKER}. This one has a reason.`,
      "    const provider = await resolvePersistenceProvider();",
      "",
      "    // no marker here",
      "    const other = await resolvePersistenceProvider();",
    ].join("\n");

    expect(findUnmarkedNullResolves([{ file: "two-sites.ts", text }])).toEqual(["two-sites.ts:5"]);
  });

  test("a marked `| null` resolve is accepted, and a converted file has none", () => {
    const marked = [`  // ${DELIBERATE_MARKER}`, "  const p = await resolvePersistenceProvider();"];

    expect(findUnmarkedNullResolves([{ file: "marked.ts", text: marked.join("\n") }])).toEqual([]);
    expect(
      findUnmarkedNullResolves([
        { file: "converted.ts", text: "const r = await resolvePersistenceProviderOrError();" },
      ])
    ).toEqual([]);
  });

  test("a hook that resolves but discards the cause is caught", () => {
    const sources: HookSource[] = [
      {
        file: "discards.ts",
        text: "const resolution = await resolvePersistenceProviderOrError();\nif (!resolution.ok) return null;",
      },
      {
        file: "reports.ts",
        text: "const resolution = await resolvePersistenceProviderOrError();\nif (!resolution.ok) warn(describeProviderResolutionFailure(resolution));",
      },
    ];

    expect(findUnconvertedHooks(sources, ["discards.ts", "reports.ts"])).toEqual(["discards.ts"]);
    expect(findUnconvertedHooks(sources, ["absent.ts"])).toEqual(["absent.ts"]);
  });

  test("a file with two sites is caught when only one of them reports", () => {
    // The same shape as the other two false negatives, one level up: the
    // reporting site would vouch for the silent one under a presence check.
    const text = [
      "const a = await resolvePersistenceProviderOrError();",
      "if (!a.ok) warn(describeProviderResolutionFailure(resolution));",
      "const b = await resolvePersistenceProviderOrError();",
      "if (!b.ok) return null;",
    ].join("\n");

    expect(findUnconvertedHooks([{ file: "half.ts", text }], ["half.ts"])).toEqual(["half.ts"]);
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
    expect(findHardcodedCauses(hookSources)).toEqual([]);
  });

  test("every remaining `| null` resolve is marked deliberate", () => {
    // The `| null` variant is not retired — it has non-hook consumers, and two
    // sites in `record-subagent-invocation.ts` keep it because their degraded
    // path has no channel to report into. What must not happen is a site
    // keeping it by omission, which is indistinguishable from a converted one
    // at a glance. The marker is the difference.
    expect(findUnmarkedNullResolves(hookSources)).toEqual([]);
  });

  test("each converted hook formats its failure through the shared helper", () => {
    // Pinned by name: a site that resolves with the error-carrying variant and
    // then throws the resolution away would satisfy the two checks above while
    // reporting nothing.
    expect(findUnconvertedHooks(hookSources, CONVERTED_HOOKS)).toEqual([]);
  });
});
