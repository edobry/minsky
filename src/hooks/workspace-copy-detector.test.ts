/**
 * mt#1984 / mt#1992 / mt#2621 — tests for the Dockerfile workspace-COPY
 * generator/resolver.
 *
 * mt#2621 replaced the original detect-and-block guard with a
 * generate-and-restage mechanism. These tests cover:
 *
 * (a) block templating (`renderWorkspaceCopyBlock`,
 *     `applyGeneratedWorkspaceCopyBlock`) — sorted output, marker
 *     preservation, missing-marker error, no-op when already fresh;
 * (b) the surviving discovery/resolution primitives
 *     (`readWorkspacesField`, `resolveWorkspacePackageJsonPaths`,
 *     `discoverProtectedDockerfiles`) — unchanged behavior from mt#1984/1992;
 * (c) the end-to-end freshness computation
 *     (`planDockerfileWorkspaceCopyRegeneration`) across multiple
 *     protected Dockerfiles, mirroring the mt#1991 regression and the
 *     "workspaces glob matches a directory with no package.json" case.
 */

import { describe, test, expect } from "bun:test";

import {
  renderWorkspaceCopyBlock,
  applyGeneratedWorkspaceCopyBlock,
  discoverProtectedDockerfiles,
  resolveWorkspacePackageJsonPaths,
  readWorkspacesField,
  planDockerfileWorkspaceCopyRegeneration,
  WORKSPACE_COPY_BLOCK_START,
  WORKSPACE_COPY_BLOCK_END,
  type FsOps,
} from "./workspace-copy-detector";

