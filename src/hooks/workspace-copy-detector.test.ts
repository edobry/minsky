/**
 * mt#1984 — tests for the workspace-COPY pre-commit detector.
 *
 * Acceptance tests map to the spec's Success Criterion 5:
 *
 * (a) all workspaces COPYed → checker passes (empty result);
 * (b) one workspace missing → checker flags exactly that workspace;
 * (c) multiple workspaces missing → all listed;
 * (d) workspaces glob matches a directory with NO package.json (e.g.
 *     `services/minsky-mcp/`) → not flagged (the resolver excludes it);
 * (e) Dockerfile has no `RUN bun install --frozen-lockfile` step →
 *     checker short-circuits with no-op pass.
 *
 * Plus the spec's Acceptance Test 1 mt#1977 reproduction: a Dockerfile
 * matching the pre-mt#1977 state (services/site missing) → checker
 * flags services/site/package.json with the literal COPY line.
 */

import { describe, test, expect } from "bun:test";

import {
  detectMissingWorkspaceCopies,
  resolveWorkspacePackageJsonPaths,
  readWorkspacesField,
  isWorkspaceCopyOverrideTruthy,
  WORKSPACE_COPY_CHECK_OVERRIDE_ENV,
  type FsOps,
} from "./workspace-copy-detector";

/**
 * Build an in-memory FsOps mock from a flat path-set. Paths that end with
 * `/` are treated as directories; paths without the trailing slash are
 * files. `existsSync` and `statSync` use this set; `readdirSync` returns
 * the direct children of a given directory.
 */
function fakeFs(paths: readonly string[]): FsOps {
  const set = new Set(paths);
  return {
    existsSync(path: string): boolean {
      return set.has(path) || set.has(`${path}/`);
    },
    readdirSync(dir: string): string[] {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const children = new Set<string>();
      for (const p of set) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const firstSeg = rest.split("/")[0];
        if (firstSeg && firstSeg.length > 0) children.add(firstSeg);
      }
      return [...children];
    },
    statSync(path: string): { isDirectory(): boolean } {
      return {
        isDirectory: () => set.has(`${path}/`),
      };
    },
  };
}

const FROZEN_INSTALL_LINE = "RUN bun install --frozen-lockfile --production --ignore-scripts";
const FROM_BUN_BASE = "FROM oven/bun:1.2-slim";
const COPY_ROOT_MANIFESTS = "COPY package.json bun.lock ./";
const COPY_SHARED_PKG = "COPY packages/shared/package.json ./packages/shared/package.json";
const COPY_REVIEWER_PKG = "COPY services/reviewer/package.json ./services/reviewer/package.json";
const COPY_SITE_PKG = "COPY services/site/package.json ./services/site/package.json";
const COPY_SRC = "COPY src ./src";
const WS_SHARED = "packages/shared";
const WS_REVIEWER = "services/reviewer";
const WS_SITE = "services/site";
const ALL_WORKSPACE_GLOBS = ["packages/*", "services/*"];

