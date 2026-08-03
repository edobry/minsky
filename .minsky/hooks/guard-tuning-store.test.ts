/**
 * Unit tests for guard-tuning-store.ts and the precedence chain that reads it
 * (mt#3581, ADR-032 §D1).
 *
 * In-memory fs fake throughout, per `custom/no-real-fs-in-tests` and mirroring
 * `ask-grant-store.test.ts`'s `makeFs`.
 */

import { describe, test, expect } from "bun:test";
import {
  readGuardTuningStore,
  readTunedValue,
  writeTunedValue,
  revertTunedValue,
  type GuardTuningStoreFsDeps,
} from "./guard-tuning-store";
import { readTunedThreshold, PREFERENCE_OVERRIDE_MAX_MULTIPLE } from "./types";

const STORE_PATH = "/mock/state/minsky/guard-tuning.json";
const KEY = "MINSKY_WALL_OF_TEXT_WORD_BUDGET";
const NOW = "2026-08-03T12:00:00.000Z";
const LATER = "2026-08-03T13:00:00.000Z";

/** In-memory fs fake (per custom/no-real-fs-in-tests). */
function makeFs(initial: Record<string, string> = {}): {
  deps: GuardTuningStoreFsDeps;
  files: Record<string, string>;
} {
  const files = { ...initial };
  return {
    files,
    deps: {
      readFileSync: (p) => {
        if (!(p in files)) {
          const err = new Error("ENOENT") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return files[p] as string;
      },
      writeFileSync: (p, data) => {
        files[p] = data;
      },
      mkdirSync: () => {},
    },
  };
}

describe("readGuardTuningStore — fail-open", () => {
  test("a missing file yields an empty store, never a throw", () => {
    const { deps } = makeFs();
    expect(readGuardTuningStore(STORE_PATH, deps)).toEqual({});
  });

  test("malformed JSON yields an empty store", () => {
    const { deps } = makeFs({ [STORE_PATH]: "{not json" });
    expect(readGuardTuningStore(STORE_PATH, deps)).toEqual({});
  });

  test("a JSON array yields an empty store", () => {
    const { deps } = makeFs({ [STORE_PATH]: "[1,2,3]" });
    expect(readGuardTuningStore(STORE_PATH, deps)).toEqual({});
  });

  test("entries outside the positive-integer contract are dropped, not coerced", () => {
    const { deps } = makeFs({
      [STORE_PATH]: JSON.stringify({
        good: { value: 330, appliedAt: NOW },
        fractional: { value: 330.5, appliedAt: NOW },
        zero: { value: 0, appliedAt: NOW },
        negative: { value: -5, appliedAt: NOW },
        stringy: { value: "330", appliedAt: NOW },
        empty: {},
      }),
    });

    // `readPositiveIntEnv` silently falls back to the shipped default for any
    // of these, so keeping them would mean storing values that never apply.
    expect(Object.keys(readGuardTuningStore(STORE_PATH, deps))).toEqual(["good"]);
  });
});

describe("writeTunedValue", () => {
  test("writes a value the reader can read back", () => {
    const { deps } = makeFs();
    writeTunedValue(KEY, 330, { appliedAt: NOW, storePath: STORE_PATH, fsDeps: deps });
    expect(readTunedValue(KEY, STORE_PATH, deps)).toBe(330);
  });

  test("records the value it replaced, so reversal is exact rather than guessed", () => {
    const { deps } = makeFs();
    writeTunedValue(KEY, 330, { appliedAt: NOW, storePath: STORE_PATH, fsDeps: deps });
    const second = writeTunedValue(KEY, 400, {
      appliedAt: LATER,
      storePath: STORE_PATH,
      fsDeps: deps,
    });

    expect(second.previousValue).toBe(330);
    expect(second.value).toBe(400);
  });

  test("the first tune of a threshold records no previous value", () => {
    const { deps } = makeFs();
    const first = writeTunedValue(KEY, 330, {
      appliedAt: NOW,
      storePath: STORE_PATH,
      fsDeps: deps,
    });
    expect(first.previousValue).toBeUndefined();
  });

  test("preserves other thresholds' entries", () => {
    const { deps } = makeFs();
    writeTunedValue("OTHER_KEY", 12, { appliedAt: NOW, storePath: STORE_PATH, fsDeps: deps });
    writeTunedValue(KEY, 330, { appliedAt: NOW, storePath: STORE_PATH, fsDeps: deps });

    expect(readTunedValue("OTHER_KEY", STORE_PATH, deps)).toBe(12);
    expect(readTunedValue(KEY, STORE_PATH, deps)).toBe(330);
  });

  test("a write failure throws rather than silently not applying", () => {
    const { deps } = makeFs();
    const throwing: GuardTuningStoreFsDeps = {
      ...deps,
      writeFileSync: () => {
        throw new Error("EACCES");
      },
    };

    expect(() =>
      writeTunedValue(KEY, 330, { appliedAt: NOW, storePath: STORE_PATH, fsDeps: throwing })
    ).toThrow("EACCES");
  });
});

describe("revertTunedValue", () => {
  test("restores the previous value when there is one", () => {
    const { deps } = makeFs();
    writeTunedValue(KEY, 330, { appliedAt: NOW, storePath: STORE_PATH, fsDeps: deps });
    writeTunedValue(KEY, 400, { appliedAt: LATER, storePath: STORE_PATH, fsDeps: deps });

    expect(revertTunedValue(KEY, { appliedAt: LATER, storePath: STORE_PATH, fsDeps: deps })).toBe(
      330
    );
    expect(readTunedValue(KEY, STORE_PATH, deps)).toBe(330);
  });

  test("removes the entry entirely on the first tune, falling back to the shipped default", () => {
    const { deps } = makeFs();
    writeTunedValue(KEY, 330, { appliedAt: NOW, storePath: STORE_PATH, fsDeps: deps });

    expect(
      revertTunedValue(KEY, { appliedAt: LATER, storePath: STORE_PATH, fsDeps: deps })
    ).toBeUndefined();
    expect(readTunedValue(KEY, STORE_PATH, deps)).toBeUndefined();
  });

  test("reverting an untuned threshold is a no-op", () => {
    const { deps } = makeFs();
    expect(
      revertTunedValue(KEY, { appliedAt: NOW, storePath: STORE_PATH, fsDeps: deps })
    ).toBeUndefined();
  });
});

/**
 * The precedence chain is where a tuned value actually reaches a guard. Its
 * ordering is the one deliberate decision in this task's config contract: an
 * explicit env var beats an automatic tune, because a human typed that number.
 */
describe("readTunedThreshold — precedence", () => {
  const DEFAULT = 200;

  test("an explicit env var wins over a tuned value", () => {
    expect(
      readTunedThreshold(KEY, DEFAULT, {
        env: { [KEY]: "500" },
        readTunedValueFn: () => 330,
      })
    ).toBe(500);
  });

  test("a tuned value wins over the shipped default when no env var is set", () => {
    expect(readTunedThreshold(KEY, DEFAULT, { env: {}, readTunedValueFn: () => 330 })).toBe(330);
  });

  test("the shipped default applies when neither is present", () => {
    expect(readTunedThreshold(KEY, DEFAULT, { env: {}, readTunedValueFn: () => undefined })).toBe(
      DEFAULT
    );
  });

  test("an empty env var does not count as set", () => {
    expect(
      readTunedThreshold(KEY, DEFAULT, { env: { [KEY]: "   " }, readTunedValueFn: () => 330 })
    ).toBe(330);
  });

  test("a tuned value past the ceiling degrades to the default rather than taking effect", () => {
    // Trusting the writer would make PREFERENCE_OVERRIDE_MAX_MULTIPLE advisory;
    // a hand-edited store must not be able to reach past what a human may type.
    const overCeiling = DEFAULT * PREFERENCE_OVERRIDE_MAX_MULTIPLE + 1;
    expect(readTunedThreshold(KEY, DEFAULT, { env: {}, readTunedValueFn: () => overCeiling })).toBe(
      DEFAULT
    );
  });

  test("a tuned value exactly at the ceiling is honored", () => {
    const atCeiling = DEFAULT * PREFERENCE_OVERRIDE_MAX_MULTIPLE;
    expect(readTunedThreshold(KEY, DEFAULT, { env: {}, readTunedValueFn: () => atCeiling })).toBe(
      atCeiling
    );
  });

  test("a fractional or non-positive tuned value degrades to the default", () => {
    expect(readTunedThreshold(KEY, DEFAULT, { env: {}, readTunedValueFn: () => 330.5 })).toBe(
      DEFAULT
    );
    expect(readTunedThreshold(KEY, DEFAULT, { env: {}, readTunedValueFn: () => 0 })).toBe(DEFAULT);
    expect(readTunedThreshold(KEY, DEFAULT, { env: {}, readTunedValueFn: () => -5 })).toBe(DEFAULT);
  });

  test("no store reader at all is the same as no tuned value", () => {
    expect(readTunedThreshold(KEY, DEFAULT, { env: {} })).toBe(DEFAULT);
  });
});
