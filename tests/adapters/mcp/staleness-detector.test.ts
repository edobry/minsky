import { describe, it, expect } from "bun:test";
import { StalenessDetector } from "../../../src/mcp/staleness-detector";

const GIT_REV_PARSE_HEAD = "git rev-parse HEAD";
const GIT_DIFF_NAME_ONLY = "git diff --name-only";

describe("StalenessDetector", () => {
  it("returns null warning when HEAD hasn't moved", () => {
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) return Buffer.from("abc123\n");
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    expect(detector.getStaleWarning()).toBeNull();
  });

  it("returns a warning when HEAD moved and src/ changed", () => {
    let callCount = 0;
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) {
        callCount++;
        return Buffer.from(callCount === 1 ? "oldhead1234\n" : "newhead5678\n");
      }
      if (cmd.includes(GIT_DIFF_NAME_ONLY)) {
        return Buffer.from("src/foo.ts\nsrc/bar.ts\n");
      }
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    // Reset lastCheckTime so the check actually runs (bypasses 60s debounce)
    (detector as any).lastCheckTime = 0;
    const warning = detector.getStaleWarning();
    expect(warning).not.toBeNull();
    expect(warning).toContain("MCP server was loaded from commit");
    expect(warning).toContain("oldhead1");
    expect(warning).toContain("newhead5");
  });

  it("returns null when HEAD moved but src/ didn't change", () => {
    let callCount = 0;
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) {
        callCount++;
        return Buffer.from(callCount === 1 ? "oldhead\n" : "newhead\n");
      }
      if (cmd.includes(GIT_DIFF_NAME_ONLY)) {
        return Buffer.from(""); // empty diff — no src/ changes
      }
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    (detector as any).lastCheckTime = 0;
    expect(detector.getStaleWarning()).toBeNull();
  });

  it("caches stale state once detected", () => {
    let callCount = 0;
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) {
        callCount++;
        return Buffer.from(callCount === 1 ? "old\n" : "new\n");
      }
      if (cmd.includes(GIT_DIFF_NAME_ONLY)) {
        return Buffer.from("src/x.ts\n");
      }
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    (detector as any).lastCheckTime = 0;
    const first = detector.getStaleWarning();
    // Second call returns cached result (isStale=true path, no re-check needed)
    const second = detector.getStaleWarning();
    expect(first).not.toBeNull();
    expect(second).toBe(first);
  });

  it("isCurrentlyStale() reflects cached stale state", () => {
    let callCount = 0;
    const fakeExec = (cmd: string) => {
      if (cmd === GIT_REV_PARSE_HEAD) {
        callCount++;
        return Buffer.from(callCount === 1 ? "startHead\n" : "endHead\n");
      }
      if (cmd.includes(GIT_DIFF_NAME_ONLY)) {
        return Buffer.from("src/changed.ts\n");
      }
      return Buffer.from("");
    };
    const detector = new StalenessDetector("/fake/path", fakeExec as any);
    expect(detector.isCurrentlyStale()).toBe(false);
    (detector as any).lastCheckTime = 0;
    detector.getStaleWarning();
    expect(detector.isCurrentlyStale()).toBe(true);
  });
});
