/**
 * Build-identity classification (mt#4583).
 *
 * The defect being closed: `deployment_wait-for-latest` returned SUCCESS for a
 * deployment belonging to a NEIGHBOURING merge, because `notBefore` bounds time
 * and time does not identify which change deployed. These tests reproduce that
 * shape and assert the classifier separates the three outcomes that a bare
 * SUCCESS collapsed into one.
 *
 * The whole module is pure, so nothing here patches a collaborator.
 */

import { describe, test, expect } from "bun:test";
import { assessBuildIdentity, buildIdentityIsConfirmed } from "./build-identity";
import type { DeploymentRecord } from "./types";

/** The two identity fields the classifier reads; the rest of the record is irrelevant to it. */
function rec(
  commitHash: string | null,
  imageDigest: string | null = null
): Pick<DeploymentRecord, "commitHash" | "imageDigest"> {
  return { commitHash, imageDigest };
}

const MERGE_SHA = "b65baf9402d64e78d368ae17e2a805fe29b55126";
const NEIGHBOUR_SHA = "ce9af92bf0432cf8059527f1f9d721441503878a";

describe("assessBuildIdentity", () => {
  test("confirmed when the deployment names the expected commit", () => {
    const result = assessBuildIdentity(rec(MERGE_SHA), MERGE_SHA);
    expect(result.identity).toBe("confirmed");
    expect(buildIdentityIsConfirmed(result)).toBe(true);
  });

  test("AT1 — the incident's shape: a NEIGHBOURING merge's deployment is a mismatch, not a pass", () => {
    // 2026-08-25: the wait returned a deployment created 10s after the merge
    // that belonged to the previous merge's workflow run. Under the old
    // contract this was indistinguishable from success.
    const result = assessBuildIdentity(rec(NEIGHBOUR_SHA), MERGE_SHA);

    expect(result.identity).toBe("mismatch");
    expect(buildIdentityIsConfirmed(result)).toBe(false);
    // The reason must say a deploy DID happen — otherwise a reader treats it
    // as "nothing deployed" and waits, which is the wrong recovery.
    expect(result.reason).toContain("not yours");
  });

  test("AT2 — negative control: a build that never deployed does NOT read as confirmed", () => {
    // The probe must be capable of failing. If this ever returns "confirmed",
    // the mechanism has no information content (mem#704).
    const neverDeployed = "0000000deadbeef0000000deadbeef0000000000";
    const result = assessBuildIdentity(rec(NEIGHBOUR_SHA), neverDeployed);
    expect(result.identity).not.toBe("confirmed");
    expect(buildIdentityIsConfirmed(result)).toBe(false);
  });

  test("indeterminate — an image-source deployment carries no commit, so the record cannot answer", () => {
    // This is the reviewer service's real shape: working deploys have a null
    // commit hash because Railway deploys a pushed image.
    const result = assessBuildIdentity(rec(null, "sha256:abc123"), MERGE_SHA);

    expect(result.identity).toBe("indeterminate");
    expect(buildIdentityIsConfirmed(result)).toBe(false);
    // It must NOT be silent about what to do instead — an "I cannot tell" with
    // no next step is how the caller talks itself back into accepting SUCCESS.
    expect(result.reason).toContain("workflow run");
    expect(result.reason).toContain("sha256:abc123");
  });

  test("indeterminate reason names the absent digest rather than printing null", () => {
    const result = assessBuildIdentity(rec(null, null), MERGE_SHA);
    expect(result.identity).toBe("indeterminate");
    expect(result.reason).toContain("no image digest either");
    expect(result.reason).not.toContain("null");
  });

  test("indeterminate when no expected build is named — absence of a question is not a pass", () => {
    const result = assessBuildIdentity(rec(MERGE_SHA));
    expect(result.identity).toBe("indeterminate");
    expect(result.reason).toContain("expectCommitSha");
  });

  test("an empty or whitespace expectation is treated as absent, not as a mismatch", () => {
    expect(assessBuildIdentity(rec(MERGE_SHA), "").identity).toBe("indeterminate");
    expect(assessBuildIdentity(rec(MERGE_SHA), "   ").identity).toBe("indeterminate");
  });

  describe("prefix-tolerant comparison", () => {
    test("an abbreviated deployment sha matches a full expected sha", () => {
      expect(assessBuildIdentity(rec("b65baf940"), MERGE_SHA).identity).toBe("confirmed");
    });

    test("and the reverse — an abbreviated expectation against a full deployment sha", () => {
      expect(assessBuildIdentity(rec(MERGE_SHA), "b65baf940").identity).toBe("confirmed");
    });

    test("comparison is case-insensitive and tolerates surrounding whitespace", () => {
      expect(assessBuildIdentity(rec("  B65BAF940  "), MERGE_SHA).identity).toBe("confirmed");
    });

    test("a prefix shorter than git's 7-char default cannot confirm — it would collide", () => {
      // "b65b" agrees with the expected sha, and agreeing on 4 characters is
      // not evidence. Reporting this as confirmed would manufacture the exact
      // false pass this task removes.
      const result = assessBuildIdentity(rec("b65b"), MERGE_SHA);
      expect(result.identity).toBe("indeterminate");
      expect(result.reason).toContain("too short");
    });

    test("a 7-char prefix that genuinely differs is a mismatch, not indeterminate", () => {
      expect(assessBuildIdentity(rec("ce9af92"), MERGE_SHA).identity).toBe("mismatch");
    });
  });
});

describe("buildIdentityIsConfirmed", () => {
  test("only 'confirmed' counts — 'indeterminate' must not read as success", () => {
    expect(buildIdentityIsConfirmed({ identity: "confirmed", reason: "" })).toBe(true);
    expect(buildIdentityIsConfirmed({ identity: "indeterminate", reason: "" })).toBe(false);
    expect(buildIdentityIsConfirmed({ identity: "mismatch", reason: "" })).toBe(false);
  });
});
