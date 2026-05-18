/**
 * `minsky completion-server` — hidden top-level handler invoked by the shell
 * on TAB. (Named `completion-server` because that's tabtab's hard-coded
 * convention for the completer subcommand in its generated shell scripts.)
 *
 * Reads COMP_* env vars via tabtab.parseEnv, looks up candidates in the
 * build-time-generated manifest (NOT the live commander tree — see mt#1892
 * §D1 for the latency rationale), and emits the candidate list via
 * tabtab.log.
 *
 * The handler must NOT touch the DI container, the DB, or any I/O beyond
 * reading the bundled manifest. The `isCompletionInvocation` carve-out in
 * src/cli.ts ensures the preAction hook skips container init for this code
 * path.
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
  // fish wants `name\tdesc`, bash/pwsh want plain names). Resolve from
  // process.env.SHELL via tabtab.getShellFromEnv; fall back to bash when
  // SHELL is unset or set to an unsupported value. The fallback can misformat
  // fish output, but logging to stderr would surface in the user's shell
  // prompt — intentionally silent. (tabtab.log's `shell` parameter accepts
  // only bash/zsh/fish/pwsh per its types.)
  let shell: "bash" | "zsh" | "fish" | "pwsh" = "bash";
  try {
    shell = tabtab.getShellFromEnv(process.env);
  } catch {
    // SHELL unset or unsupported — keep the bash default.
  }
  tabtab.log(candidates, shell);
}
