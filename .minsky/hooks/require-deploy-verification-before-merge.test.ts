#!/usr/bin/env bun
// Tests for the deploy-verification PreToolUse merge gate (mt#2353).

import { describe, expect, test, afterEach } from "bun:test";
import {
  hasDeployVerification,
  hasNoDeployImpactTag,
  checkDeployVerification,
  isOverrideSet,
  OVERRIDE_ENV_VAR,
} from "./require-deploy-verification-before-merge";
import type { PrFile } from "./require-execution-evidence-before-merge";

const INFRA_INDEX = "infra/index.ts";
const REVIEWER_RAILWAY_JSON = "services/reviewer/railway.json";
const SECTION_HEADING = "## Deploy verification:";
const DEPLOY_CHANGE_TITLE = "feat: deploy change";
const f = (filename: string): PrFile => ({ filename, status: "modified" });
const DEPLOY_FILES: PrFile[] = [f(INFRA_INDEX), f(REVIEWER_RAILWAY_JSON)];
const NON_DEPLOY_FILES: PrFile[] = [f("src/app.ts"), f("services/reviewer/src/server.ts")];

describe("hasDeployVerification (mt#2353)", () => {
  test("true for a heading with content on following lines", () => {
    const body = `## Summary\nfoo\n\n${SECTION_HEADING}\nRan deployment_wait-for-latest → SUCCESS; /health 200.\n`;
    expect(hasDeployVerification(body)).toBe(true);
  });

  test("true for inline content on the heading line", () => {
    expect(
      hasDeployVerification("Deploy verification: deployment_wait-for-latest returned SUCCESS")
    ).toBe(true);
  });

  test("false for the negation 'No Deploy verification:'", () => {
    expect(hasDeployVerification("No Deploy verification: needed for this change")).toBe(false);
  });

  test("false when the marker has no following content", () => {
    expect(hasDeployVerification(`${SECTION_HEADING}\n\n## Next section\nbody`)).toBe(false);
  });

  test("false when the marker is only inside an HTML comment", () => {
    expect(hasDeployVerification(`<!-- ${SECTION_HEADING} ran it -->\nreal body`)).toBe(false);
  });

  test("false when there is no marker at all", () => {
    expect(hasDeployVerification("## Summary\njust a normal PR body")).toBe(false);
  });

  // Deferral-text-is-not-evidence (mt#2353 Recurrence 3).
  test("false for a deferral-only section ('deferred to §10 post-merge')", () => {
    expect(
      hasDeployVerification(
        `${SECTION_HEADING}\nDeferred to §10 post-merge; target not deployed yet.`
      )
    ).toBe(false);
  });

  test("false for 'will verify later' / 'to be verified' deferrals", () => {
    expect(hasDeployVerification("Deploy verification: will verify it later once deployed")).toBe(
      false
    );
    expect(hasDeployVerification(`${SECTION_HEADING}\nTo be verified after the deploy.`)).toBe(
      false
    );
    expect(
      hasDeployVerification(`${SECTION_HEADING}\nNot yet deployed — pending deployment.`)
    ).toBe(false);
  });

  test("true for a concrete post-merge COMMITMENT that names the action (not a punt)", () => {
    const body = `${SECTION_HEADING}\nWill run deployment_wait-for-latest after merge and confirm SUCCESS + runtime started.`;
    expect(hasDeployVerification(body)).toBe(true);
  });

  test("falls through to a later genuine section when an earlier one is a deferral", () => {
    const body = `${SECTION_HEADING}\ndeferred for now\n\n${SECTION_HEADING}\nRan deployment_wait-for-latest -> SUCCESS; /health 200.`;
    expect(hasDeployVerification(body)).toBe(true);
  });

  // --- Heading-form marker acceptance, no colon required (mt#2648) ---

  test("true for '## Deploy verification' heading with NO colon", () => {
    const body = `## Summary\nfoo\n\n## Deploy verification\nRan deployment_wait-for-latest -> SUCCESS.\n`;
    expect(hasDeployVerification(body)).toBe(true);
  });

  test("true for heading form at any level (h1-h6), colon optional", () => {
    expect(hasDeployVerification("# Deploy verification\nRan deployment_wait-for-latest.")).toBe(
      true
    );
    expect(
      hasDeployVerification("###### Deploy verification\nRan deployment_wait-for-latest.")
    ).toBe(true);
  });

  test("true for heading form case-insensitively with no colon", () => {
    expect(hasDeployVerification("## deploy verification\nSUCCESS confirmed.")).toBe(true);
  });

  test("indented next heading is a section boundary (empty section still blocks)", () => {
    const body = `## Deploy verification\n   ## Next Section\nprose\n`;
    expect(hasDeployVerification(body)).toBe(false);
  });

  test("true for heading form indented up to 3 spaces (CommonMark), false at 4+", () => {
    expect(hasDeployVerification("   ## Deploy verification\nRan it.")).toBe(true);
    // 4+ spaces is a CommonMark code block, not a heading
    expect(hasDeployVerification("    ## Deploy verification\nRan it.")).toBe(false);
  });

  test("still requires a colon for the non-heading plain-label form (unchanged)", () => {
    const body = `## Summary\nfoo\n\nDeploy verification\nRan it.\n`;
    expect(hasDeployVerification(body)).toBe(false);
  });

  test("false for negation in heading-form-without-colon: '## No Deploy verification'", () => {
    const body = `## Summary\nfoo\n\n## No Deploy verification\nNot needed for this change.\n`;
    expect(hasDeployVerification(body)).toBe(false);
  });

  test("false for a deferral-only section in heading-form-without-colon", () => {
    const body = `## Deploy verification\nDeferred to §10 post-merge; not yet deployed.`;
    expect(hasDeployVerification(body)).toBe(false);
  });
});

