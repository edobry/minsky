import { describe, test, expect } from "bun:test";
import {
  isDeploySurfaceFile,
  extractServiceFromPath,
  findAffectedServices,
} from "./deploy-surface";

// Reused fixture paths extracted to constants (custom/no-magic-string-duplication).
const REVIEWER_DOCKERFILE = "services/reviewer/Dockerfile";
const DEPLOY_WORKFLOW = ".github/workflows/deploy.yml";

describe("isDeploySurfaceFile", () => {
  test("matches infra tree files", () => {
    expect(isDeploySurfaceFile("infra/index.ts")).toBe(true);
    expect(isDeploySurfaceFile("infra/nested/module.ts")).toBe(true);
  });

  test("matches per-service Dockerfile / railway.json / deploy.config.ts / railway.config.ts", () => {
    expect(isDeploySurfaceFile(REVIEWER_DOCKERFILE)).toBe(true);
    expect(isDeploySurfaceFile("services/reviewer/railway.json")).toBe(true);
    expect(isDeploySurfaceFile("services/reviewer/deploy.config.ts")).toBe(true);
    expect(isDeploySurfaceFile("services/reviewer/railway.config.ts")).toBe(true);
  });

  test("matches deploy workflow files (bare and per-service)", () => {
    expect(isDeploySurfaceFile(DEPLOY_WORKFLOW)).toBe(true);
    expect(isDeploySurfaceFile(".github/workflows/deploy-reviewer.yaml")).toBe(true);
  });

  test("does not match a non-deploy-surface file", () => {
    expect(isDeploySurfaceFile("src/domain/session/session.ts")).toBe(false);
    expect(isDeploySurfaceFile("services/reviewer/src/index.ts")).toBe(false);
    expect(isDeploySurfaceFile("README.md")).toBe(false);
  });

  test("normalises backslashes and a leading ./", () => {
    expect(isDeploySurfaceFile("./infra/index.ts")).toBe(true);
    expect(isDeploySurfaceFile("infra\\index.ts")).toBe(true);
  });

  test("mt#2809: tolerates null/undefined filename without throwing (trust-boundary guard)", () => {
    // Reproduces the actual runtime shape: `gh api .../files --jq` projects
    // `previous_filename` on every file entry, and jq returns `null` (not
    // "field omitted") for a missing key — so JSON.parse'd PrFile entries
    // carry a real `null`, not `undefined`, for non-renamed files.
    expect(() => isDeploySurfaceFile(null)).not.toThrow();
    expect(() => isDeploySurfaceFile(undefined)).not.toThrow();
    expect(isDeploySurfaceFile(null)).toBe(false);
    expect(isDeploySurfaceFile(undefined)).toBe(false);
  });
});

describe("extractServiceFromPath", () => {
  test("extracts the service name from a services/<name>/... path", () => {
    expect(extractServiceFromPath(REVIEWER_DOCKERFILE)).toBe("reviewer");
    expect(extractServiceFromPath("services/cockpit/src/server.ts")).toBe("cockpit");
  });

  test("returns undefined for paths not scoped to a single service", () => {
    expect(extractServiceFromPath("infra/index.ts")).toBeUndefined();
    expect(extractServiceFromPath(DEPLOY_WORKFLOW)).toBeUndefined();
    expect(extractServiceFromPath("src/domain/session.ts")).toBeUndefined();
  });

  test("mt#2809: returns undefined (not a throw) for null/undefined", () => {
    expect(() => extractServiceFromPath(null)).not.toThrow();
    expect(extractServiceFromPath(null)).toBeUndefined();
    expect(extractServiceFromPath(undefined)).toBeUndefined();
  });
});

describe("findAffectedServices", () => {
  const available = ["reviewer", "cockpit", "site"];

  test("scopes to a single service for a services/<name>/... deploy-surface file", () => {
    const result = findAffectedServices([REVIEWER_DOCKERFILE], available);
    expect(result.services).toEqual(["reviewer"]);
    expect(result.matchedFiles).toEqual([REVIEWER_DOCKERFILE]);
  });

  test("treats infra/ changes as affecting every known service (broad impact)", () => {
    const result = findAffectedServices(["infra/index.ts"], available);
    expect(result.services).toEqual(["cockpit", "reviewer", "site"]);
  });

  test("treats a bare deploy workflow file as broad impact", () => {
    const result = findAffectedServices([DEPLOY_WORKFLOW], available);
    expect(result.services).toEqual(["cockpit", "reviewer", "site"]);
  });

  test("ignores non-deploy-surface files", () => {
    const result = findAffectedServices(["src/domain/session.ts", "README.md"], available);
    expect(result.services).toEqual([]);
    expect(result.matchedFiles).toEqual([]);
  });

  test("skips a services/<name>/... deploy file for a service with no deploy.config.ts", () => {
    const result = findAffectedServices(["services/minsky-ops/Dockerfile"], available);
    expect(result.services).toEqual([]);
    // still recorded as a matched (deploy-surface) file even though it maps
    // to no watchable service
    expect(result.matchedFiles).toEqual(["services/minsky-ops/Dockerfile"]);
  });

  test("combines scoped and broad-impact matches without duplicates", () => {
    const result = findAffectedServices([REVIEWER_DOCKERFILE, "infra/index.ts"], available);
    expect(result.services).toEqual(["cockpit", "reviewer", "site"]);
  });

  test("mixed changed-file set with no deploy-surface matches returns empty", () => {
    const result = findAffectedServices(
      ["packages/domain/src/session/commands/pr-subcommands.ts"],
      available
    );
    expect(result.services).toEqual([]);
    expect(result.matchedFiles).toEqual([]);
  });
});
