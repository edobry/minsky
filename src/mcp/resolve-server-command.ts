/**
 * Resolve the command that starts a Minsky MCP server, from the CURRENT process
 * rather than from `$PATH` (mt#4475).
 *
 * ## The defect this replaces
 *
 * Four call sites spawned the server as the bare name `"minsky"`, resolved
 * through `$PATH`. That works on a machine with a global install and nowhere
 * else — most consequentially in CI, where `mcp call`'s own round-trip test
 * failed with `Executable not found in $PATH: "minsky"` and took `main` red on
 * both the `build` and `test-forced-tz` jobs. The assumption shipped on
 * 2026-04-01 and went unexercised for five months because every machine that
 * ran these paths happened to have the install.
 *
 * ## Why derive from the process instead of resolving the name
 *
 * The obvious alternative — look `minsky` up on `$PATH`, fall back to bun —
 * re-introduces the ambiguity it is meant to remove. A STALE global install
 * would still win over the source tree that is actually executing, so
 * `bun run src/cli.ts mcp call …` could silently start a server built from
 * different code. That is the same bug in a form that is harder to notice,
 * because it fails as wrong behaviour rather than as a missing file.
 *
 * A process already knows how it was started. Re-invoking that is the only
 * answer that cannot disagree with itself.
 *
 * ## Why the two-element form is the live path
 *
 * Measured rather than assumed (mt#4475 planning): `which minsky` on a
 * developer machine is a SYMLINK to a TypeScript file —
 * `~/.bun/install/global/node_modules/minsky/scripts/cli-entry.ts`, carrying a
 * `#!/usr/bin/env bun` shebang. There is no compiled `minsky` binary. So
 * `process.argv[0]` is bun and {@link Bun.main} is the entry script under EVERY
 * invocation shape this repo produces:
 *
 * | Invoked as | `argv[0]` | `Bun.main` |
 * | --- | --- | --- |
 * | `minsky mcp call …` | `…/.bun/bin/bun` | `…/scripts/cli-entry.ts` |
 * | `bun run src/cli.ts mcp call …` | `…/.bun/bin/bun` | `…/src/cli.ts` |
 * | `bun run dist/minsky.js mcp start` | `…/.bun/bin/bun` | `…/dist/minsky.js` |
 *
 * `bun run build` emits `dist/minsky.js`, a bundle run under bun — not a
 * self-contained executable. The single-element branch below is therefore
 * DEFENSIVE cover for a `bun build --compile` artifact this repo does not
 * currently produce, not a live path. It is kept because the cost is one
 * comparison and its absence would be a silent breakage if that ever changes.
 *
 * ## `process.argv[0]`, not `process.execPath`
 *
 * This project's ambient `process` type is narrowed and does not declare
 * `execPath` (mem#772). Using it is a compile error —
 * `TS2339: Property 'execPath' does not exist on type '{ arch: string; argv:
 * string[]; … }'` — verified with a throwaway probe rather than taken from the
 * memory on faith. `argv[0]` carries the same value.
 */

/**
 * The argv prefix that re-invokes this same Minsky build.
 *
 * Returns the executable followed by its entry script, or just the executable
 * when the two are the same (a compiled single-file binary). Append the
 * subcommand — e.g. `[...resolveMinskyCommand(), "mcp", "start"]`.
 *
 * Never returns an empty array: if `argv[0]` is somehow absent, it falls back to
 * the bare `"minsky"` name. That fallback restores the OLD behaviour for a case
 * that should not occur, which is deliberate — a spawn that fails with
 * "not found in $PATH" is a better outcome than one that fails with an empty
 * command and no explanation.
 */
export function resolveMinskyCommand(): string[] {
  return resolveMinskyCommandFrom(process.argv[0], Bun.main);
}

/**
 * The pure core of {@link resolveMinskyCommand}, taking the two process values
 * as arguments.
 *
 * Split out for testability, and the split is design feedback rather than a
 * convenience: `process.argv` and `Bun.main` are globals this module REACHES,
 * so observing the branch behaviour through the public function would require
 * patching them — the `spyOn`-a-collaborator shape `testing-standards.mdc
 * §Testable Design` tells you to treat as a signal to extract instead. A pure
 * function of its inputs needs no patching at all.
 *
 * @param executable `process.argv[0]` — the running interpreter or binary.
 * @param entry      `Bun.main` — the entry script, or the binary itself when
 *                   compiled single-file.
 */
export function resolveMinskyCommandFrom(
  executable: string | undefined,
  entry: string | undefined
): string[] {
  if (!executable) return ["minsky"];
  if (!entry || entry === executable) return [executable];
  return [executable, entry];
}

/**
 * Convenience split for `spawn(cmd, args)` call sites, which need the head and
 * tail separately rather than one argv array.
 *
 * `command` is never undefined — {@link resolveMinskyCommand} never returns an
 * empty array — but the destructure is written defensively because
 * `noUncheckedIndexedAccess` is on in some workspaces and a bare `[0]` would not
 * typecheck there.
 */
export function resolveMinskyServerSpawn(subcommand: string[]): {
  command: string;
  args: string[];
} {
  const [command, ...prefix] = resolveMinskyCommand();
  return { command: command ?? "minsky", args: [...prefix, ...subcommand] };
}
