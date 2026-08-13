#!/usr/bin/env bun
// Tests for the pure deploy-surface detector (mt#2353).

import { describe, expect, test } from "bun:test";
import { isDeploySurfaceFile, findDeploySurfaceFiles } from "./deploy-surface-detector";
import type { PrFile } from "./require-execution-evidence-before-merge";

// Reused fixture paths extracted to constants (custom/no-magic-string-duplication).
const INFRA_INDEX = "infra/index.ts";
const REVIEWER_RAILWAY_JSON = "services/reviewer/railway.json";
const REVIEWER_DOCKERFILE = "services/reviewer/Dockerfile";
const REVIEWER_DEPLOY_CONFIG = "services/reviewer/deploy.config.ts";

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

  test("does NOT match non-deploy files", () => {
    expect(isDeploySurfaceFile(".github/workflows/test-quality.yml")).toBe(false);
    expect(isDeploySurfaceFile("docs/deployment-platforms.md")).toBe(false);
    expect(isDeploySurfaceFile("infrastructure-notes.md")).toBe(false); // not under infra/
    // scripts/** is outside every deploy workflow's paths: block. (Root
    // src/** is NOT a negative example any more — mt#4013 kept it as a
    // minsky-mcp trigger and aligned the map; see the positive test below.)
    expect(isDeploySurfaceFile("scripts/run-tests-main.ts")).toBe(false);
    // A sibling service NOT scoped by mt#3523's explicit map still resolves
    // via the per-service Dockerfile pattern's anchoring only.
    expect(isDeploySurfaceFile("services/site/Dockerfile.dev")).toBe(false); // anchored $
  });

  // mt#3523: services/reviewer/** is now a BROAD deploy-surface pattern
  // (deploy-reviewer.yml's own `services/reviewer/**` trigger path), so
  // unlike the anchored per-file Dockerfile pattern above, ANY file under
  // services/reviewer/ — including one that wouldn't match the anchored
  // Dockerfile pattern — is now correctly a deploy surface.
  test("mt#3523: services/reviewer/** broad pattern covers files the anchored Dockerfile pattern alone would not", () => {
    expect(isDeploySurfaceFile(`${REVIEWER_DOCKERFILE}.dev`)).toBe(true);
  });

  // mt#3523: application SOURCE that a deploy workflow's `paths:` block
  // actually triggers on IS a deploy surface now, not just deploy config —
  // this closes the mt#1459 coverage hole the superseded test above
  // (removed) used to assert was out of scope by design.
  test("mt#3523: matches services/reviewer/** application source (deploy-reviewer.yml's own trigger paths)", () => {
    expect(isDeploySurfaceFile("services/reviewer/src/server.ts")).toBe(true);
    expect(isDeploySurfaceFile("services/reviewer/migrations/pg/0001_init.sql")).toBe(true);
  });

  test("mt#3523: matches packages/domain/src/** and packages/shared/src/** (both deploy workflows' trigger paths)", () => {
    expect(isDeploySurfaceFile("packages/domain/src/transcripts/turns.ts")).toBe(true);
    expect(isDeploySurfaceFile("packages/shared/src/index.ts")).toBe(true);
  });

  test("mt#4013: matches root src/** (deploy-minsky-mcp.yml's own trigger; bundled into the image)", () => {
    expect(isDeploySurfaceFile("src/index.ts")).toBe(true);
    expect(isDeploySurfaceFile("src/cockpit/web/App.tsx")).toBe(true);
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
      f("scripts/app.ts"),
      f(REVIEWER_RAILWAY_JSON),
      f("README.md"),
    ];
    expect(findDeploySurfaceFiles(files)).toEqual([INFRA_INDEX, REVIEWER_RAILWAY_JSON]);
  });

  test("empty when no deploy surface is touched", () => {
    // mt#3523 widened services/reviewer/** and mt#4013 root src/**, so this
    // fixture uses files outside every mapped tree (services/site/ isn't in
    // the map, and scripts/ is outside every workflow's paths: block).
    const files: PrFile[] = [f("services/site/src/server.ts"), f("scripts/util.ts", "added")];
    expect(findDeploySurfaceFiles(files)).toEqual([]);
  });

  test("flags a rename AWAY from a deploy surface via previous_filename", () => {
    const files: PrFile[] = [f(`${REVIEWER_DOCKERFILE}.bak`, "renamed", REVIEWER_DOCKERFILE)];
    expect(findDeploySurfaceFiles(files)).toEqual([`${REVIEWER_DOCKERFILE}.bak`]);
  });

  test("flags a removed deploy-config file", () => {
    const files: PrFile[] = [f(REVIEWER_DEPLOY_CONFIG, "removed")];
    expect(findDeploySurfaceFiles(files)).toEqual([REVIEWER_DEPLOY_CONFIG]);
  });

  // mt#2809 PR #1951 R1: explicit proof that removed-file classification is
  // via `filename` UNCONDITIONALLY and does NOT depend on `previous_filename`
  // in any way -- including the actual runtime shape where a removed file's
  // `previous_filename` is a literal `null` (removed files never carry a
  // previous_filename; GitHub only sets it for renamed/copied). The
  // `isDeploySurfaceFile(f.filename)` check runs first and unconditionally
  // for every entry, so a `null` (or even a garbage) `previous_filename` on a
  // removed file has zero effect on classification.
  test("mt#2809: a removed deploy-config file classifies via filename regardless of previous_filename value", () => {
    const files = [
      {
        filename: REVIEWER_DEPLOY_CONFIG,
        status: "removed",
        previous_filename: null,
      },
    ] as unknown as PrFile[];
    expect(findDeploySurfaceFiles(files)).toEqual([REVIEWER_DEPLOY_CONFIG]);
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
      { filename: "scripts/app.ts", status: "modified", previous_filename: null },
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
