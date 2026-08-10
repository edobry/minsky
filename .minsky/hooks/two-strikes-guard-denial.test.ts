import { describe, expect, test } from "bun:test";

import { recordGuardDenial, type HookDeps } from "./two-strikes-record";
import { TwoStrikesTracker } from "../../packages/domain/src/two-strikes/tracker";
import { fingerprintGuardDenial } from "../../packages/domain/src/two-strikes/fingerprint";

/**
 * mt#3802 — the 2-strikes tracker was PostToolUse-only, so a PreToolUse guard
 * denial (where the tool never runs) was structurally invisible. These cover
 * the task's four acceptance tests against an in-memory fs, plus the wiring
 * assertion that keeps the dispatcher's injected recorder from regressing to
 * its no-op default.
 */

/** In-memory `HookDeps`, so nothing touches the real state directory. */
function memoryDeps(): HookDeps & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    stateDir: STATE_DIR,
    mode: "observation",
    fs: {
      exists: (path: string) => files.has(path) || path === STATE_DIR,
      mkdirP: () => {},
      readText: (path: string) => files.get(path) ?? "",
      writeText: (path: string, contents: string) => {
        files.set(path, contents);
      },
      appendText: (path: string, contents: string) => {
        files.set(path, (files.get(path) ?? "") + contents);
      },
    },
  } as HookDeps & { files: Map<string, string> };
}

const STATE_DIR = "/virtual/two-strikes";
const OBSERVATIONS = `${STATE_DIR}/observations.jsonl`;
const GIT_GUARD = "block-git-gh-cli";
const SECRET_GUARD = "block-secret-file-read";

function observationsIn(deps: { files: Map<string, string> }): Record<string, unknown>[] {
  const raw = deps.files.get(OBSERVATIONS);
  if (!raw) return [];
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

const DENIAL = {
  sessionId: "sess-1",
  toolName: "Bash",
  guardName: GIT_GUARD,
  reason: "Use `mcp__minsky__git_status` instead of `git status`.",
  toolInput: { command: "git status --short | head -2" },
};

describe("AT1 — a second identical denial is recorded", () => {
  test("two byte-identical denials in one session produce an observation", () => {
    const deps = memoryDeps();

    recordGuardDenial(DENIAL, deps);
    expect(observationsIn(deps)).toHaveLength(0); // first strike is silent

    recordGuardDenial(DENIAL, deps);

    const observations = observationsIn(deps);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.guardName).toBe(GIT_GUARD);
    expect(observations[0]?.toolName).toBe("Bash");
    expect(observations[0]?.sessionId).toBe("sess-1");
  });

  test("the streak survives across CALLS, which is the whole point", () => {
    // Each hook invocation is its own process; the streak lives in the state
    // file, not in memory. Two separate recordGuardDenial calls sharing only
    // `deps` is exactly that situation.
    const deps = memoryDeps();
    recordGuardDenial(DENIAL, deps);
    const afterFirst = deps.files.get(`${STATE_DIR}/sess-1.json`);
    expect(afterFirst).toContain(GIT_GUARD);

    recordGuardDenial(DENIAL, deps);
    expect(observationsIn(deps)).toHaveLength(1);
  });
});

describe("AT2 — a single denial produces no entry", () => {
  test("one denial records a streak but no observation", () => {
    const deps = memoryDeps();
    recordGuardDenial(DENIAL, deps);
    expect(observationsIn(deps)).toHaveLength(0);
  });
});

describe("AT3 — different guards do not collapse into one fingerprint", () => {
  test("two denials from different guards on the same tool do not fire", () => {
    const deps = memoryDeps();

    recordGuardDenial(DENIAL, deps);
    recordGuardDenial({ ...DENIAL, guardName: SECRET_GUARD, reason: "other reason" }, deps);

    expect(observationsIn(deps)).toHaveLength(0);
  });

  test("their fingerprints differ by construction", () => {
    const a = fingerprintGuardDenial(DENIAL);
    const b = fingerprintGuardDenial({ ...DENIAL, guardName: SECRET_GUARD });
    expect(a.hash).not.toBe(b.hash);
  });

  test("each guard still accumulates its own streak independently", () => {
    const deps = memoryDeps();
    const other = { ...DENIAL, guardName: SECRET_GUARD, reason: "other reason" };

    recordGuardDenial(DENIAL, deps);
    recordGuardDenial(other, deps);
    recordGuardDenial(DENIAL, deps); // second strike for the FIRST guard

    const observations = observationsIn(deps);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.guardName).toBe(GIT_GUARD);
  });
});

