/**
 * Pure manifest-lookup function for shell completions (mt#1892 / mt#1893).
 *
 * Given a parsed tabtab env (the text before the cursor) and the
 * static completion manifest, return the list of candidate strings
 * the shell should offer.
 *
 * Three completion modes (in priority order):
 *   1. **Value completion** (mt#1893): if the preceding token is a flag that
 *      takes an argument AND the flag declares a finite `values` list in the
 *      manifest, suggest matching values. `minsky init --backend <TAB>` →
 *      `["github", "minsky"]`.
 *   2. **Flag completion** (mt#1892): if the partial word starts with `-`,
 *      suggest matching flag names from the current command node.
 *   3. **Subcommand completion** (mt#1892): otherwise, suggest matching
 *      subcommand names from the current command node.
 *
 * No I/O, no globals — pure function for testability.
 */

export interface ManifestOption {
  /** All flag forms for this option, e.g. ["-b", "--backend"]. */
  flags: string[];
  description?: string;
  /**
   * Whether the option consumes the next argument as its value
   * (`--backend <type>` vs boolean `--overwrite`). Derived from
   * Commander's `Option.required || Option.optional` at build time.
   * Defaults to `false` when absent (boolean-flag assumption).
   */
  takesValue?: boolean;
  /**
   * Finite set of valid values for this option's argument, extracted from
   * the shared command registry's Zod schema at build time. mt#1893.
   * Absent for free-form arguments (`z.string()`, `z.number()`, etc.).
   */
  values?: string[];
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
 * Walks the path tokens with a small state machine so that flag+value pairs
 * (`--backend github`) don't confuse the subcommand-descent logic. At the
 * resolved node, dispatches to one of: value completion, flag completion,
 * or subcommand completion.
 */
export function lookupCompletions(env: CompletionEnv, manifest: ManifestCommand): string[] {
  const parts = env.partial.split(" ");
  const pathTokens = parts.slice(0, -1);
  const partialWord = parts[parts.length - 1] ?? "";

  // First path token must be the manifest root's name (e.g., "minsky").
  if (pathTokens.length === 0 || pathTokens[0] !== manifest.name) {
    return [];
  }

  // Walk the path. Track:
  //   - `node`: the current command node in the manifest
  //   - `expectingValue`: whether the next token is the value for a flag we just saw
  //   - `flagBeforePartial`: the flag token immediately before partialWord, if any
  //     (used by value completion below)
  let node: ManifestCommand = manifest;
  let expectingValue = false;
  let flagOptionBeforePartial: ManifestOption | undefined;

  for (let i = 1; i < pathTokens.length; i++) {
    const token = pathTokens[i];

    if (expectingValue) {
      // Skip this token; it's the value for the preceding flag.
      expectingValue = false;
      continue;
    }

    if (token && token.startsWith("-")) {
      // Look up the flag in the current node's options.
      const matchedOption = node.options?.find((o) => o.flags.includes(token));
      // If this is the flag immediately before the cursor, remember it for
      // value-completion. (Last position in pathTokens means "right before
      // the partial word".)
      if (i === pathTokens.length - 1) {
        flagOptionBeforePartial = matchedOption;
      }
      // If the flag is known and takes a value, expect the next token to be
      // the value (skip it on the next iteration). If unknown, we can't tell
      // — assume boolean (don't skip). This is the safer default; the worst
      // case is a missed completion, not a wrong one.
      if (matchedOption?.takesValue) {
        expectingValue = true;
      }
      continue;
    }

    // Subcommand descent.
    const next = node.subcommands?.find((s) => s.name === token);
    if (!next) return [];
    node = next;
  }

  // Mode 1: value completion (highest priority — fires when we're after a
  // flag that takes values).
  if (flagOptionBeforePartial?.values && !partialWord.startsWith("-")) {
    return flagOptionBeforePartial.values.filter((v) => v.startsWith(partialWord));
  }

  // Mode 2: flag completion.
  if (partialWord.startsWith("-")) {
    // mt#1893 PR #1161 R1-B2: when partialWord exactly matches a known
    // value-bearing flag, the user has finished typing the flag name and
    // hit TAB expecting values — not a partial-flag-name expansion. Most
    // shells treat "exact match for what's already typed" as no-op, leading
    // to confused UX. Detect this case and emit values instead.
    if (node.options) {
      for (const opt of node.options) {
        if (opt.takesValue && opt.values && opt.flags.includes(partialWord)) {
          return [...opt.values];
        }
      }
    }
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

  // Mode 3: subcommand completion.
  const out: string[] = [];
  if (node.subcommands) {
    for (const sub of node.subcommands) {
      if (sub.name.startsWith(partialWord)) out.push(sub.name);
    }
  }
  return out;
}
