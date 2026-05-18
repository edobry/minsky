/**
 * `minsky completions uninstall` handler.
 *
 * Removes the source line that `completions install` added to the user's
 * shell rc. If a shell wasn't explicitly provided, tabtab removes from all
 * supported shells.
 */
import tabtab from "@pnpm/tabtab";

export async function uninstallCompletion(): Promise<void> {
  await tabtab.uninstall({ name: "minsky" });
}
