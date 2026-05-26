/**
 * `minsky completions` top-level CLI command factories (mt#1892).
 *
 * Two factories are exported because the tabtab convention requires the
 * shell-invoked handler to be a top-level subcommand named `completion-server`
 * (hard-coded in tabtab's generated shell scripts):
 *
 *   minsky completions install     # user-facing: prompts for shell, adds source line
 *   minsky completions uninstall   # user-facing: removes the source line
 *   minsky completions bash        # user-facing: emit raw bash script to stdout
 *   minsky completions zsh         # user-facing
 *   minsky completions fish        # user-facing
 *   minsky completion-server       # HIDDEN top-level — invoked by the shell on TAB
 *
 * Container init is skipped for the completion-server path via
 * `isCompletionInvocation` in `src/cli-discriminators.ts`.
 */
import { Command } from "commander";
import { getErrorMessage } from "@minsky/domain/errors/index";

/**
 * The user-facing `completions` command (install/uninstall/emit verbs).
 */
export function createCompletionsCommand(): Command {
  const cmd = new Command("completions").description("Manage shell completions for minsky");

  cmd
    .command("install")
    .description("Install shell completions (prompts for bash/zsh/fish)")
    .action(async () => {
      try {
        const { installCompletion } = await import("./install");
        await installCompletion();
      } catch (error) {
        console.error(`Error: ${getErrorMessage(error)}`);
        process.exit(1);
      }
    });

  cmd
    .command("uninstall")
    .description("Uninstall shell completions")
    .action(async () => {
      try {
        const { uninstallCompletion } = await import("./uninstall");
        await uninstallCompletion();
      } catch (error) {
        console.error(`Error: ${getErrorMessage(error)}`);
        process.exit(1);
      }
    });

  for (const shell of ["bash", "zsh", "fish"] as const) {
    cmd
      .command(shell)
      .description(`Emit the ${shell} completion script to stdout`)
      .action(async () => {
        try {
          const { emitCompletionScript } = await import("./emit");
          await emitCompletionScript(shell);
        } catch (error) {
          console.error(`Error: ${getErrorMessage(error)}`);
          process.exit(1);
        }
      });
  }

  return cmd;
}

/**
 * The hidden `completion-server` top-level command — invoked by the user's
 * shell on TAB. Top-level (not under `completions`) because tabtab's generated
 * shell scripts hard-code the invocation as `<completer> completion-server`.
 */
export function createCompletionServerCommand(): Command {
  return new Command("completion-server")
    .description("(internal) shell completion handler invoked on TAB")
    .helpOption(false)
    .allowUnknownOption(true)
    .action(async () => {
      try {
        const { serveCompletions } = await import("./serve");
        await serveCompletions();
      } catch (error) {
        // Silent failure: emit no candidates rather than disrupting the user's
        // shell. The shell's completion mechanism interprets stderr as
        // user-visible output, so we log the error but exit 0.

        console.error(`completion handler error: ${getErrorMessage(error)}`);
        process.exit(0);
      }
    });
}
