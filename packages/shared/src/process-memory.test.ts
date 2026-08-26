/**
 * Tests for the swap-inclusive memory primitive (mt#4104).
 *
 * Both platform paths are exercised from whichever platform this runs on, via
 * the injection seam — otherwise the Linux path would be untested on every
 * developer machine and first exercised in production.
 */

import { describe, test, expect } from "bun:test";
import { readProcessMemory } from "./process-memory";

/** Real `footprint -f bytes -p <pid>` output, trimmed to the shape we parse. */
const FOOTPRINT_OUTPUT = `
Physical footprint:         335.4M
Physical footprint (peak):  665.2M
----

    phys_footprint: 15517760 B
    phys_footprint_peak: 15616064 B
`;

/** Real `/proc/<pid>/status` excerpt. proc(5) reports these in kB. */
const PROC_STATUS = `
Name:	bun
State:	R (running)
VmRSS:	   900000 kB
RssAnon:	   850000 kB
VmSwap:	 46500000 kB
`;

describe("readProcessMemory — macOS phys_footprint", () => {
  test("parses the byte-valued phys_footprint line", () => {
    const result = readProcessMemory(123, {
      platform: "darwin",
      runFootprint: () => FOOTPRINT_OUTPUT,
    });
    expect(result).toEqual({ ok: true, bytes: 15_517_760, source: "phys_footprint" });
  });

  test("reads phys_footprint, NOT phys_footprint_peak — even when peak comes FIRST", () => {
    // The two lines differ by one underscore-suffixed word and sit adjacent, so
    // a pattern missing its anchors matches the peak and over-reports on every
    // call. Ordering must not be what saves us: against the real `footprint(1)`
    // layout (phys_footprint first) a loosened pattern still matches the right
    // line by accident, so this fixture puts the PEAK first. Verified by
    // mutation — with the anchors removed, this case fails and the natural-order
    // one does not.
    const peakFirst = `
    phys_footprint_peak: 15616064 B
    phys_footprint: 15517760 B
`;
    const result = readProcessMemory(123, {
      platform: "darwin",
      runFootprint: () => peakFirst,
    });
    expect(result).toEqual({ ok: true, bytes: 15_517_760, source: "phys_footprint" });
  });

  test("reads phys_footprint in the natural footprint(1) ordering too", () => {
    const result = readProcessMemory(123, {
      platform: "darwin",
      runFootprint: () => FOOTPRINT_OUTPUT,
    });
    expect(result.ok && result.bytes).toBe(15_517_760);
  });

  test("reports failure — not a number — when footprint(1) is unavailable", () => {
    const result = readProcessMemory(123, { platform: "darwin", runFootprint: () => null });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("bytes");
  });

  test("reports failure when the output carries no phys_footprint line", () => {
    const result = readProcessMemory(123, {
      platform: "darwin",
      runFootprint: () => "some other tool's output entirely",
    });
    expect(result.ok).toBe(false);
  });
});

describe("readProcessMemory — Linux VmRSS + VmSwap", () => {
  test("sums VmRSS and VmSwap, converting kB to bytes", () => {
    const result = readProcessMemory(123, {
      platform: "linux",
      readProcStatus: () => PROC_STATUS,
    });
    // This is the 2026-08-13 specimen's shape: a small resident set over a huge
    // swapped-out heap. RSS alone reads 900 MB; the sum reads ~47.4 GB.
    expect(result).toEqual({
      ok: true,
      bytes: (900_000 + 46_500_000) * 1024,
      source: "vmrss+vmswap",
    });
  });

  test("treats an absent VmSwap as zero swap rather than a failed reading", () => {
    const result = readProcessMemory(123, {
      platform: "linux",
      readProcStatus: () => "VmRSS:\t  1024 kB\n",
    });
    expect(result).toEqual({ ok: true, bytes: 1024 * 1024, source: "vmrss+vmswap" });
  });

  test("reports failure when /proc/<pid>/status cannot be read", () => {
    const result = readProcessMemory(123, { platform: "linux", readProcStatus: () => null });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("bytes");
  });

  test("reports failure when VmRSS is absent", () => {
    const result = readProcessMemory(123, {
      platform: "linux",
      readProcStatus: () => "Name:\tbun\nState:\tR\n",
    });
    expect(result.ok).toBe(false);
  });
});

