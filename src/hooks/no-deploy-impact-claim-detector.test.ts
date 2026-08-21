/**
 * mt#4397 — a `[no-deploy-impact]` claim is verified against the predicate.
 *
 * The fixtures are the four real instances, not invented cases: R1/R2 wrote the
 * tag from a stale pattern list, R3 from a staged set that a regeneration step
 * mutated after the check, R4 without running the predicate at all. Each has a
 * test below whose staged set reproduces that instance's shape.
 */

import { describe, test, expect } from "bun:test";

import {
  messageClaimsNoDeployImpact,
  evaluateNoDeployImpactClaim,
  formatFalseNoDeployImpactClaim,
  NO_DEPLOY_IMPACT_CLAIM_OVERRIDE_ENV,
} from "./no-deploy-impact-claim-detector";

/** Deploy surface per `packages/domain/src/deployment/deploy-surface.ts`. */
const DEPLOY_SURFACE_FILE = "packages/domain/src/composition/container.ts";
/** The file R3's pre-commit step regenerated and re-staged. */
const REGENERATED_DEPLOY_SURFACE_FILE = "src/generated/interceptor-catalog.json";
/** Outside every deploy workflow's `paths:` filter (mem#1072). */
const NON_DEPLOY_FILE = ".minsky/hooks/some-guard.ts";
/** The minimal message that ASSERTS the tag, shared so the fixtures cannot drift apart. */
const CLAIMING_MESSAGE = "fix: x\n\n[no-deploy-impact]";

describe("[no-deploy-impact] claim verification (mt#4397)", () => {
  describe("the claim is present", () => {
    test("a bare tag in the body is a claim", () => {
      expect(messageClaimsNoDeployImpact("fix(mt#1): a change\n\n[no-deploy-impact]")).toBe(true);
    });

    test("case-insensitive, and matches mid-line", () => {
      expect(messageClaimsNoDeployImpact("fix: [NO-DEPLOY-IMPACT] comment tweak")).toBe(true);
    });

    test("absent when the message never mentions it", () => {
      expect(messageClaimsNoDeployImpact("fix(mt#1): an ordinary change")).toBe(false);
    });
  });

  describe("discussing the tag is not claiming it", () => {
    // Without this, the check fires hardest on the commits that document it —
    // including this task's own, and every future retrospective about the class.
    test("a backticked tag in prose is NOT a claim", () => {
      const message =
        "docs(mt#4397): explain the check\n\n" +
        "The `[no-deploy-impact]` tag asserts the predicate returns false for every\n" +
        "changed file. Do not write `[no-deploy-impact]` without running it.";
      expect(messageClaimsNoDeployImpact(message)).toBe(false);
    });

    test("a backticked mention does not suppress a real bare claim elsewhere", () => {
      const message =
        "fix(mt#4397): a change\n\n" +
        "Explains the `[no-deploy-impact]` tag, and also claims it:\n\n" +
        "[no-deploy-impact]";
      expect(messageClaimsNoDeployImpact(message)).toBe(true);
    });
  });

  describe("evaluating the claim against the staged set", () => {
    test("R4's shape: tag present, staged files ARE deploy surface -> violation", () => {
      const violation = evaluateNoDeployImpactClaim(CLAIMING_MESSAGE, [
        DEPLOY_SURFACE_FILE,
        NON_DEPLOY_FILE,
      ]);

      expect(violation).not.toBeNull();
      expect(violation?.deploySurfaceFiles).toEqual([DEPLOY_SURFACE_FILE]);
    });

    test("R3's shape: a regeneration step added a deploy-surface file -> violation", () => {
      // The author's own edits were all clean; the pre-commit step staged the
      // catalog afterwards. Reading the staged set at commit-msg time — after
      // those steps run — is what makes this case visible at all.
      const violation = evaluateNoDeployImpactClaim(CLAIMING_MESSAGE, [
        NON_DEPLOY_FILE,
        REGENERATED_DEPLOY_SURFACE_FILE,
      ]);

      expect(violation).not.toBeNull();
      expect(violation?.deploySurfaceFiles).toEqual([REGENERATED_DEPLOY_SURFACE_FILE]);
    });

    test("tag present and the staged set is genuinely clean -> no violation", () => {
      expect(evaluateNoDeployImpactClaim(CLAIMING_MESSAGE, [NON_DEPLOY_FILE])).toBeNull();
    });

    test("deploy-surface files with NO tag -> no violation (the tag creates the obligation)", () => {
      expect(evaluateNoDeployImpactClaim("fix: an ordinary change", [DEPLOY_SURFACE_FILE])).toBe(
        null
      );
    });

    test("an empty staged set cannot falsify the claim", () => {
      expect(evaluateNoDeployImpactClaim(CLAIMING_MESSAGE, [])).toBeNull();
    });

    test("every falsifying file is reported, not just the first", () => {
      const violation = evaluateNoDeployImpactClaim(CLAIMING_MESSAGE, [
        DEPLOY_SURFACE_FILE,
        NON_DEPLOY_FILE,
        REGENERATED_DEPLOY_SURFACE_FILE,
      ]);

      expect(violation?.deploySurfaceFiles).toEqual([
        DEPLOY_SURFACE_FILE,
        REGENERATED_DEPLOY_SURFACE_FILE,
      ]);
    });
  });

  describe("the denial message", () => {
    test("names every offending file and the override", () => {
      const text = formatFalseNoDeployImpactClaim({
        deploySurfaceFiles: [DEPLOY_SURFACE_FILE, REGENERATED_DEPLOY_SURFACE_FILE],
      });

      expect(text).toContain(DEPLOY_SURFACE_FILE);
      expect(text).toContain(REGENERATED_DEPLOY_SURFACE_FILE);
      expect(text).toContain(NO_DEPLOY_IMPACT_CLAIM_OVERRIDE_ENV);
    });

    test("states that a pushed commit message cannot be edited", () => {
      // The reason this fires at commit-msg rather than at merge is that the
      // author can still fix it here. A denial that omits that invites the
      // push-then-retract path R3 and R4 both took.
      const text = formatFalseNoDeployImpactClaim({ deploySurfaceFiles: [DEPLOY_SURFACE_FILE] });
      expect(text).toContain("cannot be edited");
    });
  });

  describe("module invariants", () => {
    test("the override env var name is stable", () => {
      expect(NO_DEPLOY_IMPACT_CLAIM_OVERRIDE_ENV).toBe("MINSKY_SKIP_NO_DEPLOY_IMPACT_CHECK");
    });
  });
});