/**
 * Build an in-memory FsOps mock from a flat path-set. Paths that end with
 * `/` are treated as directories; paths without the trailing slash are
 * files. `existsSync` and `statSync` use this set; `readdirSync` returns
 * the direct children of a given directory.
 *
 * For tests that need file CONTENTS, use `fakeFsWithContents` instead — it
 * accepts a `path → content` map so `readTextFileSync` calls return the
 * right file body.
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
const COPY_SRC = "COPY src ./src";
const WS_SHARED = "packages/shared";
const WS_REVIEWER = "services/reviewer";
const WS_SITE = "services/site";

function blockFor(workspaces: readonly string[]): string {
  return renderWorkspaceCopyBlock(workspaces);
}

function dockerfileWithBlock(workspaces: readonly string[], extraAfter: string[] = []): string {
  return [
    FROM_BUN_BASE,
    "WORKDIR /app",
    COPY_ROOT_MANIFESTS,
    blockFor(workspaces),
    FROZEN_INSTALL_LINE,
    COPY_SRC,
    ...extraAfter,
  ].join("\n");
}

describe("workspace-copy-detector — mt#2621 generation", () => {
  describe("renderWorkspaceCopyBlock", () => {
    test("renders one COPY line per workspace, sorted", () => {
      const block = renderWorkspaceCopyBlock([WS_SITE, WS_SHARED, WS_REVIEWER]);
      const copyLines = block
        .split("\n")
        .filter((l) => l.startsWith("COPY "))
        .map((l) => l.trim());
      expect(copyLines).toEqual([
        `COPY ${WS_SHARED}/package.json ./${WS_SHARED}/package.json`,
        `COPY ${WS_REVIEWER}/package.json ./${WS_REVIEWER}/package.json`,
        `COPY ${WS_SITE}/package.json ./${WS_SITE}/package.json`,
      ]);
    });

    test("includes start and end markers", () => {
      const block = renderWorkspaceCopyBlock([WS_SHARED]);
      expect(block).toContain(WORKSPACE_COPY_BLOCK_START);
      expect(block).toContain(WORKSPACE_COPY_BLOCK_END);
    });

    test("empty workspace list still renders markers with no COPY lines", () => {
      const block = renderWorkspaceCopyBlock([]);
      expect(block).toContain(WORKSPACE_COPY_BLOCK_START);
      expect(block).toContain(WORKSPACE_COPY_BLOCK_END);
      expect(block.split("\n").some((l) => l.startsWith("COPY "))).toBe(false);
    });
  });

  describe("applyGeneratedWorkspaceCopyBlock", () => {
    test("missing markers → error", () => {
      const dockerfile = [FROM_BUN_BASE, COPY_ROOT_MANIFESTS, FROZEN_INSTALL_LINE].join("\n");
      const result = applyGeneratedWorkspaceCopyBlock(dockerfile, [WS_SHARED]);
      expect("error" in result).toBe(true);
      if (!("error" in result)) throw new Error("expected error result");
      expect(result.error).toContain("missing the generated workspace-COPY markers");
    });

    test("end marker before start marker → error", () => {
      const dockerfile = [WORKSPACE_COPY_BLOCK_END, WORKSPACE_COPY_BLOCK_START].join("\n");
      const result = applyGeneratedWorkspaceCopyBlock(dockerfile, [WS_SHARED]);
      expect("error" in result).toBe(true);
    });

    test("already fresh → changed: false, text unchanged", () => {
      const dockerfile = dockerfileWithBlock([WS_SHARED, WS_SITE]);
      const result = applyGeneratedWorkspaceCopyBlock(dockerfile, [WS_SHARED, WS_SITE]);
      expect("error" in result).toBe(false);
      if ("error" in result) throw new Error("expected non-error result");
      expect(result.changed).toBe(false);
      expect(result.text).toBe(dockerfile);
    });

    test("stale block (mt#1977-shape drift) → changed: true, block replaced", () => {
      // Dockerfile was generated for [shared, reviewer]; workspaces glob now
      // resolves to [shared, reviewer, site] (a new workspace was added).
      const dockerfile = dockerfileWithBlock([WS_SHARED, WS_REVIEWER]);
      const result = applyGeneratedWorkspaceCopyBlock(dockerfile, [
        WS_SHARED,
        WS_REVIEWER,
        WS_SITE,
      ]);
      expect("error" in result).toBe(false);
      if ("error" in result) throw new Error("expected non-error result");
      expect(result.changed).toBe(true);
      expect(result.text).toContain(`COPY ${WS_SITE}/package.json ./${WS_SITE}/package.json`);
      // Surrounding content (outside the block) is preserved verbatim.
      expect(result.text).toContain(FROZEN_INSTALL_LINE);
      expect(result.text).toContain(COPY_SRC);
    });

    test("regenerating a workspace REMOVAL shrinks the block", () => {
      const dockerfile = dockerfileWithBlock([WS_SHARED, WS_REVIEWER, WS_SITE]);
      const result = applyGeneratedWorkspaceCopyBlock(dockerfile, [WS_SHARED]);
      expect("error" in result).toBe(false);
      if ("error" in result) throw new Error("expected non-error result");
      expect(result.changed).toBe(true);
      expect(result.text).not.toContain(WS_SITE);
      expect(result.text).not.toContain(WS_REVIEWER);
    });
  });

  describe("resolveWorkspacePackageJsonPaths (fs)", () => {
    const REPO_ROOT = "/fake/repo";

    test("directory matched by glob but no package.json → excluded", () => {
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
      expect(readWorkspacesField({ workspaces: ["packages/*", "services/*"] })).toEqual([
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

  // ─────────────────────────────────────────────────────────────────────
  // discoverProtectedDockerfiles (mt#1992) — unchanged behavior
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

  const ROOT_DOCKERFILE_GOOD = dockerfileWithBlock([WS_SHARED, WS_SITE, WS_REVIEWER]);

  describe("discoverProtectedDockerfiles (mt#1992) — fs-injected", () => {
    test("finds root Dockerfile when it contains the frozen-lockfile install step", () => {
      const fs = fakeFsWithContents({
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
      });
      expect(discoverProtectedDockerfiles(REPO_ROOT, fs)).toEqual([DF_ROOT_REL]);
    });

    test("finds sub-project Dockerfile under services/ when it contains the install step", () => {
      const reviewerDockerfile = dockerfileWithBlock([WS_SHARED, WS_SITE, WS_REVIEWER]);
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

  // ─────────────────────────────────────────────────────────────────────
  // planDockerfileWorkspaceCopyRegeneration (mt#2621) — end-to-end
  // ─────────────────────────────────────────────────────────────────────

  describe("planDockerfileWorkspaceCopyRegeneration — fs-injected end-to-end", () => {
    test("mt#1991 regression: services/reviewer/Dockerfile missing services/site COPY is flagged stale", () => {
      // Pre-fix state of services/reviewer/Dockerfile from 2026-05-20
      // mt#1991: copies packages/shared + services/reviewer package.jsons
      // but missed services/site (which mt#1934 had added as a workspace).
      const reviewerDockerfile = dockerfileWithBlock([WS_SHARED, WS_REVIEWER]);

      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
        [SITE_PKG_FILE]: "{}",
        [REVIEWER_PKG_FILE]: "{}",
        [REVIEWER_DOCKERFILE]: reviewerDockerfile,
        [SHARED_PKG_FILE]: "{}",
      });

      const plans = planDockerfileWorkspaceCopyRegeneration(REPO_ROOT, fs);
      if (plans === null) throw new Error("expected non-null plans");
      const stale = plans.filter((p) => !("error" in p.result) && p.result.changed);
      expect(stale).toHaveLength(1);
      const first = stale[0];
      if (!first) throw new Error("expected at least one stale plan");
      expect(first.dockerfileRelPath).toBe(DF_REVIEWER_REL);
      if ("error" in first.result) throw new Error("expected non-error result");
      expect(first.result.text).toContain(`${WS_SITE}/package.json`);
    });

    test("both root and sub-project Dockerfiles pass when already fresh", () => {
      const reviewerDockerfileGood = dockerfileWithBlock([WS_SHARED, WS_SITE, WS_REVIEWER]);

      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
        [SITE_PKG_FILE]: "{}",
        [REVIEWER_PKG_FILE]: "{}",
        [REVIEWER_DOCKERFILE]: reviewerDockerfileGood,
        [SHARED_PKG_FILE]: "{}",
      });

      const plans = planDockerfileWorkspaceCopyRegeneration(REPO_ROOT, fs);
      if (plans === null) throw new Error("expected non-null plans");
      const stale = plans.filter((p) => !("error" in p.result) && p.result.changed);
      expect(stale).toEqual([]);
      expect(plans.map((p) => p.dockerfileRelPath).sort()).toEqual([DF_ROOT_REL, DF_REVIEWER_REL]);
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

      const plans = planDockerfileWorkspaceCopyRegeneration(REPO_ROOT, fs);
      if (plans === null) throw new Error("expected non-null plans");
      expect(plans.map((p) => p.dockerfileRelPath)).toEqual([DF_ROOT_REL]);
    });

    test("missing root package.json returns null (silent short-circuit)", () => {
      const fs = fakeFsWithContents({
        [ROOT_DOCKERFILE]: ROOT_DOCKERFILE_GOOD,
      });
      expect(planDockerfileWorkspaceCopyRegeneration(REPO_ROOT, fs)).toBeNull();
    });

    test("repo with no protected Dockerfiles returns empty array (silent pass)", () => {
      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [SHARED_PKG_FILE]: "{}",
      });
      expect(planDockerfileWorkspaceCopyRegeneration(REPO_ROOT, fs)).toEqual([]);
    });

    test("Dockerfile without generated-block markers surfaces an error, not a crash", () => {
      const noMarkersDockerfile = [
        FROM_BUN_BASE,
        COPY_ROOT_MANIFESTS,
        "COPY packages/shared/package.json ./packages/shared/package.json",
        FROZEN_INSTALL_LINE,
      ].join("\n");

      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [ROOT_DOCKERFILE]: noMarkersDockerfile,
        [SHARED_PKG_FILE]: "{}",
      });

      const plans = planDockerfileWorkspaceCopyRegeneration(REPO_ROOT, fs);
      if (plans === null) throw new Error("expected non-null plans");
      expect(plans).toHaveLength(1);
      const plan = plans[0];
      if (!plan) throw new Error("expected one plan");
      expect("error" in plan.result).toBe(true);
    });

    test("violations across multiple Dockerfiles are reported per-file", () => {
      const missingFromAny = dockerfileWithBlock([WS_SHARED, WS_REVIEWER]);

      const fs = fakeFsWithContents({
        [ROOT_PKG]: ROOT_PKG_JSON,
        [ROOT_DOCKERFILE]: missingFromAny,
        [SITE_PKG_FILE]: "{}",
        [REVIEWER_PKG_FILE]: "{}",
        [REVIEWER_DOCKERFILE]: missingFromAny,
        [SHARED_PKG_FILE]: "{}",
      });

      const plans = planDockerfileWorkspaceCopyRegeneration(REPO_ROOT, fs);
      if (plans === null) throw new Error("expected non-null plans");
      const stale = plans.filter((p) => !("error" in p.result) && p.result.changed);
      expect(stale).toHaveLength(2);
      expect(stale.map((p) => p.dockerfileRelPath).sort()).toEqual([DF_ROOT_REL, DF_REVIEWER_REL]);
      for (const p of stale) {
        if ("error" in p.result) throw new Error("expected non-error result");
        expect(p.result.text).toContain(`${WS_SITE}/package.json`);
      }
    });
  });
});