describe("readProcessMemory — unsupported platform", () => {
  test("reports failure rather than guessing a quantity", () => {
    const result = readProcessMemory(123, { platform: "sunos" });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("bytes");
  });
});

/**
 * The property mt#4105 actually depends on: the reader measures the pid it was
 * HANDED, not `self` (mt#4270).
 *
 * ## Why this is asserted at the seam and not against two live processes
 *
 * The obvious test is "read a child, read ourselves, require the numbers to
 * differ." That is a PROXY, and it is a proxy for a property the implementation
 * does not guarantee: nothing in `readProcessMemory` promises two distinct pids
 * report distinct byte counts. When they legitimately coincide, a CORRECT reader
 * fails the test — which it did in CI five times in eight days (2026-08-18 through
 * 2026-08-25), each time blocking an otherwise-green PR. Both readings were
 * byte-identical every time; see mt#4270 for the values.
 *
 * The seam answers the question directly: `readProcStatus` / `runFootprint` each
 * take the pid, so recording what they RECEIVE tests pid-honoring itself rather
 * than a numeric side-effect of it. Deterministic on every platform, and
 * independent of runner state.
 *
 * **ADR-036 §4(ii)** is the governing rule — assert on the call where the call is
 * the sole observable trace of the behavior. It is NOT "prefer seams to real
 * processes": ADR-036 §1 ranks a real dependency in a sandbox ABOVE an injected
 * double, and the live-process tests below are retained for exactly what a real
 * child CAN attest (`ok`, `bytes > 0`). Each assertion sits at the tier that can
 * observe it.
 *
 * Both platform branches run from whichever platform this executes on, because
 * `platform` is injected — same reason the parsing tests above do.
 */
describe("readProcessMemory — honors its pid argument (mt#4270)", () => {
  test("the Linux seam is handed the pid the caller passed", () => {
    const seen: number[] = [];
    const result = readProcessMemory(4242, {
      platform: "linux",
      readProcStatus: (pid) => {
        seen.push(pid);
        return PROC_STATUS;
      },
    });

    expect(seen).toEqual([4242]);
    // ...and the seam's reading is what got returned, so a reader that took the
    // pid and then ignored the result would still fail here.
    expect(result).toEqual({
      ok: true,
      bytes: (900_000 + 46_500_000) * 1024,
      source: "vmrss+vmswap",
    });
  });

  test("the macOS seam is handed the pid the caller passed", () => {
    const seen: number[] = [];
    const result = readProcessMemory(4242, {
      platform: "darwin",
      runFootprint: (pid) => {
        seen.push(pid);
        return FOOTPRINT_OUTPUT;
      },
    });

    expect(seen).toEqual([4242]);
    expect(result).toEqual({ ok: true, bytes: 15_517_760, source: "phys_footprint" });
  });
});

describe("readProcessMemory — against real processes", () => {
  test("measures the CURRENT process", () => {
    const result = readProcessMemory(process.pid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toBeGreaterThan(0);
  });

  test("measures ANOTHER process — a real child, asserting what a real child attests", () => {
    // mt#4105's supervisor has to measure the daemon it supervises, so a reader
    // that only works on `self` passes every in-process test and still cannot do
    // the job. Spawn a real child and read ITS memory, not ours.
    //
    // This asserts ONLY what the implementation guarantees for a live child:
    // that the read succeeds and returns a positive quantity. The "did it honor
    // the pid" half moved to the seam block above (mt#4270) — asserting it here
    // required comparing two live readings, which is a property the code does
    // not guarantee and which collided in CI five times.
    const child = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    try {
      const result = readProcessMemory(child.pid);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.bytes).toBeGreaterThan(0);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("reports failure for a pid that does not exist", () => {
    const result = readProcessMemory(999_999);
    expect(result.ok).toBe(false);
  });
});
