/**
 * `config doctor`'s PROJECT-scope checks (mt#5154).
 *
 * Every check the doctor had was user-scope — config loads, validation, the
 * reviewer token, the App's own permission set, model ids, the config dir,
 * embeddings, index coverage — so a project with the wrong harness recorded,
 * no compiled rules its harness could read, `repository.backend: local` beside
 * a GitHub origin, and neither App installation covering it reported 9/9
 * `healthy: true` (flowtato, 2026-09-14T20:44Z; peezombie.me still does).
 *
 * Six checks, each a read, each answering for the project named by the
 * caller's `workspace` (the doctor's provider is per-workspace since mt#5155):
 *
 *   (a) harness   — recorded `workspace.harness` vs the CALLER's harness
 *   (b) compiled  — `minsky compile --check` for the recorded harness
 *   (c) identity  — recorded repository identity vs `git remote get-url origin`
 *   (d) coverage  — every configured GitHub App role covers the repo (setup's check)
 *   (e) hooks     — the observability baseline is registered and installed
 *   (f) token     — the user token reaches the repo with push rights
 *
 * Dependencies are injected so each branch is unit-testable with no network
 * and no real filesystem; the defaults are the production collaborators.
 * Nothing here writes — the doctor diagnoses, `setup` remedies.
 */

import { existsSync, readFileSync } from "fs";
import { resolveAgentHarness } from "../runtime/harness-detection";
import { deriveRemoteUrl } from "../project/slug";
import {
  checkAppRoleCoverage,
  type AppRoleCoverage,
  type AppRoleDescriptor,
} from "../setup/app-coverage";
import { resolveHookInstallDir } from "../setup/hook-provisioning";
import { checkTokenRepoAccess } from "../setup/token-repo-access";
import { compiledCheck, harnessCheck, hooksCheck } from "./harness-checks";
import { coverageCheck, identityCheck, tokenCheck } from "./repository-checks";
import type {
  CompileCheckSummary,
  Deps,
  ProjectDoctorDeps,
  ProjectDoctorDiagnostic,
  ProjectDoctorInput,
} from "./types";

export type {
  CompileCheckSummary,
  ProjectDoctorConfig,
  ProjectDoctorDeps,
  ProjectDoctorDiagnostic,
  ProjectDoctorInput,
} from "./types";
export { PROJECT_CHECKS } from "./types";

// ---------------------------------------------------------------------------
// Defaults (the production collaborators)
// ---------------------------------------------------------------------------

async function defaultCompileCheck(workspacePath: string): Promise<CompileCheckSummary> {
  const { runMinskyCompile, probeMinskyCompileTargetsWithGateReport } = await import(
    "../compile/compile"
  );
  const fsp = await import("fs/promises");
  const result = await runMinskyCompile({ workspacePath, check: true });
  // The same cast `runMinskyCompile` makes for its own default fs.
  const { gatedOut } = await probeMinskyCompileTargetsWithGateReport(
    workspacePath,
    fsp as import("../compile/types").MinskyCompileFsDeps
  );
  const targets = (result.targets ?? [{ target: result.target, stale: result.stale }]).map((t) => ({
    target: t.target,
    stale: t.stale === true,
  }));
  return { targets, gatedOut: gatedOut.map((g) => ({ target: g.target, kind: g.kind })) };
}

async function defaultAppCoverage(
  ownerRepo: string,
  roles: readonly AppRoleDescriptor[]
): Promise<AppRoleCoverage[]> {
  const { getConfiguration } = await import("../configuration/index");
  const { createTokenProvider } = await import("../auth/index");
  const { GitHubAppTokenProvider } = await import("../auth/github-app-token-provider");
  const cfg = getConfiguration();
  const provider = createTokenProvider(cfg.github ?? {}, cfg.github?.token ?? "");
  const appProvider = provider instanceof GitHubAppTokenProvider ? provider : null;
  return checkAppRoleCoverage(ownerRepo, roles, { provider: appProvider });
}

function withDefaults(deps: ProjectDoctorDeps): Deps {
  return {
    resolveCallerHarness:
      deps.resolveCallerHarness ?? ((callerAgentId) => resolveAgentHarness({ callerAgentId })),
    readOriginUrl: deps.readOriginUrl ?? ((workspacePath) => deriveRemoteUrl(workspacePath)),
    compileCheck: deps.compileCheck ?? defaultCompileCheck,
    appCoverage: deps.appCoverage ?? defaultAppCoverage,
    tokenRepoAccess:
      deps.tokenRepoAccess ?? ((ownerRepo, token) => checkTokenRepoAccess(ownerRepo, token)),
    hookInstallDir: deps.hookInstallDir ?? resolveHookInstallDir(),
    pathExists: deps.pathExists ?? existsSync,
    readTextFile: deps.readTextFile ?? ((p) => String(readFileSync(p, { encoding: "utf-8" }))),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run every project-scope check for `input.workspacePath`. Never throws: a
 * check that fails to RUN is reported as an `error` diagnostic of its own.
 */
export async function runProjectDoctorChecks(
  input: ProjectDoctorInput,
  deps: ProjectDoctorDeps = {}
): Promise<ProjectDoctorDiagnostic[]> {
  const full = withDefaults(deps);
  const diagnostics: ProjectDoctorDiagnostic[] = [];

  const harness = harnessCheck(input, full);
  diagnostics.push(harness.diagnostic);
  const recordedHarness = input.config.workspace?.harness;
  const mismatch =
    harness.diagnostic.status !== "pass" &&
    !!recordedHarness &&
    !!harness.callerHarness &&
    harness.callerHarness !== "standalone" &&
    harness.callerHarness !== recordedHarness;

  diagnostics.push(await compiledCheck(input, full, harness.callerHarness, mismatch));

  const identity = identityCheck(input, full);
  diagnostics.push(identity.diagnostic);

  diagnostics.push(...(await coverageCheck(input, full, identity.ownerRepo)));
  diagnostics.push(hooksCheck(input, full, recordedHarness));
  diagnostics.push(await tokenCheck(input, full, identity.ownerRepo));

  return diagnostics;
}