describe("SC2 — the record distinguishes the surface", () => {
  test("a denial observation is tagged guard-denial", () => {
    const deps = memoryDeps();
    recordGuardDenial(DENIAL, deps);
    recordGuardDenial(DENIAL, deps);

    expect(observationsIn(deps)[0]?.source).toBe("guard-denial");
  });

  test("a PostToolUse tool error is NOT tagged as a denial", () => {
    const tracker = new TwoStrikesTracker({ mode: "observation" });
    tracker.recordError("Bash", new Error("boom"));
    tracker.recordError("Bash", new Error("boom"));

    const [observation] = tracker.drainObservations();
    expect(observation?.source).toBeUndefined();
  });

  test("a denial and a tool error on the SAME tool keep separate streaks", () => {
    // Without a distinct streak key these evict each other, and a real second
    // strike on either surface is lost.
    const tracker = new TwoStrikesTracker({ mode: "observation" });
    tracker.recordError("Bash", new Error("boom"));
    tracker.recordDenial(DENIAL);
    tracker.recordError("Bash", new Error("boom")); // still a second strike

    expect(tracker.drainObservations()).toHaveLength(1);
  });
});

describe("SC3 — the byte-identical input tell is recorded", () => {
  test("both input hashes are carried, and match on an identical repeat", () => {
    const deps = memoryDeps();
    recordGuardDenial(DENIAL, deps);
    recordGuardDenial(DENIAL, deps);

    const observation = observationsIn(deps)[0];
    expect(observation?.firstInputHash).toBeTruthy();
    expect(observation?.secondInputHash).toBe(observation?.firstInputHash as string);
  });

  test("a varied input still fires on the shared reason, and the hashes differ", () => {
    // SC1 keys the streak on (guard, reason), so varying the command does not
    // escape the strike — but the record shows the input was NOT identical,
    // which is the weaker-signal case.
    const deps = memoryDeps();
    recordGuardDenial(DENIAL, deps);
    recordGuardDenial({ ...DENIAL, toolInput: { command: "git status --short" } }, deps);

    const observation = observationsIn(deps)[0];
    expect(observation).toBeTruthy();
    expect(observation?.secondInputHash).not.toBe(observation?.firstInputHash as string);
  });

  test("input hashing is key-order independent", () => {
    const a = fingerprintGuardDenial({ ...DENIAL, toolInput: { command: "x", description: "y" } });
    const b = fingerprintGuardDenial({ ...DENIAL, toolInput: { description: "y", command: "x" } });
    expect(a.inputHash).toBe(b.inputHash);
  });
});

describe("SC4 — recording is best-effort", () => {
  test("a failing state store does not throw", () => {
    const exploding = {
      stateDir: STATE_DIR,
      mode: "observation",
      fs: {
        exists: () => true,
        mkdirP: () => {},
        readText: () => {
          throw new Error("disk gone");
        },
        writeText: () => {
          throw new Error("disk gone");
        },
        appendText: () => {
          throw new Error("disk gone");
        },
      },
    } as unknown as HookDeps;

    expect(() => recordGuardDenial(DENIAL, exploding)).not.toThrow();
  });

  test("a missing tool or guard name is a no-op rather than a crash", () => {
    const deps = memoryDeps();
    expect(() => recordGuardDenial({ ...DENIAL, toolName: "" }, deps)).not.toThrow();
    expect(() => recordGuardDenial({ ...DENIAL, guardName: "" }, deps)).not.toThrow();
    expect(observationsIn(deps)).toHaveLength(0);
  });
});

describe("SC5 — mode stays observation", () => {
  test("the recorder does not flip the tracker to live", () => {
    const deps = memoryDeps();
    recordGuardDenial(DENIAL, deps);

    const state = JSON.parse(deps.files.get(`${STATE_DIR}/sess-1.json`) ?? "{}") as {
      mode: string;
    };
    expect(state.mode).toBe("observation");
  });
});

// The invocation-path assertions (that the entrypoint actually wires the
// recorder, and that block-git-gh-cli records its own denials until it migrates)
// live in `tests/architecture/two-strikes-denial-wiring.test.ts` — they read
// source text, which belongs in the architecture suite rather than here.