describe("workspace-copy-detector — mt#1984", () => {
  describe("detectMissingWorkspaceCopies (pure)", () => {
    test("acceptance (a): all workspaces COPYed → empty result", () => {
      const dockerfile = [
        FROM_BUN_BASE,
        "WORKDIR /app",
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        COPY_SITE_PKG,
        COPY_REVIEWER_PKG,
        FROZEN_INSTALL_LINE,
        COPY_SRC,
      ].join("\n");

      const result = detectMissingWorkspaceCopies({
        workspacePackageJsons: [WS_SHARED, WS_SITE, WS_REVIEWER],
        dockerfileText: dockerfile,
      });
      expect(result).toEqual([]);
    });

    test("acceptance (b): one workspace missing → flagged with the COPY line to add", () => {
      const dockerfile = [
        FROM_BUN_BASE,
        "WORKDIR /app",
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        COPY_REVIEWER_PKG,
        FROZEN_INSTALL_LINE,
        COPY_SRC,
      ].join("\n");

      const result = detectMissingWorkspaceCopies({
        workspacePackageJsons: [WS_SHARED, WS_SITE, WS_REVIEWER],
        dockerfileText: dockerfile,
      });
      expect(result).toEqual([
        {
          workspacePath: WS_SITE,
          packageJsonRelPath: "services/site/package.json",
          copyLineToAdd: COPY_SITE_PKG,
        },
      ]);
    });

    test("acceptance (c): multiple workspaces missing → all flagged in order", () => {
      const dockerfile = [
        FROM_BUN_BASE,
        "WORKDIR /app",
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        FROZEN_INSTALL_LINE,
        COPY_SRC,
      ].join("\n");

      const result = detectMissingWorkspaceCopies({
        workspacePackageJsons: [WS_SHARED, WS_SITE, WS_REVIEWER],
        dockerfileText: dockerfile,
      });
      expect(result.map((r) => r.workspacePath)).toEqual([WS_SITE, WS_REVIEWER]);
    });

    test("acceptance (e): Dockerfile with no frozen-lockfile install → no-op pass", () => {
      const dockerfile = [
        "FROM node:20-alpine",
        "WORKDIR /app",
        "COPY package.json ./",
        "RUN npm ci",
        "COPY . .",
      ].join("\n");

      const result = detectMissingWorkspaceCopies({
        workspacePackageJsons: [WS_SHARED, "packages/missing"],
        dockerfileText: dockerfile,
      });
      expect(result).toEqual([]);
    });

    test("COPY lines AFTER the frozen-install step do NOT satisfy the contract", () => {
      // services/site is COPYed, but after the install — bun has already
      // failed by then. The check must flag it as missing.
      const dockerfile = [
        FROM_BUN_BASE,
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        FROZEN_INSTALL_LINE,
        COPY_SITE_PKG,
      ].join("\n");

      const result = detectMissingWorkspaceCopies({
        workspacePackageJsons: [WS_SHARED, WS_SITE],
        dockerfileText: dockerfile,
      });
      expect(result.map((r) => r.workspacePath)).toEqual([WS_SITE]);
    });

    test("COPY destination tolerated: absolute /app/... path also satisfies the check", () => {
      const dockerfile = [
        FROM_BUN_BASE,
        "WORKDIR /app",
        COPY_ROOT_MANIFESTS,
        "COPY packages/shared/package.json /app/packages/shared/package.json",
        FROZEN_INSTALL_LINE,
      ].join("\n");

      const result = detectMissingWorkspaceCopies({
        workspacePackageJsons: [WS_SHARED],
        dockerfileText: dockerfile,
      });
      expect(result).toEqual([]);
    });

    test("leading-whitespace tolerance: indented `RUN bun install --frozen-lockfile` still matched", () => {
      // PR #1193 R1 B2: pre-fix, `/^RUN .../m` anchored to the start of
      // the line with no leading-whitespace tolerance — an indented
      // install line (valid Dockerfile syntax) would silently bypass the
      // check by failing the boundary match and returning [].
      //
      // Negative-case verification: a Dockerfile with an indented
      // frozen-lockfile install AND a missing workspace COPY must STILL
      // flag the missing COPY, not return [].
      const dockerfile = [
        FROM_BUN_BASE,
        "WORKDIR /app",
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        // Two-space indent in front of the install — valid Dockerfile,
        // post-fix must match, pre-fix would NOT and silently bypass.
        `  ${FROZEN_INSTALL_LINE}`,
        COPY_SRC,
      ].join("\n");

      const result = detectMissingWorkspaceCopies({
        workspacePackageJsons: [WS_SHARED, WS_SITE],
        dockerfileText: dockerfile,
      });
      expect(result.map((r) => r.workspacePath)).toEqual([WS_SITE]);
    });

    test("mt#1977 reproduction: pre-fix Dockerfile + services/site workspace → flagged", () => {
      // Simulates the Dockerfile state on commit 57c2e868 (the merge of
      // PR #1186), which introduced services/site as a workspace but
      // missed the COPY. This is the exact state the gate is designed
      // to refuse.
      const dockerfile = [
        FROM_BUN_BASE,
        "WORKDIR /app",
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        COPY_REVIEWER_PKG,
        FROZEN_INSTALL_LINE,
        COPY_SRC,
      ].join("\n");

      const result = detectMissingWorkspaceCopies({
        workspacePackageJsons: [WS_SHARED, WS_SITE, WS_REVIEWER],
        dockerfileText: dockerfile,
      });
      expect(result).toEqual([
        {
          workspacePath: WS_SITE,
          packageJsonRelPath: "services/site/package.json",
          copyLineToAdd: COPY_SITE_PKG,
        },
      ]);
    });
  });

  describe("resolveWorkspacePackageJsonPaths (fs)", () => {
    const REPO_ROOT = "/fake/repo";

    test("acceptance (d): directory matched by glob but no package.json → excluded", () => {
      // services/minsky-mcp/ is the mt#1977 instance of this: matches
      // the services/* glob but has no package.json, so bun's workspaces
      // glob skips it. Our resolver MUST also skip it.
      const fs = fakeFs([
        `${REPO_ROOT}/`,
        `${REPO_ROOT}/services/`,
        `${REPO_ROOT}/services/site/`,
        `${REPO_ROOT}/services/site/package.json`,
        `${REPO_ROOT}/services/reviewer/`,
        `${REPO_ROOT}/services/reviewer/package.json`,
        `${REPO_ROOT}/services/minsky-mcp/`, // directory exists
        // ... but NO services/minsky-mcp/package.json
      ]);

      const result = resolveWorkspacePackageJsonPaths(REPO_ROOT, ["services/*"], fs);
      expect(result).toEqual([WS_REVIEWER, WS_SITE]);
      expect(result).not.toContain("services/minsky-mcp");
    });

    test("literal workspace path (no glob) — included if package.json exists", () => {
      const fs = fakeFs([
        `${REPO_ROOT}/`,
        `${REPO_ROOT}/packages/`,
        `${REPO_ROOT}/packages/shared/`,
        `${REPO_ROOT}/packages/shared/package.json`,
      ]);

      const result = resolveWorkspacePackageJsonPaths(REPO_ROOT, [WS_SHARED], fs);
      expect(result).toEqual([WS_SHARED]);
    });

    test("parent directory absent → returns empty (no crash)", () => {
      const fs = fakeFs([`${REPO_ROOT}/`]);

      const result = resolveWorkspacePackageJsonPaths(REPO_ROOT, ["packages/*", "services/*"], fs);
      expect(result).toEqual([]);
    });

    test("unsupported glob forms are skipped (conservative)", () => {
      const fs = fakeFs([
        `${REPO_ROOT}/`,
        `${REPO_ROOT}/packages/`,
        `${REPO_ROOT}/packages/shared/`,
        `${REPO_ROOT}/packages/shared/package.json`,
      ]);

      const result = resolveWorkspacePackageJsonPaths(
        REPO_ROOT,
        ["packages/**", "packages/[abc]*", "!packages/*-archived"],
        fs
      );
      // No supported patterns → empty.
      expect(result).toEqual([]);
    });
  });

  describe("readWorkspacesField", () => {
    test("array form returns the array", () => {
      expect(readWorkspacesField({ workspaces: ALL_WORKSPACE_GLOBS })).toEqual([
        "packages/*",
        "services/*",
      ]);
    });

    test("object form returns the .packages array", () => {
      expect(readWorkspacesField({ workspaces: { packages: ["packages/*"] } })).toEqual([
        "packages/*",
      ]);
    });

    test("absent → empty array", () => {
      expect(readWorkspacesField({})).toEqual([]);
      expect(readWorkspacesField(undefined)).toEqual([]);
    });

    test("malformed (object without .packages) → empty array", () => {
      expect(
        readWorkspacesField({
          workspaces: { foo: ["packages/*"] } as unknown as { packages?: string[] },
        })
      ).toEqual([]);
    });
  });

  describe("isWorkspaceCopyOverrideTruthy", () => {
    test("accepts canonical truthy values", () => {
      expect(isWorkspaceCopyOverrideTruthy("1")).toBe(true);
      expect(isWorkspaceCopyOverrideTruthy("true")).toBe(true);
      expect(isWorkspaceCopyOverrideTruthy("yes")).toBe(true);
      expect(isWorkspaceCopyOverrideTruthy("TRUE")).toBe(true);
    });

    test("rejects empty / non-canonical values", () => {
      expect(isWorkspaceCopyOverrideTruthy(undefined)).toBe(false);
      expect(isWorkspaceCopyOverrideTruthy("")).toBe(false);
      expect(isWorkspaceCopyOverrideTruthy("0")).toBe(false);
      expect(isWorkspaceCopyOverrideTruthy("false")).toBe(false);
      expect(isWorkspaceCopyOverrideTruthy("no")).toBe(false);
      expect(isWorkspaceCopyOverrideTruthy("on")).toBe(false); // not in the truthy set
    });

    test("env var name is the canonical constant", () => {
      expect(WORKSPACE_COPY_CHECK_OVERRIDE_ENV).toBe("MINSKY_SKIP_WORKSPACE_COPY_CHECK");
    });
  });
});
