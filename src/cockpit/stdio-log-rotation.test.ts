/**
 * Tests for the stdio-redirect log rotation policy (mt#3298).
 *
 * The write-through-a-live-fd tests below simulate the supervisor-held
 * O_APPEND fd (tray `open_log()` / launchd StandardOutPath both open append
 * mode) by holding an "a"-flag fd open across the rotation — the load-bearing
 * property is that truncation resets where that EXISTING fd's next write
 * lands, without any rename or reopen.
 *
 * These tests exercise the REAL filesystem (in a mkdtemp sandbox) because the
 * property under test IS the OS's O_APPEND-after-truncate semantics — an
 * in-memory fs mock would only reflect the mock's own semantics, proving
 * nothing about the behavior the daemon relies on. Same rationale as
 * src/mcp/disconnect-tracker.test.ts. The custom/no-real-fs-in-tests rule is
 * disabled file-wide for this reason.
 */
/* eslint-disable custom/no-real-fs-in-tests */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { rotateStdioLogIfOversized } from "./stdio-log-rotation";

const CAP = 1024; // small cap so tests write kilobytes, not megabytes

let dir: string;
let live: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stdio-log-rotation-"));
  live = path.join(dir, "cockpit-stdout.log");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function limits(rotationsRetained = 2) {
  return { maxBytes: CAP, rotationsRetained };
}

