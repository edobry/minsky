import { describe, test, expect } from "bun:test";
import {
  parseHwmState,
  serializeHwmState,
  readHwmState,
  writeHwmState,
  type GuardEventsHwmState,
  type HwmStoreFsDeps,
} from "./hwm-store";

/** In-memory fake fs — per custom/no-real-fs-in-tests, no real fs/tmpdir. */
function createFakeFs(initial: Record<string, string> = {}): HwmStoreFsDeps & {
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    existsSync: (p) => files.has(p),
    readFileSync: (p) => {
      const content = files.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p, content) => {
      files.set(p, content);
    },
    mkdirSync: () => {
      // no-op fake — directories aren't modeled
    },
  };
}

describe("parseHwmState", () => {
  test("absent content (null) resolves to empty state", () => {
    expect(parseHwmState(null)).toEqual({});
  });

  test("malformed JSON resolves to empty state rather than throwing", () => {
    expect(parseHwmState("{not json")).toEqual({});
  });

  test("a JSON array (wrong shape) resolves to empty state", () => {
    expect(parseHwmState("[1,2,3]")).toEqual({});
  });

  test("valid state round-trips through serialize/parse", () => {
    const state: GuardEventsHwmState = {
      "fire-log": { byteOffset: 12345 },
      "mcp-disconnect-log": { elementCount: 7 },
    };
    expect(parseHwmState(serializeHwmState(state))).toEqual(state);
  });
});

const HWM_PATH = "/state/guard-events-sweep-hwm.json";

describe("readHwmState / writeHwmState", () => {
  test("readHwmState returns empty state when the file does not exist", () => {
    const fs = createFakeFs();
    expect(readHwmState(HWM_PATH, fs)).toEqual({});
  });

  test("writeHwmState then readHwmState round-trips", () => {
    const fs = createFakeFs();
    const state: GuardEventsHwmState = { "wall-of-text": { byteOffset: 99 } };
    writeHwmState(HWM_PATH, state, fs);
    expect(readHwmState(HWM_PATH, fs)).toEqual(state);
  });

  test("writeHwmState overwrites the whole file (not a merge) — matches the mcp-disconnect-sweep-hwm.json precedent", () => {
    const fs = createFakeFs({
      [HWM_PATH]: serializeHwmState({ "old-stream": { byteOffset: 1 } }),
    });
    writeHwmState(HWM_PATH, { "new-stream": { byteOffset: 2 } }, fs);
    expect(readHwmState(HWM_PATH, fs)).toEqual({
      "new-stream": { byteOffset: 2 },
    });
  });

  test("readHwmState degrades to empty state on a corrupted file rather than throwing", () => {
    const fs = createFakeFs({ [HWM_PATH]: "not json at all" });
    expect(readHwmState(HWM_PATH, fs)).toEqual({});
  });
});
