import { describe, expect, it } from "bun:test";

import { buildSessionStartParams } from "./session-service";

// ---------------------------------------------------------------------------
// mt#3955 — the service -> domain hop must not drop caller-supplied flags.
//
// This layer had NO test coverage, which is the reason a defect fixed once at
// the adapter -> service hop (mt#2742) could recur, unchanged in shape, one hop
// later. `startSessionImpl`'s own suite could never have caught it: those tests
// call the domain directly and so never cross the boundary that drops the flag.
//
// The assertions are on the constructed params rather than on a patched
// `startSessionImpl`, per `testing-standards.mdc §Testable Design`.
// ---------------------------------------------------------------------------

type StartParams = Parameters<typeof buildSessionStartParams>[0];

/**
 * `quiet` / `noStatusUpdate` / `skipInstall` carry schema defaults, so they are
 * REQUIRED on the inferred input type even though a caller never sets them.
 * Supplying them here keeps each test's literal down to the field under test.
 */
const startParams = (over: Partial<StartParams>): StartParams =>
  ({
    task: "md#999",
    quiet: false,
    noStatusUpdate: false,
    skipInstall: false,
    ...over,
  }) as StartParams;

describe("buildSessionStartParams", () => {
  // The regression. `recover` reaching the domain is the whole defect: without
  // it, `startSessionImpl` takes its non-recover branch and re-emits the
  // "session appears abandoned" error to an operator who just followed that
  // error's instruction to pass --recover.
  it("forwards recover to the domain", () => {
    expect(buildSessionStartParams(startParams({ recover: true })).recover).toBe(true);
    expect(buildSessionStartParams(startParams({ recover: false })).recover).toBe(false);
  });

  // The general property, not just the one field — a hand-written field list is
  // what failed twice, so this asserts the RULE rather than re-listing them.
  it("forwards every caller-supplied field it does not deliberately override", () => {
    const built = buildSessionStartParams(
      startParams({
        sessionId: "sess-1",
        branch: "task/md-999",
        repo: "/tmp/repo",
        recover: true,
      })
    );

    expect(built.task).toBe("md#999");
    expect(built.sessionId).toBe("sess-1");
    expect(built.branch).toBe("task/md-999");
    expect(built.repo).toBe("/tmp/repo");
    expect(built.recover).toBe(true);
  });

  it("applies defaults only where the caller supplied nothing", () => {
    const built = buildSessionStartParams(startParams({}));

    expect(built.description).toBe("");
    expect(built.packageManager).toBe("bun");
    expect(built.skipInstall).toBe(false);
    expect(built.noStatusUpdate).toBe(false);
    expect(built.quiet).toBe(false);
  });

  it("keeps a caller's value over the default", () => {
    const built = buildSessionStartParams(
      startParams({
        description: "a description",
        packageManager: "npm",
        skipInstall: true,
        noStatusUpdate: true,
        quiet: true,
      })
    );

    expect(built.description).toBe("a description");
    expect(built.packageManager).toBe("npm");
    expect(built.skipInstall).toBe(true);
    expect(built.noStatusUpdate).toBe(true);
    expect(built.quiet).toBe(true);
  });

  // These three are this layer's decision, not the caller's. They sit after the
  // spread precisely so a caller cannot set them; pinned so a future reordering
  // that moves the spread last is caught.
  it("overrides the values this layer fixes, even when the caller sets them", () => {
    const built = buildSessionStartParams({
      ...startParams({}),
      debug: true,
      force: true,
      format: "json",
    } as StartParams);

    expect(built.debug).toBe(false);
    expect(built.force).toBe(false);
    expect(built.format).toBe("text");
  });

  it("carries the domain-only launch intent through", () => {
    const built = buildSessionStartParams(startParams({ launchIntent: "autonomous" }));

    expect(built.launchIntent).toBe("autonomous");
  });
});
