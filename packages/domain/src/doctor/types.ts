/**
 * Types shared by `config doctor`'s project-scope checks (mt#5154). See
 * `project-checks.ts` for what the checks are and why they exist.
 */

import type { AgentHarness } from "../runtime/harness-detection";
import type { RecordedRepositoryIdentity } from "../project/repository-drift";
import type { AppRoleCoverage, AppRoleDescriptor } from "../setup/app-coverage";
import type { TokenRepoAccess } from "../setup/token-repo-access";

export interface ProjectDoctorDiagnostic {
  check: string;
  status: "pass" | "warning" | "error";
  message: string;
  suggestion?: string;
  scope: "project";
}

/** The slice of the merged project configuration the checks read. */
export interface ProjectDoctorConfig {
  workspace?: { harness?: string; harnessSource?: string };
  repository?: RecordedRepositoryIdentity;
  project?: { slug?: string };
  github?: {
    token?: string;
    serviceAccount?: { installationId?: number };
    reviewer?: { serviceAccount?: { installationId?: number } };
  };
}

export interface ProjectDoctorInput {
  workspacePath: string;
  config: ProjectDoctorConfig;
  /** The ADR-006 agent id the daemon injected for an MCP call; absent on the CLI. */
  callerAgentId?: string | null;
}

/** What `minsky compile --check` reports, reduced to what the doctor renders. */
export interface CompileCheckSummary {
  /** Targets the recorded harness needs, each with whether its output is stale or missing. */
  targets: Array<{ target: string; stale: boolean }>;
  /** Targets the harness gate skipped — not failures. */
  gatedOut: Array<{ target: string; kind: string }>;
}

export interface ProjectDoctorDeps {
  resolveCallerHarness?: (callerAgentId?: string | null) => AgentHarness;
  readOriginUrl?: (workspacePath: string) => string | null;
  compileCheck?: (workspacePath: string) => Promise<CompileCheckSummary>;
  appCoverage?: (
    ownerRepo: string,
    roles: readonly AppRoleDescriptor[]
  ) => Promise<AppRoleCoverage[]>;
  tokenRepoAccess?: (ownerRepo: string, token: string) => Promise<TokenRepoAccess>;
  hookInstallDir?: string;
  pathExists?: (p: string) => boolean;
  readTextFile?: (p: string) => string;
}

export type Deps = Required<ProjectDoctorDeps>;

export const PROJECT_CHECKS = {
  harness: "Project Harness",
  compiled: "Compiled Outputs",
  identity: "Repository Identity",
  coverage: "GitHub App Coverage",
  hooks: "Observability Hooks",
  token: "Token Repository Access",
} as const;
