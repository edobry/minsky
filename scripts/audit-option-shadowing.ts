#!/usr/bin/env bun
/**
 * Enumerate every subcommand that declares a long-option name one of its
 * ANCESTORS also declares (mt#4076).
 *
 * Commander binds a flag to the command that DECLARES it — the outermost one —
 * so a subcommand whose name collides with an ancestor's receives `undefined`
 * from its own `opts()` even though the operator passed the flag and the
 * subcommand's `--help` advertises it. Nothing errors. That silence is the
 * whole problem: `setup db --connection-string <url>` replied "pass
 * --connection-string" for four days on the documented quick-start path
 * (mt#3830) before anyone traced it.
 *
 * Reads `src/generated/completion-manifest.json` rather than grepping source.
 * The manifest is built from the live commander tree by
 * `scripts/build-completion-manifest.ts`, so it reflects what commander
 * actually assembled — including options a grep over `.option(` would miss or
 * mis-attribute — and it is regenerated at build time, so it cannot drift
 * silently from the code the way a hand-maintained list would.
 *
 * A collision is NOT automatically a defect: it is a defect only when the
 * subcommand's action reads its own `options` instead of the merged view. The
 * fix is `mergedSetupOpts` (`src/commands/setup/index.ts`), which wraps
 * commander's documented `optsWithGlobals()`. This script reports the shape;
 * `src/commands/setup/index.test.ts` pins which instances are known and handled.
 *
 * Usage:
 *   bun scripts/audit-option-shadowing.ts            # human-readable
 *   bun scripts/audit-option-shadowing.ts --json     # machine-readable
 */

import path from "path";

export interface ManifestNode {
  name?: string;
  options?: Array<{ flags?: string[] }>;
  subcommands?: ManifestNode[];
}

export interface ShadowedOption {
  /** Space-joined command path, e.g. "minsky setup db". */
  command: string;
  /** The colliding long flag, e.g. "--connection-string". */
  flag: string;
  /** The nearest ancestor that also declares it. */
  declaredBy: string;
}

/**
 * Long flags only.
 *
 * A short flag lives in a different namespace and collides on different rules;
 * including them here would report pairs commander does not actually conflate,
 * which is the failure mode that makes an audit script get ignored.
 */
function longFlags(node: ManifestNode): string[] {
  const names: string[] = [];
  for (const option of node.options ?? []) {
    for (const flag of option.flags ?? []) {
      if (flag.startsWith("--")) names.push(flag);
    }
  }
  return names;
}

export function findShadowedOptions(root: ManifestNode): ShadowedOption[] {
  const hits: ShadowedOption[] = [];

  const walk = (node: ManifestNode, ancestry: string[], declared: Map<string, string>): void => {
    const here = [...ancestry, node.name ?? "?"];
    const command = here.join(" ");
    const mine = longFlags(node);

    for (const flag of mine) {
      const owner = declared.get(flag);
      if (owner !== undefined) hits.push({ command, flag, declaredBy: owner });
    }

    // Children inherit this node's declarations. First declarer wins, so the
    // reported owner is the OUTERMOST one — which is the command commander
    // actually binds the flag to, and therefore the one worth naming.
    const next = new Map(declared);
    for (const flag of mine) if (!next.has(flag)) next.set(flag, command);

    for (const child of node.subcommands ?? []) walk(child, here, next);
  };

  walk(root, [], new Map());
  return hits;
}

async function main(): Promise<void> {
  const manifestPath = path.join(
    import.meta.dir,
    "..",
    "src",
    "generated",
    "completion-manifest.json"
  );

  const file = Bun.file(manifestPath);
  if (!(await file.exists())) {
    console.error(
      `Completion manifest not found at ${manifestPath}.\n` +
        "Run `bun run build:completion-manifest` first."
    );
    process.exit(2);
  }

  const manifest = (await file.json()) as ManifestNode;
  const hits = findShadowedOptions(manifest);

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(hits, null, 2));
    return;
  }

  if (hits.length === 0) {
    console.log("No parent/child long-option collisions found.");
    return;
  }

  console.log(`${hits.length} parent/child option collision(s):\n`);
  for (const hit of hits) {
    console.log(`  ${hit.command}`);
    console.log(`    ${hit.flag}  (also declared by: ${hit.declaredBy})`);
  }
  console.log(
    "\nEach is a defect UNLESS the subcommand's action reads the merged view " +
      "(`mergedSetupOpts` / commander's `optsWithGlobals()`)."
  );
}

if (import.meta.main) {
  await main();
}
