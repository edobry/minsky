/**
 * `readWebBundleIdentity` — the SERVED BUNDLE's identity on `/api/health` (mt#5034).
 *
 * The property these tests exist for is the ABSENCE of a memo. `/api/health`'s
 * sibling `commit` field memoizes deliberately (the daemon runs the code it
 * loaded at start), and copying that pattern here would reproduce the exact
 * defect this function was written to remove: the tray's web watcher rebuilds
 * `dist/` without restarting the daemon, so a value cached at process start can
 * never change and the endpoint would keep naming a stale bundle forever.
 *
 * A test that only checked "it returns the right value" would pass against a
 * memoized implementation. The first test below is the one that would not.
 */
import { describe, expect, test } from "bun:test";

import { readWebBundleIdentity } from "./health";

/** A reader whose contents can change between calls, like the real file's can. */
function mutableReader(initial: string): { read: (p: string) => string; set: (s: string) => void } {
  let contents = initial;
  return {
    read: () => contents,
    set: (s: string) => {
      contents = s;
    },
  };
}

const DIST = "/fake/dist";
const resolveDistDir = () => DIST;

describe("readWebBundleIdentity (mt#5034)", () => {
  test("does NOT cache — a rebuilt bundle changes the answer without a restart", () => {
    const reader = mutableReader(
      JSON.stringify({ commit: "aaaa111", builtAt: "2026-09-09T10:00:00.000Z" })
    );

    const before = readWebBundleIdentity("/srv", { readFile: reader.read, resolveDistDir });
    expect(before.commit).toBe("aaaa111");

    // The watcher rebuilds dist/ in place; the process does not restart.
    reader.set(JSON.stringify({ commit: "bbbb222", builtAt: "2026-09-09T11:00:00.000Z" }));

    const after = readWebBundleIdentity("/srv", { readFile: reader.read, resolveDistDir });
    expect(after.commit).toBe("bbbb222");
    expect(after.builtAt).toBe("2026-09-09T11:00:00.000Z");
  });

  test("reads through the injected dist-dir resolver, at build-info.json", () => {
    let seenPath = "";
    readWebBundleIdentity("/srv", {
      readFile: (p) => {
        seenPath = p;
        return JSON.stringify({ commit: "abc1234", builtAt: null });
      },
      resolveDistDir,
    });
    expect(seenPath).toBe("/fake/dist/build-info.json");
  });

  test("a well-formed sidecar is reported verbatim", () => {
    const got = readWebBundleIdentity("/srv", {
      readFile: () => JSON.stringify({ commit: "60b644e14", builtAt: "2026-09-09T19:37:37.122Z" }),
      resolveDistDir,
    });
    expect(got).toEqual({ commit: "60b644e14", builtAt: "2026-09-09T19:37:37.122Z" });
  });

  // The degrade cases below all matter for the same reason: the tray polls this
  // route to decide whether the daemon is alive, so a missing or broken sidecar
  // must never throw out of the health handler.
  test("a missing file degrades to unknown rather than throwing", () => {
    const got = readWebBundleIdentity("/srv", {
      readFile: () => {
        throw new Error("ENOENT: no such file or directory");
      },
      resolveDistDir,
    });
    expect(got).toEqual({ commit: "unknown", builtAt: null });
  });

  test("malformed JSON degrades to unknown", () => {
    const got = readWebBundleIdentity("/srv", {
      readFile: () => "{ not json",
      resolveDistDir,
    });
    expect(got).toEqual({ commit: "unknown", builtAt: null });
  });

  test("valid JSON of the wrong shape degrades to unknown", () => {
    for (const raw of ["null", '"a string"', "42", "[]"]) {
      const got = readWebBundleIdentity("/srv", { readFile: () => raw, resolveDistDir });
      expect(got).toEqual({ commit: "unknown", builtAt: null });
    }
  });

  test("a partial sidecar degrades per FIELD, not wholesale", () => {
    // A build that wrote a commit but no timestamp should still report the
    // commit — that is the field an agent verifying a deploy actually needs.
    const got = readWebBundleIdentity("/srv", {
      readFile: () => JSON.stringify({ commit: "abc1234" }),
      resolveDistDir,
    });
    expect(got).toEqual({ commit: "abc1234", builtAt: null });
  });

  test("an empty-string commit is treated as absent, not reported as empty", () => {
    const got = readWebBundleIdentity("/srv", {
      readFile: () => JSON.stringify({ commit: "", builtAt: "" }),
      resolveDistDir,
    });
    expect(got).toEqual({ commit: "unknown", builtAt: null });
  });
});
