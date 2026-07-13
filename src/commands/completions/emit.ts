/**
 * `minsky completions <shell>` handlers.
 *
 * Emit the raw completion script for the requested shell to stdout. Users
 * who want manual install (vs the prompt-driven `completions install`)
 * redirect this output into the appropriate shell config:
 *
 *   minsky completions bash >> ~/.bashrc
 *   minsky completions zsh  >> ~/.zshrc
 *   minsky completions fish >> ~/.config/fish/config.fish
 */
import tabtab from "@pnpm/tabtab";

type SupportedShell = "bash" | "zsh" | "fish";

export async function emitCompletionScript(shell: SupportedShell): Promise<void> {
  const script = await tabtab.getCompletionScript({
    name: "minsky",
    completer: "minsky",
    shell,
  });

  console.log(script);
}
