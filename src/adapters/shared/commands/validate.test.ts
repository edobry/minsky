/**
 * Tests for validate command helpers.
 *
 * Covers `discoverTypecheckWorkspaces` — the workspace-discovery logic that makes
 * `validate.typecheck` cover sub-workspaces with their own `typecheck` script
 * (mt#2256). The discovery logic is exercised against an INJECTED in-memory filesystem
 * (no real fs) so the unit test is deterministic and race-free; the real-fs path is
 * covered end-to-end by `scripts/smoke-validate-typecheck-workspaces.ts`.
 */

import { describe, test, expect } from "bun:test";
import { discoverTypecheckWorkspaces, type WorkspaceFs } from "./validate";

const ROOT = "/repo";

/**
 * Build an injectable {@link WorkspaceFs} over an in-memory tree.
 *
 * @param files Map of absolute path → file contents. Directory listings are derived from
 *              the set of file paths, so no explicit directory entries are needed.
 */
function memFs(files: Record<string, string>): WorkspaceFs {
  const paths = Object.keys(files);
  return {
    readFile: async (path) => {
      if (path in files) {
        return files[path] as string;
      }
      throw new Error(`ENOENT: ${path}`);
    },
    readdir: async (dir) => {
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      const children = new Set<string>();
      for (const p of paths) {
        if (p.startsWith(prefix)) {
          const rest = p.slice(prefix.length);
          const segment = rest.split("/")[0];
          if (segment) {
            children.add(segment);
          }
        }
      }
      if (children.size === 0) {
        throw new Error(`ENOENT: ${dir}`);
      }
      return [...children];
    },
    exists: async (path) => paths.some((p) => p === path),
  };
}

function rootPkg(workspaces: unknown): string {
  return JSON.stringify({ name: "root", workspaces });
}

function wsPkg(name: string, typecheck?: string): string {
  return JSON.stringify({ name, scripts: typecheck ? { typecheck } : {} });
}

const TSC = "tsc --noEmit";
const TSCONFIG = JSON.stringify({ compilerOptions: { noEmit: true } });
const REVIEWER = "services/reviewer";

describe("discoverTypecheckWorkspaces", () => {
  test("includes only workspaces with their own typecheck script AND a tsconfig", async () => {
    const fs = memFs({
      [`${ROOT}/package.json`]: rootPkg(["packages/*", "services/*"]),
      // Has typecheck script + tsconfig → included
      [`${ROOT}/services/reviewer/package.json`]: wsPkg("reviewer", TSC),
      [`${ROOT}/services/reviewer/tsconfig.json`]: TSCONFIG,
      // Has tsconfig but no typecheck script → excluded
      [`${ROOT}/services/cockpit/package.json`]: wsPkg("cockpit"),
      [`${ROOT}/services/cockpit/tsconfig.json`]: TSCONFIG,
      [`${ROOT}/packages/domain/package.json`]: wsPkg("domain"),
      [`${ROOT}/packages/domain/tsconfig.json`]: TSCONFIG,
      // Has typecheck script but no tsconfig → excluded
      [`${ROOT}/packages/shared/package.json`]: wsPkg("shared", TSC),
    });

    expect(await discoverTypecheckWorkspaces(ROOT, fs)).toEqual([REVIEWER]);
  });

  test("returns sorted results across multiple matching workspaces", async () => {
    const fs = memFs({
      [`${ROOT}/package.json`]: rootPkg(["services/*"]),
      [`${ROOT}/services/zeta/package.json`]: wsPkg("zeta", TSC),
      [`${ROOT}/services/zeta/tsconfig.json`]: TSCONFIG,
      [`${ROOT}/services/alpha/package.json`]: wsPkg("alpha", TSC),
      [`${ROOT}/services/alpha/tsconfig.json`]: TSCONFIG,
    });

    expect(await discoverTypecheckWorkspaces(ROOT, fs)).toEqual([
      "services/alpha",
      "services/zeta",
    ]);
  });

  test("supports the object form of `workspaces` ({ packages: [...] })", async () => {
    const fs = memFs({
      [`${ROOT}/package.json`]: rootPkg({ packages: ["services/*"] }),
      [`${ROOT}/services/reviewer/package.json`]: wsPkg("reviewer", TSC),
      [`${ROOT}/services/reviewer/tsconfig.json`]: TSCONFIG,
    });

    expect(await discoverTypecheckWorkspaces(ROOT, fs)).toEqual([REVIEWER]);
  });

  test("supports literal (non-glob) workspace paths", async () => {
    const fs = memFs({
      [`${ROOT}/package.json`]: rootPkg(["services/reviewer"]),
      [`${ROOT}/services/reviewer/package.json`]: wsPkg("reviewer", TSC),
      [`${ROOT}/services/reviewer/tsconfig.json`]: TSCONFIG,
    });

    expect(await discoverTypecheckWorkspaces(ROOT, fs)).toEqual([REVIEWER]);
  });

  test("conservatively skips unsupported glob patterns (** and embedded globs)", async () => {
    const fs = memFs({
      [`${ROOT}/package.json`]: rootPkg(["packages/**", "svc-*/inner"]),
      [`${ROOT}/packages/domain/package.json`]: wsPkg("domain", TSC),
      [`${ROOT}/packages/domain/tsconfig.json`]: TSCONFIG,
    });

    expect(await discoverTypecheckWorkspaces(ROOT, fs)).toEqual([]);
  });

  test("skips heavy/irrelevant dirs (node_modules, dist, dot-dirs) when enumerating a glob", async () => {
    const fs = memFs({
      [`${ROOT}/package.json`]: rootPkg(["services/*"]),
      // Legit workspace
      [`${ROOT}/services/reviewer/package.json`]: wsPkg("reviewer", TSC),
      [`${ROOT}/services/reviewer/tsconfig.json`]: TSCONFIG,
      // Heavy / irrelevant siblings that happen to match the glob — must be skipped before probing
      [`${ROOT}/services/node_modules/some-pkg/package.json`]: wsPkg("some-pkg", TSC),
      [`${ROOT}/services/node_modules/some-pkg/tsconfig.json`]: TSCONFIG,
      [`${ROOT}/services/.cache/package.json`]: wsPkg("cache", TSC),
      [`${ROOT}/services/.cache/tsconfig.json`]: TSCONFIG,
      [`${ROOT}/services/dist/package.json`]: wsPkg("dist", TSC),
      [`${ROOT}/services/dist/tsconfig.json`]: TSCONFIG,
    });

    expect(await discoverTypecheckWorkspaces(ROOT, fs)).toEqual([REVIEWER]);
  });

  test("fail-open: missing root package.json yields empty list", async () => {
    const fs = memFs({});
    expect(await discoverTypecheckWorkspaces(ROOT, fs)).toEqual([]);
  });

  test("fail-open: a workspace with unreadable package.json is skipped, others discovered", async () => {
    const fs = memFs({
      [`${ROOT}/package.json`]: rootPkg(["services/*"]),
      [`${ROOT}/services/good/package.json`]: wsPkg("good", TSC),
      [`${ROOT}/services/good/tsconfig.json`]: TSCONFIG,
      // Broken package.json (invalid JSON) but has a tsconfig
      [`${ROOT}/services/bad/package.json`]: "{ not valid json",
      [`${ROOT}/services/bad/tsconfig.json`]: TSCONFIG,
    });

    expect(await discoverTypecheckWorkspaces(ROOT, fs)).toEqual(["services/good"]);
  });
});
