/**
 * `runProjectDoctorChecks` (mt#5154): each check's pass / warning / error branch
 * through injected deps. The negative fixture is flowtato at 2026-09-14T20:44Z
 * — harness `cursor` under a Claude Code caller, `.cursor/rules` only,
 * `repository.backend: local`, neither App covering the repo, no hooks, a PAT
 * that cannot see the repo — the state the doctor reported 9/9 healthy.
 */
import { describe, test, expect } from "bun:test";
import * as path from "path";
import {
  PROJECT_CHECKS,
  runProjectDoctorChecks,
  type ProjectDoctorConfig,
  type ProjectDoctorDeps,
} from "./project-checks";
import {
  PROJECT_LOCAL_SETTINGS_FILENAME,
  buildBaselineRegistration,
  mergeHookRegistration,
} from "../setup/hook-provisioning";

const WS = "/ws/flotato";
const ORIGIN = "https://github.com/edobry/flotato.git";
const INSTALL_DIR = "/state/minsky/hooks";

const HEALTHY_CONFIG: ProjectDoctorConfig = {
  workspace: { harness: "claude-code", harnessSource: "flag" },
  repository: {
    backend: "github",
    url: ORIGIN,
    github: { owner: "edobry", repo: "flotato" },
  },
  project: { slug: "edobry/flotato" },
  github: {
    token: "ghp_test",
    serviceAccount: { installationId: 11 },
    reviewer: { serviceAccount: { installationId: 22 } },
  },
};

/** A settings file that registers the full baseline, as `setup` writes it. */
function provisionedSettings(): string {
  const merged = mergeHookRegistration({}, buildBaselineRegistration(INSTALL_DIR), INSTALL_DIR);
  return JSON.stringify(merged);
}

function healthyDeps(overrides: Partial<ProjectDoctorDeps> = {}): ProjectDoctorDeps {
  const files = new Set<string>([
    path.join(WS, ".claude", PROJECT_LOCAL_SETTINGS_FILENAME),
    path.join(WS, ".claude/rules"),
    path.join(WS, ".claude/skills"),
    path.join(INSTALL_DIR, "record-conversation-run-state.ts"),
    path.join(INSTALL_DIR, "transcript-ingest-on-session-end.ts"),
    path.join(INSTALL_DIR, "types.ts"),
  ]);
  return {
    resolveCallerHarness: () => "claude-code",
    readOriginUrl: () => ORIGIN,
    compileCheck: async () => ({
      targets: [
        { target: "claude-skills", stale: false },
        { target: "claude-rules", stale: false },
      ],
      gatedOut: [{ target: "cursor-rules-ts", kind: "harness" }],
    }),
    appCoverage: async (repo, roles) =>
      roles.map((r) => ({ ...r, status: { state: "covered" as const, repo } })),
    tokenRepoAccess: async (repo) => ({ state: "push" as const, repo }),
    hookInstallDir: INSTALL_DIR,
    pathExists: (p) => files.has(p),
    readTextFile: (p) =>
      p === path.join(WS, ".claude", PROJECT_LOCAL_SETTINGS_FILENAME) ? provisionedSettings() : "",
    ...overrides,
  };
}

function byCheck(diags: Array<{ check: string; status: string; message: string }>) {
  return Object.fromEntries(diags.map((d) => [d.check, d]));
}

