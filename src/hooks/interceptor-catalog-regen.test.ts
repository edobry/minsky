/**
 * Tests for the interceptor-catalog pre-commit regen step (mt#4010).
 *
 * Mirrors `completion-manifest-regen.test.ts` — same shape, same reasoning:
 * the pure helpers are exported so the orchestration can be exercised without
 * a real git repo or a real generator run, and the injected deps let the
 * regen path be driven end to end with fakes.
 */
import { describe, test, expect } from "bun:test";
import {
  catalogDiffIndicatesChange,
  classifyInterceptorCatalogRegenError,
  regenerateInterceptorCatalog,
  INTERCEPTOR_CATALOG_PATH,
  type InterceptorCatalogRegenDeps,
} from "./interceptor-catalog-regen";

function deps(overrides: Partial<InterceptorCatalogRegenDeps> = {}): {
  deps: InterceptorCatalogRegenDeps;
  gitCalls: string[][];
  logs: string[];
} {
  const gitCalls: string[][] = [];
  const logs: string[] = [];
  return {
    gitCalls,
    logs,
    deps: {
      projectRoot: "/repo",
      runGit: async (args) => {
        gitCalls.push(args);
        return "";
      },
      logLine: (line) => logs.push(line),
      exec: async () => undefined,
      ...overrides,
    },
  };
}

describe("catalogDiffIndicatesChange", () => {
  test("empty stdout means no change", () => {
    expect(catalogDiffIndicatesChange("")).toBe(false);
  });

  test("whitespace-only stdout means no change", () => {
    expect(catalogDiffIndicatesChange("\n")).toBe(false);
    expect(catalogDiffIndicatesChange("   \n  ")).toBe(false);
  });

  test("a named path means the artifact changed", () => {
    expect(catalogDiffIndicatesChange(`${INTERCEPTOR_CATALOG_PATH}\n`)).toBe(true);
  });
});

describe("classifyInterceptorCatalogRegenError", () => {
  test("prefers stderr detail", () => {
    const result = classifyInterceptorCatalogRegenError({ stderr: "boom on line 3", stdout: "" });
    expect(result.message).toContain("boom on line 3");
    expect(result.logLines[0]).toContain("Interceptor-catalog regeneration failed");
  });

  test("falls through to stdout when stderr is EMPTY", () => {
    // The `||` vs `??` distinction: `??` would treat "" as present and never
    // reach stdout, losing the only detail the operator has.
    const result = classifyInterceptorCatalogRegenError({ stderr: "", stdout: "detail here" });
    expect(result.message).toContain("detail here");
  });

  test("falls back to the Error message when neither stream carries detail", () => {
    const result = classifyInterceptorCatalogRegenError(new Error("spawn ENOENT"));
    expect(result.message).toContain("spawn ENOENT");
  });

  test("says the failure is a generator bug, not staleness", () => {
    const result = classifyInterceptorCatalogRegenError(new Error("boom"));
    expect(result.logLines.join("\n")).toContain("not staleness");
  });
});

describe("regenerateInterceptorCatalog", () => {
  test("runs the package script, and stages nothing when the artifact is unchanged", async () => {
    const commands: string[] = [];
    const { deps: d, gitCalls } = deps({
      exec: async (command) => {
        commands.push(command);
        return undefined;
      },
    });

    const result = await regenerateInterceptorCatalog(d);

    expect(result.success).toBe(true);
    expect(commands).toEqual(["bun run build:interceptor-catalog"]);
    // Only the diff ran — no `git add` on the unchanged path.
    expect(gitCalls).toEqual([["diff", "--name-only", "--", INTERCEPTOR_CATALOG_PATH]]);
  });

  test("stages the artifact when regeneration changed it", async () => {
    const gitCalls: string[][] = [];
    const { deps: d, logs } = deps({
      runGit: async (args) => {
        gitCalls.push(args);
        return args[0] === "diff" ? `${INTERCEPTOR_CATALOG_PATH}\n` : "";
      },
    });

    const result = await regenerateInterceptorCatalog(d);

    expect(result.success).toBe(true);
    expect(gitCalls.at(-1)).toEqual(["add", "--", INTERCEPTOR_CATALOG_PATH]);
    expect(logs.join("\n")).toContain("regenerated and staged");
  });

  test("fails the commit when the generator throws", async () => {
    const { deps: d, gitCalls } = deps({
      exec: async () => {
        throw new Error("generator exploded");
      },
    });

    const result = await regenerateInterceptorCatalog(d);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("generator exploded");
    // Never reaches git — a broken generator must not stage a stale artifact.
    expect(gitCalls).toEqual([]);
  });

  test("fails CLOSED when the diff itself errors", async () => {
    // A git-plumbing failure must not be read as "nothing changed" — that
    // would silently skip staging a file that did change.
    const { deps: d } = deps({
      runGit: async () => {
        throw new Error("not a git repository");
      },
    });

    const result = await regenerateInterceptorCatalog(d);

    expect(result.success).toBe(false);
    expect(result.message).toContain("Could not diff");
  });
});
