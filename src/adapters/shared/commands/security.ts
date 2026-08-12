/**
 * Shared Security Commands (mt#4022)
 *
 * The callable entry point for "does this text contain an UNMASKED
 * credential?" — the reach half of mt#4022. The detection logic itself
 * lives in `packages/domain/src/security/credential-shape-check.ts`
 * (reusing `CREDENTIAL_SHAPES` from the transcript-ingest scrubber by
 * construction); this file is the thin, dual-surface (CLI + MCP) wrapper
 * an agent can actually call from where the question gets asked.
 *
 * ## CLI contract (the primitive an agent pipes into)
 *
 *   <command> | minsky security check-credentials [--quiet]
 *   minsky security check-credentials --file <path> [--quiet]
 *
 * Exit codes are the mechanism by which "checked, clean" is distinguishable
 * from "did not run" (mt#4022 criterion 3 — the mem#808 failure was
 * indistinguishable from success):
 *
 *   0  — checked; no unmasked credential shape found.
 *   1  — checked; at least one unmasked credential shape found.
 *   2  — did NOT complete the check (input unreadable, or an internal
 *        failure) — never a silent pass, and never conflated with 0 or 1.
 *
 * `--quiet` suppresses all of this command's own stdout/stderr text (on
 * every one of the three paths above) so a caller can rely on the exit code
 * alone, mirroring `grep -q`.
 *
 * ## Why this calls `process.exit()` itself, and only on the CLI interface
 *
 * The shared CLI bridge's error handler (`src/adapters/cli/utils/error-handler.ts`)
 * always exits 1 on a thrown error, and the CLI's own `main()` always ends
 * with an unconditional `exit(0)` on a command that returns normally — so
 * neither `throw` nor `process.exitCode` can produce the three DISTINCT exit
 * codes this command's contract requires (0 clean / 1 hit / 2 error) through
 * the standard command-execute-then-return path. This command therefore
 * exits directly, but ONLY when `context.interface === "cli"` — an MCP tool
 * call must never terminate the (long-lived) MCP server process, so the MCP
 * surface instead returns a normal structured result and lets the calling
 * agent read `hasUnmaskedCredential` programmatically. `process.exit()`
 * after a synchronous `process.stdout.write()` is safe here because the
 * CLI's `preAction` hook already installed synchronous stdout for one-shot
 * commands (mt#3067) — nothing buffered is lost.
 *
 * ## Never prints matched text, on any path
 *
 * `checkForUnmaskedCredentials` returns shape NAMES only (e.g.
 * `"postgres-url-credentials"`), never the matched substring — see that
 * module's doc comment. This command's own messages, on every path
 * including the error path, are built from fixed strings and shape names
 * only; no caught error's `.message` is ever echoed verbatim (a caught
 * error could in principle embed input content). Exercised end-to-end by
 * `security.check-credentials.cli.test.ts`, which spawns the real CLI and
 * asserts the injected secret text never appears in stdout+stderr on the
 * hit path OR the error path.
 *
 * @see mt#4022 — this file
 * @see ../../../packages/domain/src/security/credential-shape-check.ts — the detection logic
 * @see .minsky/rules/terminal-command-best-practices.mdc §Secret handling — the rule
 *   this command is now cited from (criterion 5)
 */

import { z } from "zod";
import { sharedCommandRegistry, CommandCategory, defineCommand } from "../command-registry";
import { readTextFile } from "@minsky/shared/fs";
import { checkForUnmaskedCredentials } from "@minsky/domain/security/credential-shape-check";

/** Exit codes for `security.check-credentials` — exported for tests. */
export const EXIT_CLEAN = 0;
export const EXIT_HIT = 1;
export const EXIT_ERROR = 2;

/** The outcome of one credential-shape check run. Never carries matched text. */
export type CredentialCheckOutcome =
  | { status: "clean" }
  | { status: "hit"; matchedShapes: string[] }
  | { status: "error"; reason: string };

/** Maps an outcome to this command's exit-code contract (criterion 3). */
export function exitCodeForOutcome(outcome: CredentialCheckOutcome): number {
  switch (outcome.status) {
    case "clean":
      return EXIT_CLEAN;
    case "hit":
      return EXIT_HIT;
    case "error":
      return EXIT_ERROR;
  }
}

/**
 * Run the check against `text` and translate the result into an outcome.
 * Never throws — `checkForUnmaskedCredentials` is a pure regex scan over an
 * ordinary string and cannot fail on one, but this is defensive: an
 * unexpected throw here becomes `{status: "error"}` rather than an
 * unhandled rejection, keeping "did not complete" always distinguishable
 * from "completed, clean" (criterion 3).
 */
export function classifyCredentialCheck(text: string): CredentialCheckOutcome {
  try {
    const result = checkForUnmaskedCredentials(text);
    return result.hasUnmaskedCredential
      ? { status: "hit", matchedShapes: result.matchedShapes }
      : { status: "clean" };
  } catch {
    return { status: "error", reason: "internal check failure" };
  }
}

