/**
 * `minsky setup db` shared command (mt#2429).
 *
 * Interactive onboarding wizard that captures a Postgres connection string,
 * writes it to user config, runs migrations, and verifies connectivity. The
 * interactive prompting (branch selection, string capture, plan confirmation)
 * lives here; the validate → write → migrate → verify orchestration lives in
 * the domain (`@minsky/domain/setup-db`) so it is testable without prompts.
 *
 * Per the mt#2395 design (§Decision), the wizard does NOT supervise a Docker
 * container — it prints a copy-paste one-liner and captures the resulting
 * connection string. Three branches: Docker-local / Supabase free-tier / BYO.
 */

import { spawnSync } from "child_process";
import { z } from "zod";
import { select, text, confirm, isCancel, cancel } from "@clack/prompts";
import { getErrorMessage, ValidationError } from "@minsky/domain/errors/index";
import { log } from "@minsky/shared/logger";
import {
  runSetupDbConfigure,
  validatePostgresConnectionString,
  maskConnectionString,
  buildDockerPostgresOneLiner,
  dockerLocalConnectionString,
} from "@minsky/domain/setup-db";
import {
  sharedCommandRegistry,
  CommandCategory,
  defineCommand,
  type CommandParameterMap,
} from "../command-registry";
import { isInteractive } from "../../../utils/interactive";

const setupDbParams = {
  connectionString: {
    schema: z.string().optional(),
    description:
      "Postgres connection string (postgres://user:pass@host:5432/db). " + // gitleaks:allow — placeholder, not a real credential
      "Required in non-interactive mode; otherwise captured via the wizard.",
    required: false,
  },
  yes: {
    schema: z.boolean().optional(),
    description: "Skip the confirmation prompt before writing config",
    required: false,
  },
} satisfies CommandParameterMap;

/**
 * Detect whether the `docker` CLI is available on PATH. Best-effort and
 * synchronous — a missing binary (ENOENT) or any spawn error means "absent".
 */
function detectDocker(): boolean {
  try {
    const result = spawnSync("docker", ["--version"], {
      stdio: "ignore",
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Interactively capture a connection string via one of the three branches.
 * Returns null if the user cancels.
 */
async function promptForConnectionString(): Promise<string | null> {
  const dockerPresent = detectDocker();

  type Branch = "docker" | "supabase" | "byo";
  const options: Array<{ value: Branch; label: string; hint?: string }> = [];
  if (dockerPresent) {
    options.push({
      value: "docker",
      label: "Run Postgres locally with Docker",
      hint: "prints a copy-paste one-liner",
    });
  }
  options.push({
    value: "supabase",
    label: "Use Supabase free tier",
    hint: "hosted, no credit card",
  });
  options.push({ value: "byo", label: "I already have a Postgres connection string" });

  const branch = await select<Branch>({
    message: dockerPresent
      ? "How do you want to provide a Postgres database?"
      : "Docker was not detected. How do you want to provide a Postgres database?",
    options,
    initialValue: options[0]?.value,
  });
  if (isCancel(branch)) return null;

  if (branch === "docker") {
    const password = await text({
      message: "Choose a password for the local Postgres container:",
      placeholder: "minsky",
      defaultValue: "minsky",
    });
    if (isCancel(password)) return null;
    const pw = (password as string) || "minsky";

    log.cli("");
    log.cli("Run this to start a local Postgres (Minsky does NOT manage this container):");
    log.cli("");
    log.cli(`  ${buildDockerPostgresOneLiner(pw)}`);
    log.cli("");
    log.cli("Once it is running, confirm or edit the connection string below.");
    log.cli("");

    const cs = await text({
      message: "Postgres connection string:",
      defaultValue: dockerLocalConnectionString(pw),
      placeholder: dockerLocalConnectionString(pw),
    });
    if (isCancel(cs)) return null;
    return ((cs as string) || dockerLocalConnectionString(pw)).trim();
  }

  if (branch === "supabase") {
    log.cli("");
    log.cli("Create a free Supabase project (no credit card):");
    log.cli("  1. Sign up at https://supabase.com/dashboard");
    log.cli("  2. Create a project, then open Project Settings → Database");
    log.cli("  3. Copy the connection string (URI). Use the session/transaction pooler URI.");
    log.cli("");

    const cs = await text({
      message: "Paste your Supabase Postgres connection string:",
      placeholder: "postgresql://postgres:[password]@db.[ref].supabase.co:5432/postgres", // gitleaks:allow — placeholder, not a real credential
    });
    if (isCancel(cs)) return null;
    return (cs as string).trim();
  }

  // byo
  const cs = await text({
    message: "Paste your Postgres connection string:",
    placeholder: "postgresql://user:password@host:5432/dbname", // gitleaks:allow — placeholder, not a real credential
  });
  if (isCancel(cs)) return null;
  return (cs as string).trim();
}

export function registerSetupDbCommand(): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "setup.db",
      category: CommandCategory.INIT,
      name: "setup db",
      description:
        "Configure Postgres persistence: capture a connection string, write config, " +
        "run migrations, and verify connectivity (Docker / Supabase / bring-your-own)",
      parameters: setupDbParams,
      requiresSetup: false,
      execute: async (params, _ctx) => {
        try {
          let connectionString = params.connectionString?.trim();

          // Capture a connection string if not supplied.
          if (!connectionString) {
            if (!isInteractive()) {
              // eslint-disable-next-line custom/no-validation-error-in-execute
              throw new ValidationError(
                "Non-interactive mode: pass --connection-string <postgres-url>."
              );
            }
            const captured = await promptForConnectionString();
            if (captured === null) {
              cancel("Setup cancelled.");
              return { success: false, message: "Setup cancelled by user." };
            }
            connectionString = captured;
          }

          // Early format validation for a clean message before any DB work.
          const validation = validatePostgresConnectionString(connectionString);
          if (!validation.ok) {
            return {
              success: false,
              message: `Invalid Postgres connection string: ${validation.error}`,
            };
          }

          // Plan (Operational Safety: dry-run/preview before the mutating write).
          const masked = maskConnectionString(connectionString);
          log.cli("");
          log.cli("Plan:");
          log.cli(`  1. Write persistence.backend=postgres and the connection string to config`);
          log.cli(`     Connection: ${masked}`);
          log.cli(`  2. Run pending schema migrations against it`);
          log.cli(`  3. Verify connectivity and that the schema is up to date`);
          log.cli("");

          if (isInteractive() && !params.yes) {
            const proceed = await confirm({
              message: "Write this configuration and run migrations?",
              initialValue: true,
            });
            if (isCancel(proceed) || !proceed) {
              cancel("Setup cancelled.");
              return { success: false, message: "Setup cancelled by user." };
            }
          }

          const result = await runSetupDbConfigure(connectionString);

          if (result.success) {
            log.cli("");
            log.cli(`✅ ${result.message}`);
          } else {
            log.cli("");
            log.cli(`❌ ${result.message}`);
          }

          return {
            success: result.success,
            message: result.message,
            configPath: result.configPath,
            appliedCount: result.appliedCount,
            pendingCount: result.pendingCount,
            failedStep: result.failedStep,
          };
        } catch (error: unknown) {
          throw error instanceof ValidationError
            ? error
            : new ValidationError(getErrorMessage(error));
        }
      },
    })
  );
}
