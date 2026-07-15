#!/usr/bin/env bun
// Tests for the pure deploy-surface detector (mt#2353).

import { describe, expect, test } from "bun:test";
import { isDeploySurfaceFile, findDeploySurfaceFiles } from "./deploy-surface-detector";
import type { PrFile } from "./require-execution-evidence-before-merge";

// Reused fixture paths extracted to constants (custom/no-magic-string-duplication).
const INFRA_INDEX = "infra/index.ts";
const REVIEWER_RAILWAY_JSON = "services/reviewer/railway.json";
const REVIEWER_DOCKERFILE = "services/reviewer/Dockerfile";

describe("isDeploySurfaceFile (mt#2353)", () => {
  test("matches the infra/** infra-as-code tree", () => {
    expect(isDeploySurfaceFile(INFRA_INDEX)).toBe(true);
    expect(isDeploySurfaceFile("infra/Pulumi.yaml")).toBe(true);
    expect(isDeploySurfaceFile("infra/stacks/prod.ts")).toBe(true);
  });

  test("matches per-service deploy/build config", () => {
    expect(isDeploySurfaceFile(REVIEWER_DOCKERFILE)).toBe(true);
    expect(isDeploySurfaceFile(REVIEWER_RAILWAY_JSON)).toBe(true);
    expect(isDeploySurfaceFile("services/site/deploy.config.ts")).toBe(true);
    expect(isDeploySurfaceFile("services/minsky-mcp/railway.config.ts")).toBe(true);
  });

  test("matches deploy workflows: deploy.yml AND deploy-*.yml/.yaml", () => {
    expect(isDeploySurfaceFile(".github/workflows/deploy.yml")).toBe(true); // single-pipeline repos
    expect(isDeploySurfaceFile(".github/workflows/deploy.yaml")).toBe(true);
    expect(isDeploySurfaceFile(".github/workflows/deploy-minsky-mcp.yml")).toBe(true);
    expect(isDeploySurfaceFile(".github/workflows/deploy-reviewer.yaml")).toBe(true);
  });

  test("does NOT match non-deploy files (the coverage hole this guard fills)", () => {
    // A behavior change to deployed SOURCE with no deploy-config file touched is
    // exactly the mt#1459 hole — but it is also NOT a deploy-surface file; the
    // guard intentionally scopes to config-as-code, not arbitrary service source.
    expect(isDeploySurfaceFile("services/reviewer/src/server.ts")).toBe(false);
    expect(isDeploySurfaceFile("src/index.ts")).toBe(false);
    expect(isDeploySurfaceFile(".github/workflows/test-quality.yml")).toBe(false);
    expect(isDeploySurfaceFile("docs/deployment-platforms.md")).toBe(false);
    expect(isDeploySurfaceFile("infrastructure-notes.md")).toBe(false); // not under infra/
    expect(isDeploySurfaceFile(`${REVIEWER_DOCKERFILE}.dev`)).toBe(false); // anchored $
  });

  test("normalises a leading ./ and Windows backslashes", () => {
    expect(isDeploySurfaceFile(`./${INFRA_INDEX}`)).toBe(true);
    expect(isDeploySurfaceFile("infra\\index.ts")).toBe(true);
  });
});

describe("findDeploySurfaceFiles (mt#2353)", () => {
  const f = (
    filename: string,
    status: PrFile["status"] = "modified",
    previous_filename?: string
  ): PrFile => ({ filename, status, previous_filename });

  test("returns only the deploy-surface files from a mixed changeset", () => {
    const files: PrFile[] = [
      f(INFRA_INDEX),
      f("src/app.ts"),
      f(REVIEWER_RAILWAY_JSON),
      f("README.md"),
    ];
    expect(findDeploySurfaceFiles(files)).toEqual([INFRA_INDEX, REVIEWER_RAILWAY_JSON]);
  });

  test("empty when no deploy surface is touched", () => {
    const files: PrFile[] = [f("services/reviewer/src/server.ts"), f("src/util.ts", "added")];
    expect(findDeploySurfaceFiles(files)).toEqual([]);
  });

  test("flags a rename AWAY from a deploy surface via previous_filename", () => {
    const files: PrFile[] = [f(`${REVIEWER_DOCKERFILE}.bak`, "renamed", REVIEWER_DOCKERFILE)];
    expect(findDeploySurfaceFiles(files)).toEqual([`${REVIEWER_DOCKERFILE}.bak`]);
  });

  test("flags a removed deploy-config file", () => {
    const files: PrFile[] = [f("services/reviewer/deploy.config.ts", "removed")];
    expect(findDeploySurfaceFiles(files)).toEqual(["services/reviewer/deploy.config.ts"]);
  });

  test("mt#2345 incident reproduction: infra/index.ts + services/reviewer/railway.json", () => {
    const files: PrFile[] = [f(INFRA_INDEX), f(REVIEWER_RAILWAY_JSON)];
    expect(findDeploySurfaceFiles(files).length).toBe(2);
  });

  // mt#2809 regression: `fetchPrFiles`'s `gh api ... --jq` projection
  // (`previous_filename: .previous_filename`) evaluates that field on EVERY
  // file entry regardless of status. jq returns `null` (not "field omitted")
  // for a missing key, so a non-renamed file's JSON.parse'd PrFile carries a
  // literal `previous_filename: null` — NOT `undefined`, which is what every
  // fixture above (built via the `f()` helper, which never sets the field at
  // all) actually produces. The old `f.previous_filename !== undefined`
  // guard treated `null` as "present" and crashed `normalisePath` on this
  // exact shape — reproduced here via an explicit `previous_filename: null`
  // rather than the `f()` helper, to match the real runtime payload.
  test("mt#2809: does not throw on the actual runtime payload shape (previous_filename: null on non-renamed files)", () => {
    const files = [
      { filename: "src/app.ts", status: "modified", previous_filename: null },
      { filename: REVIEWER_RAILWAY_JSON, status: "modified", previous_filename: null },
      { filename: "README.md", status: "added", previous_filename: null },
      {
        filename: `${REVIEWER_DOCKERFILE}.bak`,
        status: "renamed",
        previous_filename: REVIEWER_DOCKERFILE,
      },
    ] as unknown as PrFile[];

    expect(() => findDeploySurfaceFiles(files)).not.toThrow();
    // Correct surface classification for the remaining (non-null) files:
    // the railway.json modification and the rename-away-from-Dockerfile are
    // both deploy-surface; the plain app/README edits are not.
    expect(findDeploySurfaceFiles(files)).toEqual([
      REVIEWER_RAILWAY_JSON,
      `${REVIEWER_DOCKERFILE}.bak`,
    ]);
  });

  test("mt#2809: does not throw when a file's OWN filename is null (defense in depth)", () => {
    const files = [
      { filename: null, status: "modified", previous_filename: null },
      f(REVIEWER_RAILWAY_JSON),
    ] as unknown as PrFile[];

    expect(() => findDeploySurfaceFiles(files)).not.toThrow();
    expect(findDeploySurfaceFiles(files)).toEqual([REVIEWER_RAILWAY_JSON]);
  });
});
