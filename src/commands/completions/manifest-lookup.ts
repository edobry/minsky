/**
 * Pure manifest-lookup function for shell completions (mt#1892).
 *
 * Given a parsed tabtab env (the text before the cursor) and the
 * static completion manifest, return the list of candidate strings
 * the shell should offer.
 *
 * No I/O, no globals — pure function for testability.
 */

export interface ManifestOption {
  /** All flag forms for this option, e.g. ["-b", "--backend"]. */
  flags: string[];
  description?: string;
}

export interface ManifestCommand {
  name: string;
  description?: string;
  subcommands?: ManifestCommand[];
  options?: ManifestOption[];
}

/**
 * Subset of tabtab's parseEnv result that lookupCompletions needs.
 * Only `partial` is required — it's the text on the command line BEFORE
 * the cursor position, e.g. `"minsky tasks li"` when the cursor is after
 * the `i` in `li`.
 */
export interface CompletionEnv {
  partial: string;
}

/**
 * Compute completion candidates from the manifest given the partial input.
 *
 * Algorithm:
 *   1. Split `env.partial` on space. Last token is the partial word being
 *      completed; the leading tokens are the path words.
 *   2. Walk the manifest along the path words (descending into subcommands).
 *      The first path word must match the manifest root's name.
 *   3. At the resolved node:
 *      - if the partial word starts with `-`, emit option flags matching the
 *        partial prefix;
 *      - otherwise emit subcommand names matching the partial prefix.
 *   4. Unknown path words → no candidates (silent miss; safe for shells).
 */
export function lookupCompletions(env: CompletionEnv, manifest: ManifestCommand): string[] {
  const parts = env.partial.split(" ");
  const pathWords = parts.slice(0, -1);
  const partialWord = parts[parts.length - 1] ?? "";

  // The first path word must match the manifest root. If the user's shell
  // somehow invoked the completion handler with a different CLI name, bail.
  if (pathWords.length === 0 || pathWords[0] !== manifest.name) {
    return [];
  }

  // Descend through subcommands.
  let node: ManifestCommand = manifest;
  for (let i = 1; i < pathWords.length; i++) {
    const childName = pathWords[i];
    const next = node.subcommands?.find((s) => s.name === childName);
    if (!next) return [];
    node = next;
  }

  // Emit candidates.
  if (partialWord.startsWith("-")) {
    // Flag completion.
    const out: string[] = [];
    if (node.options) {
      for (const opt of node.options) {
        for (const flag of opt.flags) {
          if (flag.startsWith(partialWord)) out.push(flag);
        }
      }
    }
    return out;
  }

  // Subcommand completion.
  const out: string[] = [];
  if (node.subcommands) {
    for (const sub of node.subcommands) {
      if (sub.name.startsWith(partialWord)) out.push(sub.name);
    }
  }
  return out;
}
