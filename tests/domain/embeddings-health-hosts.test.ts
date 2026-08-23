/**
 * Every process that runs embeddings must register a degradation-event emitter
 * (mt#4218).
 *
 * `EmbeddingsHealthTracker` is a per-process singleton whose emitter is supplied
 * by the entry point, so whether a degradation is RECORDED depends on who started
 * the process — and an unregistered emitter is indistinguishable, at the
 * `system_events` table, from "no degradation happened". From mt#2147 until
 * mt#4218 only `mcp start` registered anything; the cockpit daemon and the CLI
 * both ran real embedding work and recorded nothing, for months, silently.
 *
 * A shared helper does not fix that by itself — it still has to be CALLED. This
 * file is the part that does: it enumerates the known hosts and fails when one
 * stops registering. A FOURTH host added later is not covered until someone adds
 * it to `HOSTS` below, which is the point at which they have to think about it.
 *
 * Deliberately a source-text scan rather than a runtime assertion: each host's
 * registration sits inside a server-start path that cannot be invoked from a unit
 * test without booting a daemon, and the property under test is "the call site
 * exists", which is exactly what the text shows.
 */

/* eslint-disable custom/no-real-fs-in-tests -- this test's PURPOSE is to verify the
   real checked-in source of each host entry point. A fake filesystem would assert
   against fixture text this file invented, which is exactly the property that
   cannot go stale and therefore cannot catch a host dropping its registration.
   Same rationale and same form as tests/domain/plan-task-halt-citation.test.ts
   and tests/domain/create-task-claim-steps.test.ts. */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../..");

/** The exported helper every host is required to reach. */
const HELPER = "registerEmbeddingsHealthEventEmitter";

const WIRING_MODULE = "packages/domain/src/ai/embeddings-health-wiring.ts";

/**
 * Known hosts that construct `EmbeddingsHealthTracker` by running embedding work
 * in-process. `why` is carried so a failure explains what breaks, rather than
 * only that a string went missing.
 */
const HOSTS: ReadonlyArray<{ file: string; why: string }> = [
  {
    file: "src/commands/mcp/start-command.ts",
    why: "the MCP server serves memory/task/tool search, all of which embed (mt#2147, the original wiring)",
  },
  {
    file: "src/commands/cockpit/start-command.ts",
    why: "the cockpit daemon runs the per-turn transcript embedding pipeline in-process via sweepers.ts (mt#4218)",
  },
  {
    file: "src/cli.ts",
    why: "`minsky tasks|memory|transcripts index-embeddings` run real embedding calls in a CLI process (mt#4218)",
  },
];

function read(relativePath: string): string {
  // `as string` for the same reason the sibling manifest tests carry it: under
  // the root tsconfig `readFileSync` is typed `string | Buffer` even with an
  // encoding argument.
  return readFileSync(join(REPO_ROOT, relativePath), "utf8") as string;
}

describe("embeddings-health host registration manifest (mt#4218)", () => {
  test("the shared helper is exported under the name the hosts import", () => {
    // Guards the rename case: if this export moves or is renamed without the
    // hosts following, every per-host assertion below would still pass against
    // stale text while production wiring is broken.
    expect(read(WIRING_MODULE)).toContain(`export function ${HELPER}(`);
  });

  for (const host of HOSTS) {
    test(`${host.file} registers an embeddings event emitter`, () => {
      const source = read(host.file);

      // `${HELPER}(` — the CALL, not the bare name. A bare-name match is
      // satisfied by the import statement alone, so a host that imports the
      // helper and never calls it would pass. That is not hypothetical: the
      // first version of this test asserted the bare name, and the negative
      // control (removing the cockpit's call while leaving its import) stayed
      // GREEN. A manifest test that passes on an unused import certifies
      // exactly the silence it exists to prevent.
      expect(
        source.includes(`${HELPER}(`),
        `${host.file} no longer calls ${HELPER}(). This host records embeddings degradations ` +
          `nowhere until it does — ${host.why}. The failure is SILENT in production: ` +
          `emitDegradationEvent resolves null and returns false before reaching a log line.`
      ).toBe(true);
    });
  }

  test("the manifest covers every host that reaches the tracker's error path", () => {
    // A weak but real backstop against the list going stale: the tracker is
    // reached through the embedding services, so a new entry point that
    // constructs one is a candidate host. This asserts the count deliberately,
    // so ADDING a host is a decision recorded in a diff rather than an omission.
    expect(HOSTS).toHaveLength(3);
  });
});
