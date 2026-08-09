/**
 * Attribution tests for `scripts/replay-build-claim-injection.ts` (mt#3755).
 *
 * The replay's job is not just "did it fire" — it is "which condition blocked
 * it", because that answer is what the mt#3755 disposition rests on. PR #2725
 * R1 found the first version deriving that answer from conditions OR/max-
 * accumulated ACROSS evaluations, which misattributes whenever the conditions
 * hold at different moments. These pin the corrected per-evaluation logic.
 *
 * Colocated in `scripts/` deliberately, NOT under `tests/`: the root tsconfig
 * excludes `scripts` on purpose (it has its own `tsconfig.scripts.json` with
 * `types: ["bun","node"]`), so a test under `tests/` importing this script
 * would drag it — and the `.minsky/hooks` tree it imports — into the root
 * program under a different types config, which is exactly the double-check
 * the root tsconfig's own `exclude` comment warns about. Measured: doing so
 * produced 15 spurious `string | Buffer` errors across the hooks tree.
 */
import { describe, test, expect } from "bun:test";
import { STAGE, stageFor, attributeSession, type StageInput } from "./replay-build-claim-injection";

/** A detector result with every condition unmet; override per case. */
function result(over: Partial<StageInput> = {}): StageInput {
  return {
    matched: false,
    deploySurfaceFiles: [],
    hadMerge: false,
    hadRebuildEvidence: false,
    ...over,
  };
}

describe("stageFor — classifies ONE evaluation in the detector's short-circuit order", () => {
  test("no in-session merge is the earliest block", () => {
    expect(stageFor(result())).toBe(STAGE.NO_MERGE);
  });

  test("merged but no deploy-surface file edited", () => {
    expect(stageFor(result({ hadMerge: true }))).toBe(STAGE.NO_DEPLOY_SURFACE);
  });

  test("merge + surface edit but no usability claim in the turn", () => {
    expect(stageFor(result({ hadMerge: true, deploySurfaceFiles: ["Dockerfile"] }))).toBe(
      STAGE.NO_USABILITY_CLAIM
    );
  });

  test("all three met but rebuild evidence suppressed the fire", () => {
    expect(
      stageFor(
        result({
          hadMerge: true,
          deploySurfaceFiles: ["Dockerfile"],
          matchedPhrase: "you can use it now",
          hadRebuildEvidence: true,
        })
      )
    ).toBe(STAGE.SUPPRESSED_BY_REBUILD_EVIDENCE);
  });

  test("a matched result is FIRED regardless of the other fields", () => {
    expect(stageFor(result({ matched: true, hadMerge: true }))).toBe(STAGE.FIRED);
  });
});

describe("attributeSession — reduces per-evaluation stages to one verdict", () => {
  test("attributes to the FURTHEST stage any single evaluation reached", () => {
    const out = attributeSession([STAGE.NO_MERGE, STAGE.NO_DEPLOY_SURFACE, STAGE.NO_MERGE]);
    expect(out.furthestStage).toBe(STAGE.NO_DEPLOY_SURFACE);
    expect(out.blockedBy).toBe("deploy-surface");
    expect(out.wouldFire).toBe(false);
  });

  test("REGRESSION (PR #2725 R1): conditions met at different times are NOT blamed on rebuild evidence", () => {
    // Evaluation 1 saw a usability claim before any merge (stage 0); a later
    // evaluation saw the merge and a deploy-surface edit but no claim in that
    // turn (stage 2). No single moment satisfied all three. The pre-fix code
    // OR-accumulated the raw conditions — hadMerge true, surfaceFiles non-empty,
    // a claim recorded, hadRebuildEvidence false — and fell through to its final
    // `else`, reporting "rebuild-evidence" for a session with NO rebuild
    // evidence at all.
    const out = attributeSession([STAGE.NO_MERGE, STAGE.NO_USABILITY_CLAIM]);
    expect(out.blockedBy).toBe("usability-claim");
    expect(out.blockedBy).not.toBe("rebuild-evidence");
  });

  test("a single firing evaluation makes the session fire, with no blocking condition", () => {
    const out = attributeSession([STAGE.NO_MERGE, STAGE.FIRED, STAGE.NO_DEPLOY_SURFACE]);
    expect(out.wouldFire).toBe(true);
    expect(out.blockedBy).toBeNull();
  });

  test("a session with no evaluated turns is blocked at the earliest stage", () => {
    const out = attributeSession([]);
    expect(out.wouldFire).toBe(false);
    expect(out.blockedBy).toBe("merge");
  });
});