describe("runProjectDoctorChecks — a correctly onboarded project", () => {
  test("every check passes, one row per configured App role", async () => {
    const diags = await runProjectDoctorChecks(
      { workspacePath: WS, config: HEALTHY_CONFIG },
      healthyDeps()
    );
    expect(diags.every((d) => d.scope === "project")).toBe(true);
    expect(diags.map((d) => d.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
    const names = diags.map((d) => d.check);
    expect(names).toEqual([
      PROJECT_CHECKS.harness,
      PROJECT_CHECKS.compiled,
      PROJECT_CHECKS.identity,
      `${PROJECT_CHECKS.coverage} (implementer)`,
      `${PROJECT_CHECKS.coverage} (reviewer)`,
      PROJECT_CHECKS.hooks,
      PROJECT_CHECKS.token,
    ]);
    expect(byCheck(diags)[PROJECT_CHECKS.compiled]?.message).toContain(
      "harness-gated: cursor-rules-ts"
    );
  });
});

describe("runProjectDoctorChecks — the 2026-09-14T20:44Z flowtato state", () => {
  const BROKEN: ProjectDoctorConfig = {
    workspace: { harness: "cursor", harnessSource: "installed" },
    repository: { backend: "local" },
    github: { token: "github_pat_x", serviceAccount: { installationId: 11 } },
  };
  const brokenDeps = (): ProjectDoctorDeps =>
    healthyDeps({
      compileCheck: async () => ({
        targets: [{ target: "cursor-rules-ts", stale: false }],
        gatedOut: [],
      }),
      appCoverage: async (repo, roles) =>
        roles.map((r) => ({
          ...r,
          status: { state: "not-covered" as const, repo, coveredCount: 3 },
          settingsUrl: "https://github.com/settings/installations/11",
        })),
      tokenRepoAccess: async (repo) => ({ state: "not-accessible" as const, repo, status: 404 }),
      // Only .cursor/rules exists; no .claude at all, hooks not installed.
      pathExists: (p) => p === path.join(WS, ".cursor/rules"),
    });

  test("at least four project-scope errors, each naming its remedy", async () => {
    const diags = await runProjectDoctorChecks({ workspacePath: WS, config: BROKEN }, brokenDeps());
    const errors = diags.filter((d) => d.status === "error");
    expect(errors.length).toBeGreaterThanOrEqual(4);
    const m = byCheck(diags);

    expect(m[PROJECT_CHECKS.harness]).toMatchObject({ status: "error" });
    expect(m[PROJECT_CHECKS.harness]?.message).toContain('"cursor"');
    expect(m[PROJECT_CHECKS.harness]?.message).toContain('"claude-code"');
    expect(m[PROJECT_CHECKS.harness]?.message).toContain("defaulted from the installed clients");

    // Under the RECORDED harness the outputs are in sync, but the caller's
    // harness has nothing to load — the "zero rules reachable" finding.
    expect(m[PROJECT_CHECKS.compiled]).toMatchObject({ status: "error" });
    expect(m[PROJECT_CHECKS.compiled]?.message).toContain("no compiled outputs here");

    expect(m[PROJECT_CHECKS.identity]).toMatchObject({ status: "error" });
    expect(m[PROJECT_CHECKS.identity]?.message).toContain('repository.backend is "local"');

    expect(m[`${PROJECT_CHECKS.coverage} (implementer)`]).toMatchObject({ status: "error" });
    expect(m[`${PROJECT_CHECKS.coverage} (implementer)`]?.message).toContain("does NOT cover");

    expect(m[PROJECT_CHECKS.token]).toMatchObject({ status: "error" });
    expect(m[PROJECT_CHECKS.token]?.message).toContain("HTTP 404");
    expect(m[PROJECT_CHECKS.token]?.message).toContain("Resource not accessible");
  });

  test("hooks: the baseline is checked only for claude-code; cursor passes with a note", async () => {
    const diags = await runProjectDoctorChecks({ workspacePath: WS, config: BROKEN }, brokenDeps());
    expect(byCheck(diags)[PROJECT_CHECKS.hooks]).toMatchObject({ status: "pass" });
    expect(byCheck(diags)[PROJECT_CHECKS.hooks]?.message).toContain('harness "cursor"');
  });
});

describe("runProjectDoctorChecks — individual branches", () => {
  test("harness: explicit (harnessSource: flag) mismatch is a warning, not an error", async () => {
    const diags = await runProjectDoctorChecks(
      {
        workspacePath: WS,
        config: { ...HEALTHY_CONFIG, workspace: { harness: "cursor", harnessSource: "flag" } },
      },
      healthyDeps({ compileCheck: async () => ({ targets: [], gatedOut: [] }) })
    );
    expect(byCheck(diags)[PROJECT_CHECKS.harness]).toMatchObject({ status: "warning" });
    expect(byCheck(diags)[PROJECT_CHECKS.harness]?.message).toContain("set explicitly");
  });

  test("harness: nothing recorded is a WARNING with a setup remedy (unset is normal pre-mt#5153; AT3)", async () => {
    const diags = await runProjectDoctorChecks(
      { workspacePath: WS, config: { ...HEALTHY_CONFIG, workspace: {} } },
      healthyDeps()
    );
    const h = byCheck(diags)[PROJECT_CHECKS.harness];
    expect(h).toMatchObject({ status: "warning" });
    expect((h as { suggestion?: string }).suggestion).toContain(
      "minsky setup --client claude-code"
    );
  });

  test("harness: an undeterminable caller is a warning, and hooks/compile still evaluate", async () => {
    const diags = await runProjectDoctorChecks(
      { workspacePath: WS, config: HEALTHY_CONFIG },
      healthyDeps({ resolveCallerHarness: () => "standalone" })
    );
    expect(byCheck(diags)[PROJECT_CHECKS.harness]).toMatchObject({ status: "warning" });
    expect(byCheck(diags)[PROJECT_CHECKS.compiled]).toMatchObject({ status: "pass" });
  });

  test("compiled: stale targets are an error naming them", async () => {
    const diags = await runProjectDoctorChecks(
      { workspacePath: WS, config: HEALTHY_CONFIG },
      healthyDeps({
        compileCheck: async () => ({
          targets: [
            { target: "claude-skills", stale: true },
            { target: "claude-rules", stale: false },
          ],
          gatedOut: [],
        }),
      })
    );
    const c = byCheck(diags)[PROJECT_CHECKS.compiled];
    expect(c).toMatchObject({ status: "error" });
    expect(c?.message).toContain("claude-skills");
    expect(c?.message).not.toContain("claude-rules.");
  });

  test("compiled: a compile failure is its own error, not a crash", async () => {
    const diags = await runProjectDoctorChecks(
      { workspacePath: WS, config: HEALTHY_CONFIG },
      healthyDeps({
        compileCheck: async () => {
          throw new Error("generator exploded");
        },
      })
    );
    expect(byCheck(diags)[PROJECT_CHECKS.compiled]?.message).toContain("generator exploded");
  });

  test("identity: no origin is a warning and downstream checks say so", async () => {
    const diags = await runProjectDoctorChecks(
      {
        workspacePath: WS,
        config: { ...HEALTHY_CONFIG, project: {}, repository: { backend: "local" } },
      },
      healthyDeps({ readOriginUrl: () => null })
    );
    const m = byCheck(diags);
    expect(m[PROJECT_CHECKS.identity]).toMatchObject({ status: "warning" });
    expect(m[PROJECT_CHECKS.coverage]).toMatchObject({ status: "warning" });
    expect(m[PROJECT_CHECKS.token]).toMatchObject({ status: "warning" });
  });

  test("coverage: unknown is a warning, no-app-configured is a warning", async () => {
    for (const state of ["unknown", "no-app-configured"] as const) {
      const diags = await runProjectDoctorChecks(
        { workspacePath: WS, config: HEALTHY_CONFIG },
        healthyDeps({
          appCoverage: async (_repo, roles) =>
            roles.map((r) => ({
              ...r,
              status: state === "unknown" ? { state, reason: "timeout" } : { state },
            })),
        })
      );
      expect(byCheck(diags)[`${PROJECT_CHECKS.coverage} (implementer)`]).toMatchObject({
        status: "warning",
      });
    }
  });

  test("hooks: a missing registration names the events; missing install files are named", async () => {
    const diags = await runProjectDoctorChecks(
      { workspacePath: WS, config: HEALTHY_CONFIG },
      healthyDeps({
        readTextFile: () => JSON.stringify({ hooks: { PreToolUse: [] } }),
        pathExists: (p) => p === path.join(WS, ".claude", PROJECT_LOCAL_SETTINGS_FILENAME),
      })
    );
    const h = byCheck(diags)[PROJECT_CHECKS.hooks];
    expect(h).toMatchObject({ status: "error" });
    expect(h?.message).toContain("registration(s) missing");
    expect(h?.message).toContain(
      "not installed at /state/minsky/hooks: record-conversation-run-state.ts"
    );
  });

  test("hooks: an unparseable settings file is an error naming the file", async () => {
    const diags = await runProjectDoctorChecks(
      { workspacePath: WS, config: HEALTHY_CONFIG },
      healthyDeps({ readTextFile: () => "{not json" })
    );
    expect(byCheck(diags)[PROJECT_CHECKS.hooks]?.message).toContain("could not be parsed");
  });

  test("token: read-only is an error; no token is a warning; unknown is a warning", async () => {
    const ro = await runProjectDoctorChecks(
      { workspacePath: WS, config: HEALTHY_CONFIG },
      healthyDeps({ tokenRepoAccess: async (repo) => ({ state: "read-only", repo }) })
    );
    expect(byCheck(ro)[PROJECT_CHECKS.token]).toMatchObject({ status: "error" });

    const none = await runProjectDoctorChecks(
      {
        workspacePath: WS,
        config: { ...HEALTHY_CONFIG, github: { ...HEALTHY_CONFIG.github, token: "" } },
      },
      healthyDeps()
    );
    expect(byCheck(none)[PROJECT_CHECKS.token]).toMatchObject({ status: "warning" });

    const unknown = await runProjectDoctorChecks(
      { workspacePath: WS, config: HEALTHY_CONFIG },
      healthyDeps({
        tokenRepoAccess: async (repo) => ({ state: "unknown", repo, reason: "ENOTFOUND" }),
      })
    );
    expect(byCheck(unknown)[PROJECT_CHECKS.token]?.message).toContain("ENOTFOUND");
  });

  test("never throws: a throwing origin reader degrades to the no-origin warning", async () => {
    const diags = await runProjectDoctorChecks(
      { workspacePath: WS, config: HEALTHY_CONFIG },
      healthyDeps({
        readOriginUrl: () => {
          throw new Error("git not found");
        },
      })
    );
    expect(byCheck(diags)[PROJECT_CHECKS.identity]).toMatchObject({ status: "warning" });
  });
});
