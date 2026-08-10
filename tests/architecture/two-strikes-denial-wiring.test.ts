import { describe, expect, test } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- reads the real committed hook sources: whether the entrypoint WIRES the recorder is a property of the committed file, not of injectable state; same exemption shape as tests/architecture/bundle-reflect-polyfill.test.ts
import { readFileSync } from "fs";
import { join } from "path";

/**
 * mt#3802 — the guard-denial recorder's INVOCATION PATH.
 *
 * The dispatcher cannot import the 2-strikes tracker: the tracker lives in
 * `packages/domain` and `dispatcher.ts` holds a no-`packages/domain` invariant.
 * So the dispatcher takes the recorder as an injected dependency whose DEFAULT
 * IS A NO-OP, and the entrypoint supplies the real one.
 *
 * That makes the entrypoint the whole invocation path. If the wiring is ever
 * dropped, every guard denial still denies, every test of the recorder still
 * passes, and the mechanism records nothing — the exact "the feature exists,
 * its tests pass, it produces nothing" shape `work-completion.mdc §Invocation
 * path required for event/poll mechanisms` names.
 *
 * These assertions read source text, which is why they live in the architecture
 * suite (alongside `bundle-reflect-polyfill.test.ts`) rather than in a unit test.
 */

const HOOKS_DIR = join(import.meta.dir, "../../.minsky/hooks");

function hookSource(filename: string): string {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- same exemption as the import: these assertions ARE about the committed files, so there is no injectable state to fake
  return readFileSync(join(HOOKS_DIR, filename), "utf-8") as string;
}

describe("guard-denial recording is actually wired", () => {
  test("the PreToolUse entrypoint passes the real recorder to the dispatcher", () => {
    const source = hookSource("dispatch-pretooluse.ts");

    expect(source).toContain("recordGuardDenialFn: recordGuardDenial");
    expect(source).toContain('from "./two-strikes-record"');
  });

  test("the dispatcher's deny branch calls the injected recorder", () => {
    const source = hookSource("dispatcher.ts");

    expect(source).toContain("recordGuardDenialFn({");
    // Injected, never imported — importing would break the file's own stated
    // no-`packages/domain` invariant, transitively via the tracker.
    expect(source).not.toContain('from "./two-strikes-record"');
  });

  test("block-git-gh-cli records its own denials while it is off the dispatcher", () => {
    // It is absent from GUARD_REGISTRY, so the dispatcher's central call cannot
    // see it — and it is the guard from this task's originating incident, where
    // four byte-identical Bash calls were denied in a row with nothing watching.
    const source = hookSource("block-git-gh-cli.ts");

    expect(source).toContain("recordGuardDenial({");
    expect(source).toContain(`guardName: "block-git-gh-cli"`);
  });

  test("that guard is still off the dispatcher — if it migrates, move the call", () => {
    // A guard on BOTH paths would double-record. This fails when someone adds
    // block-git-gh-cli to the registry, which is the moment to delete the
    // in-guard call above.
    const registry = hookSource("registry.ts");

    expect(registry).not.toContain(`name: "block-git-gh-cli"`);
  });
});
