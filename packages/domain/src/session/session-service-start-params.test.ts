import { describe, expect, it } from "bun:test";

import { buildSessionStartParams } from "./session-service";
import { SessionStartParametersSchema } from "../schemas/session-schemas";

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

    // mt#3212: `description` is NO LONGER coerced to `""`. It used to be, only
    // because `SessionStartParametersSchema` wrongly required it; an empty
    // string satisfied the TYPE while failing the schema's own `min(1)`. The
    // domain reads it as a truthy auto-create trigger, so undefined and "" were
    // always the same behavior — one of them was just a lie about the contract.
    expect(built.description).toBeUndefined();
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

  // mt#3212 / mt#3956. The bare `session start --task <id>` invocation: the
  // caller supplies NEITHER a session id nor a description, because both are
  // derived from the task. This asserts the whole point of reconciling the two
  // schemas — the built params satisfy the DOMAIN schema at runtime, not merely
  // a cast at compile time. Before this change `SessionStartParametersSchema`
  // required both fields, so this parse failed while `as` kept the build green.
  it("builds params a bare --task invocation can actually satisfy", () => {
    const built = buildSessionStartParams(startParams({}));

    expect(built.sessionId).toBeUndefined();
    expect(built.description).toBeUndefined();

    const parsed = SessionStartParametersSchema.safeParse(built);
    expect(parsed.success).toBe(true);
  });

  it("carries the domain-only launch intent through", () => {
    const built = buildSessionStartParams(startParams({ launchIntent: "autonomous" }));

    expect(built.launchIntent).toBe("autonomous");
  });
});
