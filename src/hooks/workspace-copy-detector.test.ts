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
  discoverProtectedDockerfiles,
  resolveWorkspacePackageJsonPaths,
  readWorkspacesField,
  runWorkspaceCopyCheck,
  isWorkspaceCopyOverrideTruthy,
  WORKSPACE_COPY_CHECK_OVERRIDE_ENV,
  type FsOps,
} from "./workspace-copy-detector";

/**
 * Build an in-memory FsOps mock from a flat path-set. Paths that end with
 * `/` are treated as directories; paths without the trailing slash are
 * files. `existsSync` and `statSync` use this set; `readdirSync` returns
 * the direct children of a given directory.
 *
 * For tests that need file CONTENTS (mt#1992 end-to-end tests of
 * runWorkspaceCopyCheck), use `fakeFsWithContents` instead — it accepts
 * a `path → content` map so `readTextFileSync` calls return the right
 * file body.
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
    readTextFileSync(_path: string): string {
      // Paths-only fakeFs doesn't know contents; callers that need
      // contents should use fakeFsWithContents below. This impl exists
      // only because the FsOps interface requires it.
      throw new Error(`fakeFs has no contents for ${_path} — use fakeFsWithContents`);
    },
  };
}

/**
 * Build an in-memory FsOps mock from a `path → content` map. Files are
 * inferred from the map keys; intermediate directories are synthesized.
 * `readTextFileSync` returns the stored content (throws on unknown
 * paths, matching real fs semantics).
 */
function fakeFsWithContents(files: Record<string, string>): FsOps {
  const fileSet = new Set(Object.keys(files));
  const dirSet = new Set<string>();
  for (const filePath of fileSet) {
    const parts = filePath.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirSet.add(parts.slice(0, i).join("/"));
    }
  }
  return {
    existsSync(path: string): boolean {
      return fileSet.has(path) || dirSet.has(path);
    },
    readdirSync(dir: string): string[] {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const children = new Set<string>();
      for (const p of [...fileSet, ...dirSet]) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const firstSeg = rest.split("/")[0];
        if (firstSeg && firstSeg.length > 0) children.add(firstSeg);
      }
      return [...children];
    },
    statSync(path: string): { isDirectory(): boolean } {
      return {
        isDirectory: () => dirSet.has(path),
      };
    },
    readTextFileSync(path: string): string {
      const content = files[path];
      if (content === undefined) {
        throw new Error(`ENOENT: fakeFsWithContents has no file at ${path}`);
      }
      return content;
    },
  };
}

