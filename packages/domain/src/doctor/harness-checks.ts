/**
 * The harness-facing project checks (mt#5154): recorded harness vs caller,
 * compiled outputs for that harness, and the observability hook baseline.
 * Pure over their injected deps; see `project-checks.ts` for the defaults.
 */

import * as path from "path";
import { getErrorMessage } from "../errors/index";
import type { AgentHarness } from "../runtime/harness-detection";
import {
  BASELINE_INSTALL_FILES,
  PROJECT_LOCAL_SETTINGS_FILENAME,
  buildBaselineRegistration,
  findMissingBaselineRegistration,
} from "../setup/hook-provisioning";
import {
  PROJECT_CHECKS,
  type CompileCheckSummary,
  type Deps,
  type ProjectDoctorDiagnostic,
  type ProjectDoctorInput,
} from "./types";

/** Where a harness's compiled rule outputs live, relative to the workspace. */
const HARNESS_OUTPUT_DIRS: Record<string, string[]> = {
  "claude-code": [".claude/rules", ".claude/skills"],
  cursor: [".cursor/rules"],
};

export function harnessCheck(
  input: ProjectDoctorInput,
  deps: Deps
): { diagnostic: ProjectDoctorDiagnostic; callerHarness: AgentHarness | undefined } {
  const recorded = input.config.workspace?.harness;
  const source = input.config.workspace?.harnessSource;
  let callerHarness: AgentHarness | undefined;
  try {
    callerHarness = deps.resolveCallerHarness(input.callerAgentId);
  } catch {
    callerHarness = undefined;
  }
  const check = PROJECT_CHECKS.harness;

  if (!recorded) {
    // A WARNING, not an error: an unset `workspace.harness` is the normal state
    // for any project onboarded before mt#5153 added the field — including the
    // Minsky repo itself (mt#5154 AT3). An error here would fail the doctor for
    // every such project. A recorded harness that DISAGREES with the caller is
    // the real fault, and that stays an error below.
    return {
      callerHarness,
      diagnostic: {
        check,
        status: "warning",
        scope: "project",
        message: "No harness is recorded for this project (`workspace.harness` is unset).",
        suggestion: `Run \`minsky setup --client ${callerHarness && callerHarness !== "standalone" ? callerHarness : "<claude-code|cursor>"}\` in the project to record it.`,
      },
    };
  }
  if (!callerHarness || callerHarness === "standalone") {
    return {
      callerHarness,
      diagnostic: {
        check,
        status: "warning",
        scope: "project",
        message: `Recorded harness is "${recorded}"; the caller's harness could not be determined, so it was not compared.`,
      },
    };
  }
  if (callerHarness === recorded) {
    return {
      callerHarness,
      diagnostic: {
        check,
        status: "pass",
        scope: "project",
        message: `Recorded harness "${recorded}" matches the caller's${source ? ` (source: ${source})` : ""}.`,
      },
    };
  }
  const explicit = source === "flag";
  return {
    callerHarness,
    diagnostic: {
      check,
      status: explicit ? "warning" : "error",
      scope: "project",
      message: `Recorded harness is "${recorded}" but this call runs under "${callerHarness}"${
        explicit
          ? " — it was set explicitly (`harnessSource: flag`), so this may be intended."
          : source
            ? ` — it was ${source === "installed" ? "defaulted from the installed clients" : `derived from ${source}`}, not chosen.`
            : " — and no `harnessSource` is recorded (written before mt#5153)."
      }`,
      suggestion: `Run \`minsky setup --client ${callerHarness}\` in the project if ${callerHarness} is the harness you use here.`,
    },
  };
}

