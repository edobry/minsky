/**
 * mt#4748 SC2/SC4/SC6 — every calibration/evaluation stream a hook can write
 * resolves OUTSIDE the repo working tree, so nothing can ever be staged by
 * `git add -A` / `session_commit --all`.
 *
 * Historical note (mt#2492): this file used to assert the INVERSE — that
 * every declared `.minsky/*-calibration.jsonl` / `*-evaluations.jsonl` path
 * was covered by a `.gitignore` denylist (`**\/.minsky/*-calibration.jsonl`,
 * `**\/.minsky/*-evaluations.jsonl`, mt#2667). mt#4748 retired that denylist
 * (`.gitignore`, SC6) because the underlying premise changed: these streams
 * no longer write into ANY working tree at all — `.minsky/hooks/dispatcher.ts`'s
 * `calibrationLogPath` / `evaluationLogPath` resolve under the state dir
 * (`~/.local/state/minsky/projects/<key>/`), project-keyed by the repo root,
 * not the repo itself. A pattern-coverage check on a path that is never
 * written into the tree is testing nothing; the direct structural property —
 * "this path can never be under the repo root" — is what SC2 actually asks
 * for, and unlike a denylist it cannot fall behind a newly-added detector
 * (SC3): a stream declared with `family: "calibration" | "evaluation"`
 * inherits the state-dir resolution automatically, with no per-stream
 * `.gitignore` line to remember.
 *
 * AT4 (the spec's own acceptance test) is covered directly: a detector name
 * that matches no existing pattern — because there IS no pattern anymore —
 * still resolves outside the repo, since the resolution is structural
 * (state-dir + project key), not name-based.
 */
import { describe, expect, it } from "bun:test";
import { calibrationLogPath, evaluationLogPath } from "./dispatcher";
import { GUARD_EVENT_STREAM_SOURCES } from "../../packages/domain/src/guard-events/stream-sources";

/** A synthetic "fresh init" project root — never a real repo on this machine. */
const FRESH_INIT_REPO_ROOT = "/tmp/mt4748-fresh-init-project-that-does-not-exist";

const calibrationStreams = GUARD_EVENT_STREAM_SOURCES.filter((s) => s.family === "calibration");
const evaluationStreams = GUARD_EVENT_STREAM_SOURCES.filter((s) => s.family === "evaluation");

describe("mt#4748 SC2 — calibration/evaluation streams never resolve inside the repo", () => {
  it("finds a non-trivial set of calibration and evaluation streams (guards the guard)", () => {
    // An enumeration that silently returned [] would make every assertion
    // below vacuously pass — the exact shape this file exists to prevent one
    // level down (mirrors the floor the old version of this test kept).
    expect(calibrationStreams.length).toBeGreaterThan(20);
    expect(evaluationStreams.length).toBeGreaterThan(3);
  });

  it("every declared calibration stream's location is state-dir, not repo", () => {
    for (const s of calibrationStreams) {
      expect(s.location).toBe("state-dir");
    }
  });

  it("every declared evaluation stream's location is state-dir, not repo", () => {
    for (const s of evaluationStreams) {
      expect(s.location).toBe("state-dir");
    }
  });

  it.each(calibrationStreams.map((s) => s.stream))(
    "calibrationLogPath(%s) never resolves under a fresh-init repo root",
    (stream) => {
      const p = calibrationLogPath(stream, { projectDir: FRESH_INIT_REPO_ROOT });
      expect(p.startsWith(FRESH_INIT_REPO_ROOT)).toBe(false);
    }
  );

  it.each(evaluationStreams.map((s) => s.stream.replace(/-evaluations$/, "")))(
    "evaluationLogPath(%s) never resolves under a fresh-init repo root",
    (bareName) => {
      const p = evaluationLogPath(bareName, { projectDir: FRESH_INIT_REPO_ROOT });
      expect(p.startsWith(FRESH_INIT_REPO_ROOT)).toBe(false);
    }
  );

  // AT4 — a detector with a log name matching no existing pattern (there is
  // no pattern to match anymore) still resolves outside the repo, because
  // the resolution is structural, not name-based.
  it("AT4: a brand-new, never-before-seen detector name also resolves outside the repo", () => {
    const name = "brand-new-detector-never-seen-before-mt4748";
    expect(
      calibrationLogPath(name, { projectDir: FRESH_INIT_REPO_ROOT }).startsWith(
        FRESH_INIT_REPO_ROOT
      )
    ).toBe(false);
    expect(
      evaluationLogPath(name, { projectDir: FRESH_INIT_REPO_ROOT }).startsWith(FRESH_INIT_REPO_ROOT)
    ).toBe(false);
  });
});