describe("rotateStdioLogIfOversized", () => {
  test("returns false and leaves an under-cap file untouched", () => {
    fs.writeFileSync(live, "x".repeat(CAP));
    expect(rotateStdioLogIfOversized(live, limits())).toBe(false);
    expect(fs.readFileSync(live, "utf-8")).toBe("x".repeat(CAP));
    expect(fs.existsSync(`${live}.1`)).toBe(false);
  });

  test("returns false without throwing when the file is absent (manual starts)", () => {
    expect(rotateStdioLogIfOversized(live, limits())).toBe(false);
  });

  test("over-cap: truncates the live file to zero and preserves the tail in .1", () => {
    const content = "a".repeat(CAP + 100);
    fs.writeFileSync(live, content);

    expect(rotateStdioLogIfOversized(live, limits())).toBe(true);

    expect(fs.statSync(live).size).toBe(0);
    expect(fs.readFileSync(`${live}.1`, "utf-8")).toBe(content.slice(-CAP));
  });

  test("retention shift: .1 moves to .2 and the oldest rotation is dropped", () => {
    fs.writeFileSync(`${live}.1`, "gen1");
    fs.writeFileSync(`${live}.2`, "gen0");
    const content = "b".repeat(CAP + 1);
    fs.writeFileSync(live, content);

    expect(rotateStdioLogIfOversized(live, limits())).toBe(true);

    expect(fs.readFileSync(`${live}.1`, "utf-8")).toBe(content.slice(-CAP));
    expect(fs.readFileSync(`${live}.2`, "utf-8")).toBe("gen1");
    expect(fs.existsSync(`${live}.3`)).toBe(false);
  });

  test("rotationsRetained: 0 truncates without keeping a copy and removes stale rotations", () => {
    fs.writeFileSync(`${live}.1`, "stale1");
    fs.writeFileSync(`${live}.2`, "stale2");
    fs.writeFileSync(live, "c".repeat(CAP + 1));
    expect(rotateStdioLogIfOversized(live, limits(0))).toBe(true);
    expect(fs.statSync(live).size).toBe(0);
    expect(fs.existsSync(`${live}.1`)).toBe(false);
    expect(fs.existsSync(`${live}.2`)).toBe(false);
  });

  test("rotationsRetained: 1 keeps only .1 and drops a stale .2", () => {
    fs.writeFileSync(`${live}.1`, "gen1");
    fs.writeFileSync(`${live}.2`, "gen0");
    const content = "f".repeat(CAP + 1);
    fs.writeFileSync(live, content);

    expect(rotateStdioLogIfOversized(live, limits(1))).toBe(true);

    expect(fs.readFileSync(`${live}.1`, "utf-8")).toBe(content.slice(-CAP));
    expect(fs.existsSync(`${live}.2`)).toBe(false);
  });

  // The boot-tick case a previous run can leave behind: a live file many
  // multiples of the cap. A full-file copy would just move the unbounded
  // bytes into .1 and retain them forever (PR #2387 R1 BLOCKING #2) — one
  // rotation must bound the whole directory.
  test("gigantic pre-existing file: one rotation bounds it, .1 holds only the last CAP bytes", () => {
    const content = `${"g".repeat(10 * CAP + 37)}TAIL-MARKER`;
    fs.writeFileSync(live, content);

    expect(rotateStdioLogIfOversized(live, limits())).toBe(true);

    expect(fs.statSync(live).size).toBe(0);
    expect(fs.statSync(`${live}.1`).size).toBe(CAP);
    expect(fs.readFileSync(`${live}.1`, "utf-8")).toBe(content.slice(-CAP));

    const total = [live, `${live}.1`, `${live}.2`]
      .filter((p) => fs.existsSync(p))
      .reduce((sum, p) => sum + fs.statSync(p).size, 0);
    expect(total).toBeLessThanOrEqual(CAP * 3);
  });

  // AT1: with the policy in force, writing past the cap leaves total
  // stdio-log size bounded at the documented ceiling rather than growing
  // monotonically. Ceiling: cap x (1 live + retained) + per-tick overshoot.
  test("AT1: repeated over-cap write/rotate cycles keep total size bounded", () => {
    const retained = 2;
    const overshoot = 200;
    const ceiling = (CAP + overshoot) * (1 + retained);

    for (let cycle = 0; cycle < 6; cycle++) {
      fs.appendFileSync(live, `cycle${cycle}`.padEnd(CAP + overshoot, "z"));
      rotateStdioLogIfOversized(live, limits(retained));

      const total = [live, `${live}.1`, `${live}.2`, `${live}.3`]
        .filter((p) => fs.existsSync(p))
        .reduce((sum, p) => sum + fs.statSync(p).size, 0);
      expect(total).toBeLessThanOrEqual(ceiling);
    }
  });

  // The supervisor-held-fd property the whole design rests on: truncating
  // the live file resets where an already-open O_APPEND fd's next write
  // lands. Without the truncate (or without O_APPEND) the second write would
  // land at the old offset and the size assertion fails.
  test("a live O_APPEND fd keeps writing at offset 0 after rotation, no rename/reopen", () => {
    const fd = fs.openSync(live, "a");
    try {
      const before = "d".repeat(CAP + 50);
      fs.writeSync(fd, before);

      expect(rotateStdioLogIfOversized(live, limits())).toBe(true);
      expect(fs.readFileSync(`${live}.1`, "utf-8")).toBe(before.slice(-CAP));

      fs.writeSync(fd, "after-rotation");
      expect(fs.readFileSync(live, "utf-8")).toBe("after-rotation");
      expect(fs.statSync(live).size).toBe("after-rotation".length);
    } finally {
      fs.closeSync(fd);
    }
  });

  // AT2: a daemon restart preserves recent output and does not resurrect a
  // previously-rotated file. Restart = the supervisor reopening the same
  // path append-mode; rotated files are untouched by it.
  test("AT2: reopening the live file append-mode appends and leaves rotations untouched", () => {
    fs.writeFileSync(live, "e".repeat(CAP + 1));
    rotateStdioLogIfOversized(live, limits());
    const rotatedBefore = fs.readFileSync(`${live}.1`, "utf-8");

    const fd = fs.openSync(live, "a");
    try {
      fs.writeSync(fd, "post-restart");
    } finally {
      fs.closeSync(fd);
    }

    expect(fs.readFileSync(live, "utf-8")).toBe("post-restart");
    expect(fs.readFileSync(`${live}.1`, "utf-8")).toBe(rotatedBefore);
  });
});