export async function compiledCheck(
  input: ProjectDoctorInput,
  deps: Deps,
  callerHarness: AgentHarness | undefined,
  harnessMismatch: boolean
): Promise<ProjectDoctorDiagnostic> {
  const check = PROJECT_CHECKS.compiled;
  const recorded = input.config.workspace?.harness ?? "(none)";
  let summary: CompileCheckSummary;
  try {
    summary = await deps.compileCheck(input.workspacePath);
  } catch (error) {
    return {
      check,
      status: "error",
      scope: "project",
      message: `\`minsky compile --check\` failed: ${getErrorMessage(error)}`,
      suggestion: "Fix the compile error, then run `minsky compile`.",
    };
  }
  const stale = summary.targets.filter((t) => t.stale).map((t) => t.target);
  const callerOutputsNote = (): string => {
    if (!harnessMismatch || !callerHarness) return "";
    const dirs = HARNESS_OUTPUT_DIRS[callerHarness] ?? [];
    const present = dirs.filter((d) => deps.pathExists(path.join(input.workspacePath, d)));
    return present.length === 0 && dirs.length > 0
      ? ` The caller's harness "${callerHarness}" has no compiled outputs here (${dirs.join(", ")} absent) — nothing it loads is reachable.`
      : "";
  };
  if (stale.length > 0) {
    return {
      check,
      status: "error",
      scope: "project",
      message: `Compiled outputs for harness "${recorded}" are stale or missing: ${stale.join(", ")}.${callerOutputsNote()}`,
      suggestion: "Run `minsky compile` in the project.",
    };
  }
  const gated = summary.gatedOut.filter((g) => g.kind === "harness").map((g) => g.target);
  return {
    check,
    status: harnessMismatch && callerOutputsNote() ? "error" : "pass",
    scope: "project",
    message: `Compiled outputs for harness "${recorded}" are in sync (${
      summary.targets.map((t) => t.target).join(", ") || "no targets"
    }${gated.length > 0 ? `; harness-gated: ${gated.join(", ")}` : ""}).${callerOutputsNote()}`,
    ...(harnessMismatch && callerOutputsNote()
      ? { suggestion: `Run \`minsky setup --client ${callerHarness}\` then \`minsky compile\`.` }
      : {}),
  };
}

export function hooksCheck(
  input: ProjectDoctorInput,
  deps: Deps,
  harness: string | undefined
): ProjectDoctorDiagnostic {
  const check = PROJECT_CHECKS.hooks;
  if (harness !== "claude-code") {
    return {
      check,
      status: "pass",
      scope: "project",
      message: `No hook baseline is provisioned for harness "${harness ?? "(none)"}"; nothing to check.`,
    };
  }
  const registration = buildBaselineRegistration(deps.hookInstallDir);
  const candidates = [
    path.join(input.workspacePath, ".claude", PROJECT_LOCAL_SETTINGS_FILENAME),
    path.join(input.workspacePath, ".claude", "settings.json"),
  ];
  const settingsPath = candidates.find((p) => deps.pathExists(p));
  let hooks: unknown = undefined;
  if (settingsPath) {
    try {
      hooks = (JSON.parse(deps.readTextFile(settingsPath)) as { hooks?: unknown }).hooks;
    } catch (error) {
      return {
        check,
        status: "error",
        scope: "project",
        message: `${settingsPath} could not be parsed: ${getErrorMessage(error)}`,
      };
    }
  }
  const missingRegistration = findMissingBaselineRegistration(hooks, registration);
  const missingFiles = BASELINE_INSTALL_FILES.filter(
    (f) => !deps.pathExists(path.join(deps.hookInstallDir, f))
  );
  if (missingRegistration.length === 0 && missingFiles.length === 0) {
    return {
      check,
      status: "pass",
      scope: "project",
      message: `Observability baseline is registered in ${settingsPath ?? "the project settings"} and installed at ${deps.hookInstallDir}.`,
    };
  }
  const parts: string[] = [];
  if (!settingsPath)
    parts.push("no `.claude/settings.local.json` or `.claude/settings.json` in the project");
  else if (missingRegistration.length > 0) {
    const events = [...new Set(missingRegistration.map((m) => m.event))];
    parts.push(
      `${missingRegistration.length} baseline registration(s) missing from ${settingsPath} (events: ${events.join(", ")})`
    );
  }
  if (missingFiles.length > 0) {
    parts.push(`not installed at ${deps.hookInstallDir}: ${missingFiles.join(", ")}`);
  }
  return {
    check,
    status: "error",
    scope: "project",
    message: `Observability hooks are incomplete: ${parts.join("; ")}.`,
    suggestion: "Run `minsky setup --client claude-code` in the project to provision them.",
  };
}
