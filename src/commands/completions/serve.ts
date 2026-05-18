/**
 * `minsky completions complete` — hidden handler invoked by the shell on TAB.
 *
 * Reads COMP_* env vars via tabtab.parseEnv, looks up candidates in the
 * build-time-generated manifest (NOT the live commander tree — see mt#1892
 * §D1 for the latency rationale), and emits the candidate list via
 * tabtab.log.
 *
 * The handler must NOT touch the DI container, the DB, or any I/O beyond
 * reading the bundled manifest. The MINSKY_SKIP_CLI_AUTORUN-style
 * `isCompletionInvocation` carve-out in src/cli.ts ensures the preAction
 * hook skips container init for this code path.
 */
import tabtab from "@pnpm/tabtab";
import manifestJson from "../../generated/completion-manifest.json" with { type: "json" };
import { lookupCompletions, type ManifestCommand } from "./manifest-lookup";

// The build-time manifest has the ManifestCommand shape plus a `_generated`
// marker for the generated-file-edit guard hook. TypeScript's JSON-import
// inference gives literal types; widen to ManifestCommand via an intermediate
// interface so the extra field is accounted for without a double cast.
interface WrappedManifest extends ManifestCommand {
  _generated?: string;
}
const manifest: ManifestCommand = manifestJson as WrappedManifest;

export async function serveCompletions(): Promise<void> {
  const env = tabtab.parseEnv(process.env);

  // tabtab sets `complete: false` when COMP_* vars are absent — e.g., user
  // ran `minsky completion-server` directly from a shell rather than
  // through TAB. Emit nothing in that case.
  if (!env.complete) return;

  const candidates = lookupCompletions({ partial: env.partial }, manifest);

  // tabtab.log needs the shell to format candidates (zsh wants `name:desc`,
  // fish wants `name\tdesc`, etc.). Derive from process.env.SHELL via
  // tabtab's helper — falls back to bash-shaped output if unknown.
  let shell: "bash" | "zsh" | "fish" | "pwsh" | "nushell" = "bash";
  try {
    shell = tabtab.getShellFromEnv(process.env);
  } catch {
    // SHELL unset or unsupported value — keep the bash default.
  }
  tabtab.log(candidates, shell);
}
