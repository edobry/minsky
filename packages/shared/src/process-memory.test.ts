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

  test("reads phys_footprint, NOT phys_footprint_peak", () => {
    // The two lines differ by one underscore-suffixed word and sit adjacent; a
    // loose pattern matches the peak and silently over-reports on every call.
    const result = readProcessMemory(123, {
      platform: "darwin",
      runFootprint: () => FOOTPRINT_OUTPUT,
    });
    expect(result.ok && result.bytes).not.toBe(15_616_064);
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

describe("readProcessMemory — against real processes", () => {
  test("measures the CURRENT process", () => {
    const result = readProcessMemory(process.pid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toBeGreaterThan(0);
  });

  test("measures ANOTHER process — the case an in-process-only reader would fail", () => {
    // mt#4105's supervisor has to measure the daemon it supervises, so a reader
    // that only works on `self` passes every in-process test and still cannot do
    // the job. Spawn a real child and read ITS memory, not ours.
    const child = Bun.spawn(["sleep", "30"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    try {
      const result = readProcessMemory(child.pid);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.bytes).toBeGreaterThan(0);
        // A different process than ours, so a reader that ignored the pid and
        // always measured `self` would return our footprint instead.
        const self = readProcessMemory(process.pid);
        expect(self.ok && result.bytes).not.toBe(self.ok ? self.bytes : -1);
      }
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("reports failure for a pid that does not exist", () => {
    const result = readProcessMemory(999_999);
    expect(result.ok).toBe(false);
  });
});
