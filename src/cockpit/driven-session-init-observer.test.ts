/**
 * Tests for `createDrivenInitObserver` (mt#4323, ADR-044).
 *
 * The observer does TWO writes with DIFFERENT preconditions — the conversation
 * adoption for every driven session, and the `driven_spawn` link only when the
 * record carries a `minskySessionId`. Everything here is about that asymmetry
 * and about the observer's never-throw contract, because it runs detached on
 * the host's stdout `init` frame where a rejection has nowhere to go.
 *
 * Both collaborators are injected through the existing `DrivenInitObserverDeps`
 * seam rather than patched onto the module, per `testing-standards.mdc
 * §Testable Design`.
 *
 * @see ./driven-session-launch.ts
 * @see mt#4323
 */

import { describe, test, expect } from "bun:test";

import { createDrivenInitObserver, DRIVEN_SESSION_HARNESS } from "./driven-session-launch";
import type { DrivenSessionRecord } from "./driven-session-host";

interface Recorded {
  adoptions: Array<{
    localId: string;
    harnessSessionId: string;
    harness: string;
    actuatorGeneration?: number;
    adoptionReason: string;
  }>;
  links: Array<{ agentSessionId: string; minskySessionId: string }>;
}

function makeRecorded(): Recorded {
  return { adoptions: [], links: [] };
}

/** Minimal record — only the fields the observer reads. */
function makeRecord(overrides: Partial<DrivenSessionRecord> = {}): DrivenSessionRecord {
  return {
    localId: "local-1",
    cwd: "/tmp/workdir",
    startedAt: "2026-08-21T18:00:00.000Z",
    minskySessionId: null,
    harnessSessionId: "conv-a",
    actuatorGeneration: 0,
    ...overrides,
  } as unknown as DrivenSessionRecord;
}

/**
 * The observer detaches its work into a floating promise, so a test has to
 * yield before asserting. One macrotask turn is enough for the awaits inside.
 */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

function makeDeps(
  recorded: Recorded,
  opts: {
    adoptionReason?: Parameters<typeof createDrivenInitObserver>[0]["adoptionReason"];
    getDb?: () => Promise<never>;
    dbNull?: boolean;
    failAdoption?: boolean;
    failLink?: boolean;
  } = {}
) {
  const db = {} as never;
  return {
    adoptionReason: opts.adoptionReason ?? ("initial" as const),
    getDb: opts.getDb ?? (async () => (opts.dbNull ? null : db)),
    recordAdoption: async (_db: unknown, input: Recorded["adoptions"][number]) => {
      if (opts.failAdoption) throw new Error("adoption boom");
      recorded.adoptions.push(input);
      return "written";
    },
    writeLink: async (_db: unknown, input: { agentSessionId: string; minskySessionId: string }) => {
      if (opts.failLink) throw new Error("link boom");
      recorded.links.push(input);
    },
  } as unknown as Parameters<typeof createDrivenInitObserver>[0];
}

