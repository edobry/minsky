/**
 * `minsky completions install` handler.
 *
 * Delegates to @pnpm/tabtab's installer, which prompts the user to pick a
 * shell (bash/zsh/fish) and adds a single source line to the appropriate
 * shell rc file. The completer name "minsky" matches the actual CLI binary
 * so the shell invokes `minsky completions complete` (the hidden handler)
 * on TAB.
 */
import tabtab from "@pnpm/tabtab";

export async function installCompletion(): Promise<void> {
  await tabtab.install({ name: "minsky", completer: "minsky" });
}