describe("hasNoDeployImpactTag (mt#2353)", () => {
  test("true when the title carries [no-deploy-impact] (even mid-title)", () => {
    expect(hasNoDeployImpactTag("fix(mt#2353): [no-deploy-impact] comment-only tweak")).toBe(true);
  });

  test("false for an ordinary title", () => {
    expect(hasNoDeployImpactTag("feat(mt#2353): change the deploy config")).toBe(false);
  });
});

describe("checkDeployVerification (mt#2353)", () => {
  test("silent (not blocked) when no deploy surface is touched", () => {
    const r = checkDeployVerification(NON_DEPLOY_FILES, "feat: x", "body");
    expect(r.blocked).toBe(false);
    expect(r.deploySurfaceFiles).toEqual([]);
  });

  test("BLOCKS a deploy-surface PR with no Deploy verification: section", () => {
    const r = checkDeployVerification(DEPLOY_FILES, DEPLOY_CHANGE_TITLE, "## Summary\nno section");
    expect(r.blocked).toBe(true);
    expect(r.deploySurfaceFiles).toEqual([INFRA_INDEX, REVIEWER_RAILWAY_JSON]);
    expect(r.reason).toContain("Deploy verification:");
    expect(r.reason).toContain("deployment_wait-for-latest");
  });

  test("error message names the accepted marker forms (mt#2648)", () => {
    const r = checkDeployVerification(DEPLOY_FILES, DEPLOY_CHANGE_TITLE, "## Summary\nno section");
    expect(r.reason).toContain("Accepted marker forms");
    expect(r.reason).toContain("## Deploy verification");
  });

  test("allows a deploy-surface PR that has the Deploy verification: section", () => {
    const body = `${SECTION_HEADING}\nRan deployment_wait-for-latest → SUCCESS.`;
    const r = checkDeployVerification(DEPLOY_FILES, DEPLOY_CHANGE_TITLE, body);
    expect(r.blocked).toBe(false);
  });

  test("allows a deploy-surface PR with heading-form section with no colon (mt#2648)", () => {
    const body = `## Deploy verification\nRan deployment_wait-for-latest → SUCCESS.`;
    const r = checkDeployVerification(DEPLOY_FILES, DEPLOY_CHANGE_TITLE, body);
    expect(r.blocked).toBe(false);
  });

  test("BLOCKS a deploy-surface PR whose section only DEFERS (deferral-is-not-evidence)", () => {
    const body = `${SECTION_HEADING}\nDeferred to §10 post-merge; not yet deployed.`;
    const r = checkDeployVerification(DEPLOY_FILES, DEPLOY_CHANGE_TITLE, body);
    expect(r.blocked).toBe(true);
  });

  test("allows (with warning) under the [no-deploy-impact] title bypass", () => {
    const r = checkDeployVerification(DEPLOY_FILES, "fix: [no-deploy-impact] comment", "body");
    expect(r.blocked).toBe(false);
    expect(r.bypassDetected).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe("isOverrideSet (mt#2353)", () => {
  afterEach(() => {
    delete process.env[OVERRIDE_ENV_VAR];
  });

  test("false when unset", () => {
    delete process.env[OVERRIDE_ENV_VAR];
    expect(isOverrideSet()).toBe(false);
  });

  test("true for 1/true/yes", () => {
    process.env[OVERRIDE_ENV_VAR] = "1";
    expect(isOverrideSet()).toBe(true);
    process.env[OVERRIDE_ENV_VAR] = "true";
    expect(isOverrideSet()).toBe(true);
    process.env[OVERRIDE_ENV_VAR] = "yes";
    expect(isOverrideSet()).toBe(true);
  });

  test("false for other truthy-looking values", () => {
    process.env[OVERRIDE_ENV_VAR] = "0";
    expect(isOverrideSet()).toBe(false);
  });
});