/**
 * Resolve the text to check, in priority order: `--file <path>` (read via
 * `readTextFile`, throws if unreadable — this is the AT4 "simulate an
 * internal failure" path), then `text` (programmatic/MCP callers), then
 * stdin (the CLI pipe contract). Throws on a TTY with no other input source
 * (nothing to check) and on a stdin read error.
 */
export async function resolveInputText(opts: { file?: string; text?: string }): Promise<string> {
  if (opts.file) {
    return await readTextFile(opts.file);
  }
  if (typeof opts.text === "string") {
    return opts.text;
  }
  return await readStdinText();
}

function readStdinText(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      reject(
        new Error(
          "no input source: pass --file <path>, or pipe input via stdin " +
            "(e.g. `<command> | minsky security check-credentials`)"
        )
      );
      return;
    }
    let content = "";
    (process.stdin as NodeJS.ReadStream & { setEncoding(encoding: string): void }).setEncoding(
      "utf8"
    );
    process.stdin.on("data", (chunk: string) => {
      content += chunk;
    });
    process.stdin.on("end", () => resolve(content));
    process.stdin.on("error", (err: Error) => reject(err));
  });
}

/**
 * Compute the outcome for a command invocation: resolve input, then
 * classify. The ONLY place an input-resolution failure (unreadable file, no
 * stdin source) becomes `{status: "error"}` — never a silent pass, per
 * criterion 3 / AT4.
 */
export async function computeCredentialCheckOutcome(opts: {
  file?: string;
  text?: string;
}): Promise<CredentialCheckOutcome> {
  let text: string;
  try {
    text = await resolveInputText(opts);
  } catch {
    // The underlying error's message is deliberately NOT surfaced — see the
    // module doc's "Never prints matched text, on any path". A file-read
    // error's message is normally just a path, but this command's contract
    // is to never echo caught-error text on any path, without exception.
    return { status: "error", reason: "input could not be read" };
  }
  return classifyCredentialCheck(text);
}

const checkCredentialsParams = {
  file: {
    schema: z.string(),
    description: "Read the text to check from this file path instead of stdin",
    required: false,
  },
  text: {
    schema: z.string(),
    description: "The text to check, passed directly (programmatic/MCP callers)",
    required: false,
    // Never exposed as a CLI flag: a --text value would land in argv, and
    // argv is visible via `ps` — the same reason the deploy script never
    // passes secret values on the command line. CLI callers use --file or
    // stdin instead.
    cliHidden: true,
  },
  quiet: {
    schema: z.boolean(),
    description:
      "Suppress this command's own stdout/stderr text on every path (clean, hit, or error); " +
      "rely on the exit code alone",
    required: false,
    defaultValue: false,
  },
};

export function registerSecurityCommands(): void {
  sharedCommandRegistry.registerCommand(
    defineCommand({
      id: "security.check-credentials",
      category: CommandCategory.SECURITY,
      name: "check-credentials",
      description:
        "Check text (stdin, --file, or --text) for unmasked credential shapes. " +
        "Exit 0 = clean, 1 = hit, 2 = did not complete.",
      requiresSetup: false,
      parameters: checkCredentialsParams,
      execute: async (params, context) => {
        const quiet = params.quiet ?? false;
        const outcome = await computeCredentialCheckOutcome({
          file: params.file,
          text: params.text,
        });

        if (context.interface === "cli") {
          if (!quiet) {
            writeCliOutcome(outcome);
          }
          // Only the CLI surface exits the process directly — see the
          // module doc's "Why this calls process.exit() itself". This never
          // runs for an MCP tool call.
          process.exit(exitCodeForOutcome(outcome));
        }

        // MCP / non-CLI surface: no exit codes, just a structured result —
        // shape names only, never matched text.
        if (outcome.status === "hit") {
          return {
            success: true,
            checked: true,
            hasUnmaskedCredential: true,
            matchedShapeCount: outcome.matchedShapes.length,
            matchedShapes: outcome.matchedShapes,
          };
        }
        if (outcome.status === "clean") {
          return {
            success: true,
            checked: true,
            hasUnmaskedCredential: false,
          };
        }
        return {
          success: false,
          checked: false,
          error:
            "Credential check did not complete (input could not be read, or an internal failure).",
        };
      },
    })
  );
}

/** Writes this command's own (fixed-string / shape-name-only) CLI output. */
function writeCliOutcome(outcome: CredentialCheckOutcome): void {
  if (outcome.status === "clean") {
    process.stdout.write("OK: no unmasked credential shapes detected.\n");
    return;
  }
  if (outcome.status === "hit") {
    process.stdout.write(
      `CREDENTIAL DETECTED: ${outcome.matchedShapes.length} shape(s) matched: ` +
        `${outcome.matchedShapes.join(", ")}\n`
    );
    return;
  }
  process.stderr.write(`security.check-credentials: did not complete (${outcome.reason}).\n`);
}