const FROZEN_INSTALL_LINE = "RUN bun install --frozen-lockfile --production --ignore-scripts";
const FROM_BUN_BASE = "FROM oven/bun:1.2-slim";
const FROM_NODE_BASE = "FROM node:20-alpine";
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
        FROM_NODE_BASE,
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

  // ─────────────────────────────────────────────────────────────────────
  // mt#1992 — generalized discovery + per-Dockerfile aggregation tests
  // ─────────────────────────────────────────────────────────────────────

  const REPO_ROOT = "/fake/repo";
  const ROOT_PKG = `${REPO_ROOT}/package.json`;
  const ROOT_DOCKERFILE = `${REPO_ROOT}/Dockerfile`;
  const SHARED_PKG_FILE = `${REPO_ROOT}/packages/shared/package.json`;
  const SITE_PKG_FILE = `${REPO_ROOT}/services/site/package.json`;
  const REVIEWER_PKG_FILE = `${REPO_ROOT}/services/reviewer/package.json`;
  const REVIEWER_DOCKERFILE = `${REPO_ROOT}/services/reviewer/Dockerfile`;
  const DF_ROOT_REL = "Dockerfile";
  const DF_REVIEWER_REL = "services/reviewer/Dockerfile";

  const ROOT_PKG_JSON = JSON.stringify({
    workspaces: ["packages/*", "services/*"],
  });

  const ROOT_DOCKERFILE_GOOD = [
    FROM_BUN_BASE,
    "WORKDIR /app",
    COPY_ROOT_MANIFESTS,
    COPY_SHARED_PKG,
    COPY_SITE_PKG,
    COPY_REVIEWER_PKG,
    FROZEN_INSTALL_LINE,
    COPY_SRC,
  ].join("\n");

  describe("discoverProtectedDockerfiles (mt#1992) — fs-injected", () => {
    test("finds root Dockerfile when it contains the frozen-lockfile install step", () => {
      const fs = fakeFsWithContents({
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
      });
      expect(discoverProtectedDockerfiles(REPO_ROOT, fs)).toEqual([DF_ROOT_REL]);
    });

    test("finds sub-project Dockerfile under services/ when it contains the install step", () => {
      const reviewerDockerfile = [
        FROM_BUN_BASE,
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        COPY_SITE_PKG,
        COPY_REVIEWER_PKG,
        FROZEN_INSTALL_LINE,
      ].join("\n");
      const fs = fakeFsWithContents({
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
        [REVIEWER_DOCKERFILE]: reviewerDockerfile,
      });
      expect(discoverProtectedDockerfiles(REPO_ROOT, fs).sort()).toEqual([
        DF_ROOT_REL,
        DF_REVIEWER_REL,
      ]);
    });

    test("skips Dockerfiles without the frozen-lockfile install step", () => {
      const npmDockerfile = [FROM_NODE_BASE, "RUN npm ci"].join("\n");
      const fs = fakeFsWithContents({
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
        [REVIEWER_DOCKERFILE]: npmDockerfile,
      });
      expect(discoverProtectedDockerfiles(REPO_ROOT, fs)).toEqual([DF_ROOT_REL]);
    });

    test("returns empty when no Dockerfiles exist", () => {
      const fs = fakeFsWithContents({});
      expect(discoverProtectedDockerfiles(REPO_ROOT, fs)).toEqual([]);
    });
  });

  describe("runWorkspaceCopyCheck (mt#1992) — fs-injected end-to-end", () => {
    test("mt#1991 regression: services/reviewer/Dockerfile missing services/site COPY is flagged", () => {
      // Pre-fix state of services/reviewer/Dockerfile from 2026-05-20
      // mt#1991: copies packages/shared + services/reviewer package.jsons
      // but missed services/site (which mt#1934 had added as a workspace).
      // Eight consecutive Railway deploys failed over ~4 hours.
      const reviewerDockerfile = [
        FROM_BUN_BASE,
        "WORKDIR /app",
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        COPY_REVIEWER_PKG, // services/site/package.json MISSING
        FROZEN_INSTALL_LINE,
        COPY_SRC,
      ].join("\n");

      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
        [SITE_PKG_FILE]: "{}",
        [REVIEWER_PKG_FILE]: "{}",
        [REVIEWER_DOCKERFILE]: reviewerDockerfile,
        [SHARED_PKG_FILE]: "{}",
      });

      const results = runWorkspaceCopyCheck(REPO_ROOT, fs);
      if (results === null) throw new Error("expected non-null results");
      const failing = results.filter((r) => r.missing.length > 0);
      expect(failing).toHaveLength(1);
      const first = failing[0];
      if (!first) throw new Error("expected at least one failing result");
      expect(first.dockerfileRelPath).toBe(DF_REVIEWER_REL);
      expect(first.missing.map((m) => m.workspacePath)).toEqual([WS_SITE]);
    });

    test("both root and sub-project Dockerfiles pass when all COPYs are present", () => {
      const reviewerDockerfileGood = [
        FROM_BUN_BASE,
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        COPY_SITE_PKG,
        COPY_REVIEWER_PKG,
        FROZEN_INSTALL_LINE,
      ].join("\n");

      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
        [SITE_PKG_FILE]: "{}",
        [REVIEWER_PKG_FILE]: "{}",
        [REVIEWER_DOCKERFILE]: reviewerDockerfileGood,
        [SHARED_PKG_FILE]: "{}",
      });

      const results = runWorkspaceCopyCheck(REPO_ROOT, fs);
      if (results === null) throw new Error("expected non-null results");
      const failing = results.filter((r) => r.missing.length > 0);
      expect(failing).toEqual([]);
      expect(results.map((r) => r.dockerfileRelPath).sort()).toEqual([
        DF_ROOT_REL,
        DF_REVIEWER_REL,
      ]);
    });

    test("sub-project Dockerfile WITHOUT frozen-lockfile install is skipped (not protected)", () => {
      const npmDockerfile = [
        FROM_NODE_BASE,
        "WORKDIR /app",
        "COPY package.json ./",
        "RUN npm ci",
        "COPY . .",
      ].join("\n");

      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
        [SITE_PKG_FILE]: "{}",
        [REVIEWER_PKG_FILE]: "{}",
        [REVIEWER_DOCKERFILE]: npmDockerfile,
        [SHARED_PKG_FILE]: "{}",
      });

      const results = runWorkspaceCopyCheck(REPO_ROOT, fs);
      if (results === null) throw new Error("expected non-null results");
      expect(results.map((r) => r.dockerfileRelPath)).toEqual([DF_ROOT_REL]);
    });

    test("missing root package.json returns null (silent short-circuit)", () => {
      const fs = fakeFsWithContents({
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
      });
      expect(runWorkspaceCopyCheck(REPO_ROOT, fs)).toBeNull();
    });

    test("repo with no protected Dockerfiles returns empty array (silent pass)", () => {
      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [SHARED_PKG_FILE]: "{}",
      });
      expect(runWorkspaceCopyCheck(REPO_ROOT, fs)).toEqual([]);
    });

    test("violations across multiple Dockerfiles are reported per-file", () => {
      const missingFromAny = [
        FROM_BUN_BASE,
        COPY_ROOT_MANIFESTS,
        COPY_SHARED_PKG,
        COPY_REVIEWER_PKG,
        FROZEN_INSTALL_LINE,
      ].join("\n");

      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [ROOT_DOCKERFILE]: missingFromAny,
        [SITE_PKG_FILE]: "{}",
        [REVIEWER_PKG_FILE]: "{}",
        [REVIEWER_DOCKERFILE]: missingFromAny,
        [SHARED_PKG_FILE]: "{}",
      });

      const results = runWorkspaceCopyCheck(REPO_ROOT, fs);
      if (results === null) throw new Error("expected non-null results");
      const failing = results.filter((r) => r.missing.length > 0);
      expect(failing).toHaveLength(2);
      expect(failing.map((r) => r.dockerfileRelPath).sort()).toEqual([
        DF_ROOT_REL,
        DF_REVIEWER_REL,
      ]);
      for (const r of failing) {
        expect(r.missing.map((m) => m.workspacePath)).toEqual([WS_SITE]);
      }
    });
  });
});
