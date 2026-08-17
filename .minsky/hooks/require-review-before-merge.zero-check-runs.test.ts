import { describe, expect, it } from "bun:test";
import {
  classifyZeroCheckRuns,
  evaluateCheckRunsPresence,
  parseMergeStateResponse,
  type MergeState,
} from "./require-review-before-merge";

// Split out of require-review-before-merge.test.ts (mt#2312): that file was
// at 1601 lines against the 1500 max-lines ceiling once these landed. The
// mt#1309 presence-floor tests stay there; this file owns the zero-path
// cause discrimination the floor now delegates to.

// ---------------------------------------------------------------------------
// Zero-check-runs cause discrimination (mt#2312)
// ---------------------------------------------------------------------------

describe("parseMergeStateResponse (mt#2312)", () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" });

  it("reads a conflicted PR", () => {
    expect(parseMergeStateResponse(ok('{"mergeable":false,"mergeable_state":"dirty"}'))).toEqual({
      known: true,
      mergeable: false,
      mergeableState: "dirty",
    });
  });

  it("reads a mergeable-but-behind PR", () => {
    expect(parseMergeStateResponse(ok('{"mergeable":true,"mergeable_state":"behind"}'))).toEqual({
      known: true,
      mergeable: true,
      mergeableState: "behind",
    });
  });

  it("treats a null mergeable as a KNOWN not-yet-computed value, not a parse failure", () => {
    // GitHub's mergeability job is started BY the GET, so null is the ordinary
    // first response — reporting it as unparseable would be wrong.
    expect(parseMergeStateResponse(ok('{"mergeable":null,"mergeable_state":"unknown"}'))).toEqual({
      known: true,
      mergeable: null,
      mergeableState: "unknown",
    });
  });

  it("reports a non-zero exit as unknown, carrying the stderr", () => {
    const state = parseMergeStateResponse({ exitCode: 1, stdout: "", stderr: "404 Not Found" });
    expect(state.known).toBe(false);
    if (!state.known) expect(state.error).toContain("404 Not Found");
  });

  it("reports a timeout as unknown", () => {
    const state = parseMergeStateResponse({
      exitCode: 1,
      stdout: "",
      stderr: "",
      timedOut: true,
    });
    expect(state.known).toBe(false);
    if (!state.known) expect(state.error).toContain("timed out");
  });

  it("reports a non-JSON body as unknown rather than throwing", () => {
    const state = parseMergeStateResponse(ok("<html>Unicorn!</html>"));
    expect(state.known).toBe(false);
  });

  it("reports a body without a boolean/null mergeable as unknown", () => {
    const state = parseMergeStateResponse(ok('{"mergeable_state":"clean"}'));
    expect(state.known).toBe(false);
  });
});

describe("classifyZeroCheckRuns (mt#2312)", () => {
  const known = (mergeable: boolean | null, mergeableState: string | null): MergeState => ({
    known: true,
    mergeable,
    mergeableState,
  });

  it("AT1: a conflicted PR is the merge-conflict cause", () => {
    expect(classifyZeroCheckRuns(known(false, "dirty"))).toBe("merge-conflict");
  });

  it("AT2: a BEHIND but mergeable PR is a webhook miss, NOT unmergeable", () => {
    // The regression test for this task's corrected premise. The spec, mem#321
    // and mem#537 all grouped `behind` with `dirty`; measured 2026-08-17, a PR
    // 13 commits behind main dispatched its full 20-check set. Only a conflict
    // stops the merge ref forming.
    expect(classifyZeroCheckRuns(known(true, "behind"))).toBe("webhook-miss");
  });

  it("AT3: a clean PR is a webhook miss", () => {
    expect(classifyZeroCheckRuns(known(true, "clean"))).toBe("webhook-miss");
  });

  it("AT4: a BLOCKED but mergeable PR is a webhook miss", () => {
    // The trap in the other direction: with required checks configured, a
    // genuine webhook miss presents as `blocked` precisely BECAUSE the
    // required checks are missing. That is the symptom, not the cause.
    expect(classifyZeroCheckRuns(known(true, "blocked"))).toBe("webhook-miss");
  });

  it("AT5: unresolved mergeability is inconclusive, not guessed at", () => {
    expect(classifyZeroCheckRuns(known(null, "unknown"))).toBe("inconclusive");
  });

  it("an unreadable merge state is inconclusive", () => {
    expect(classifyZeroCheckRuns({ known: false, error: "gh api exited 1" })).toBe("inconclusive");
  });

  it("mergeable_state alone never decides — only `mergeable` does", () => {
    // Same mergeable_state string, opposite `mergeable`: the classification
    // must follow `mergeable`. Without this, a future edit could reintroduce
    // the string matching this task exists to remove and every other test here
    // would still pass.
    expect(classifyZeroCheckRuns(known(false, "behind"))).toBe("merge-conflict");
    expect(classifyZeroCheckRuns(known(true, "behind"))).toBe("webhook-miss");
  });
});

describe("evaluateCheckRunsPresence zero-path messages (mt#2312)", () => {
  const pr = "3031";
  const headSha = "abc1234def5678901234567890123456789abcde";
  const zero = { ok: true as const, count: 0 };
  const stateThunk = (state: MergeState) => (): MergeState => state;

  it("the conflict message prescribes session_update and warns OFF the empty commit", () => {
    const result = evaluateCheckRunsPresence(
      zero,
      pr,
      headSha,
      stateThunk({ known: true, mergeable: false, mergeableState: "dirty" })
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("session_update");
    expect(result.reason).toContain("Do NOT push an empty commit");
    expect(result.reason).toContain("dirty");
    // The whole point: it must NOT prescribe the webhook recovery.
    expect(result.reason).not.toContain("wake the webhook");
  });

  it("the conflict message names the invalidated-approval cost", () => {
    const result = evaluateCheckRunsPresence(
      zero,
      pr,
      headSha,
      stateThunk({ known: true, mergeable: false, mergeableState: "dirty" })
    );
    expect(result.reason).toContain("invalidating any existing reviewer APPROVE");
  });

  it("a behind-but-mergeable PR still gets the webhook-miss recovery", () => {
    const result = evaluateCheckRunsPresence(
      zero,
      pr,
      headSha,
      stateThunk({ known: true, mergeable: true, mergeableState: "behind" })
    );
    expect(result.reason).toContain("wake the webhook");
    expect(result.reason).not.toContain("Do NOT push an empty commit");
  });

  it("the inconclusive message lists BOTH causes and their opposite recoveries", () => {
    const result = evaluateCheckRunsPresence(
      zero,
      pr,
      headSha,
      stateThunk({ known: true, mergeable: null, mergeableState: "unknown" })
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("session_update");
    expect(result.reason).toContain("empty commit");
    expect(result.reason).toContain("TWO causes");
  });

  it("an unreadable merge state surfaces the fetch error in the inconclusive message", () => {
    const result = evaluateCheckRunsPresence(
      zero,
      pr,
      headSha,
      stateThunk({ known: false, error: "gh api exited 1: 502 Bad Gateway" })
    );
    expect(result.reason).toContain("502 Bad Gateway");
  });
});