describe("createDrivenInitObserver — the adoption is not behind the link's gate", () => {
  test("writes an adoption for a record with NO minskySessionId (the entity-thread case)", async () => {
    const recorded = makeRecorded();
    createDrivenInitObserver(makeDeps(recorded))(makeRecord({ minskySessionId: null }));
    await settle();

    // This is the coverage hole mt#4323 closed. Entity threads are bound to an
    // entity, never to a workspace session, so gating the adoption on
    // minskySessionId would have excluded the exact caller ADR-044 is about.
    expect(recorded.adoptions.length).toBe(1);
    expect(recorded.adoptions[0]?.harnessSessionId).toBe("conv-a");
    expect(recorded.links.length).toBe(0);
  });

  test("writes BOTH when the record carries a minskySessionId", async () => {
    const recorded = makeRecorded();
    createDrivenInitObserver(makeDeps(recorded))(makeRecord({ minskySessionId: "ws-1" }));
    await settle();

    expect(recorded.adoptions.length).toBe(1);
    expect(recorded.links.length).toBe(1);
    expect(recorded.links[0]?.minskySessionId).toBe("ws-1");
  });

  test("writes nothing at all when there is no conversation id yet", async () => {
    const recorded = makeRecorded();
    createDrivenInitObserver(makeDeps(recorded))(
      makeRecord({ harnessSessionId: null, minskySessionId: "ws-1" })
    );
    await settle();

    expect(recorded.adoptions.length).toBe(0);
    expect(recorded.links.length).toBe(0);
  });

  test("carries the caller's adoptionReason and the harness onto the row", async () => {
    const recorded = makeRecorded();
    createDrivenInitObserver(
      makeDeps(recorded, { adoptionReason: "prior-conversation-unrecoverable" })
    )(makeRecord({ actuatorGeneration: 2 }));
    await settle();

    expect(recorded.adoptions[0]?.adoptionReason).toBe("prior-conversation-unrecoverable");
    expect(recorded.adoptions[0]?.harness).toBe(DRIVEN_SESSION_HARNESS);
    expect(recorded.adoptions[0]?.actuatorGeneration).toBe(2);
  });
});

describe("createDrivenInitObserver — never rejects into the host's stdout frame", () => {
  /**
   * Regression test for the defect this task's own implementation introduced
   * and mt#4323 fixed: hoisting the adoption above the `minskySessionId` gate
   * moved the `getDb()` call OUT of the link write's try, so a resolution
   * failure became an unhandled rejection on a detached promise — for every
   * driven session, on the init frame. `getContextInspectorDb` throws rather
   * than returning null whenever persistence failed to initialize at boot
   * (ADR-035's memoized-failed-initializer class, mt#4383), so this is a live
   * production path, not a test-only one.
   */
  test("a THROWING getDb is caught, not left to reject", async () => {
    const recorded = makeRecorded();
    let unhandled: unknown;
    const onUnhandled = (err: unknown) => {
      unhandled = err;
    };
    // `process.on`/`removeListener` rather than `off`: bun's ambient process
    // type in this project declares the former and not the latter.
    const proc = process as unknown as {
      on(event: string, fn: (err: unknown) => void): void;
      removeListener(event: string, fn: (err: unknown) => void): void;
    };
    proc.on("unhandledRejection", onUnhandled);

    try {
      createDrivenInitObserver(
        makeDeps(recorded, {
          getDb: async () => {
            throw new Error("persistence failed to initialize at boot");
          },
        })
      )(makeRecord({ minskySessionId: "ws-1" }));
      await settle();

      expect(unhandled).toBeUndefined();
      expect(recorded.adoptions.length).toBe(0);
      expect(recorded.links.length).toBe(0);
    } finally {
      proc.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("a null db short-circuits both writes without throwing", async () => {
    const recorded = makeRecorded();
    createDrivenInitObserver(makeDeps(recorded, { dbNull: true }))(
      makeRecord({ minskySessionId: "ws-1" })
    );
    await settle();

    expect(recorded.adoptions.length).toBe(0);
    expect(recorded.links.length).toBe(0);
  });

  test("a failing ADOPTION write still lets the link write run", async () => {
    const recorded = makeRecorded();
    createDrivenInitObserver(makeDeps(recorded, { failAdoption: true }))(
      makeRecord({ minskySessionId: "ws-1" })
    );
    await settle();

    // The two writes are independent facts; one failing must not silently
    // cost the other.
    expect(recorded.adoptions.length).toBe(0);
    expect(recorded.links.length).toBe(1);
  });

  test("a failing LINK write still leaves the adoption recorded", async () => {
    const recorded = makeRecorded();
    createDrivenInitObserver(makeDeps(recorded, { failLink: true }))(
      makeRecord({ minskySessionId: "ws-1" })
    );
    await settle();

    expect(recorded.adoptions.length).toBe(1);
    expect(recorded.links.length).toBe(0);
  });
});
