/**
 * mt#4748 R1 — end-to-end write/read parity for the calibration-review
 * COMMAND surface (`src/adapters/shared/commands/calibration.ts`).
 *
 * `calibration.test.ts`'s own suite writes its fixtures via
 * `writeCalibrationLog`, which resolves through the SAME
 * `resolveCalibrationStatePath` helper the command's `readContent` closure
 * calls — so that suite proves the command agrees with ITSELF, never with
 * the actual production writer. This test writes through
 * `logCalibrationRecord` (this file's sibling `./dispatcher.ts` — the real
 * per-guard write path every dispatcher-registered guard uses) instead, so a
 * divergence between the write side and the command's read side is actually
 * caught here.
 *
 * Lives in the hooks tree, not next to the command, for a measured reason:
 * importing `.minsky/hooks/dispatcher.ts` from a `src/` test file pulls its
 * whole transitive closure into the ROOT tsconfig's compilation unit, which
 * does not share `tsconfig.hooks.json`'s `"types": ["bun", "node"]`
 * override — doing so surfaced 27 pre-existing `string | Buffer` errors
 * across unrelated hook files. Importing `src/domain/**` / `src/adapters/**`
 * FROM the hooks tree is the already-established safe direction
 * (`calibration-review-cadence-detector.ts` already does this for
 * `src/domain/calibration/calibration-sweep.ts`), so this test lives here.
 */
/* eslint-disable custom/no-real-fs-in-tests -- proves a real write (through
   the production dispatcher path) and a real read (through the production
   command) agree on where a calibration log lives. A mock would assert the
   mock. A throwaway mkdtempSync directory (removed in `finally`) keeps this
   isolated from any real state dir content. */

import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logCalibrationRecord } from "./dispatcher";
import { sharedCommandRegistry } from "../../src/adapters/shared/command-registry";
import {
  registerCalibrationCommands,
  resolveCalibrationStatePath,
} from "../../src/adapters/shared/commands/calibration";

const COMMAND_ID = "observability.calibration-review";

function getCommand() {
  let command = sharedCommandRegistry.getCommand(COMMAND_ID);
  if (!command) {
    registerCalibrationCommands();
    command = sharedCommandRegistry.getCommand(COMMAND_ID);
  }
  if (!command) throw new Error(`${COMMAND_ID} not registered`);
  return command;
}

describe("mt#4748 R1 — write/read parity (dispatcher write, calibration-review command read)", () => {
  test("a record written via logCalibrationRecord is found by observability.calibration-review", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "mt4748-parity-command-"));
    try {
      logCalibrationRecord(
        "causal-premise",
        {
          timestamp: new Date().toISOString(),
          session_id: "mt4748-parity",
          matchedPhrases: ["because"],
          hadSameTurnVerification: false,
        },
        { projectDir: workspace }
      );

      const result = (await getCommand().execute(
        { ack: false, json: true },
        { workspacePath: workspace }
      )) as {
        success: boolean;
        results: Array<{ name: string; exists: boolean; totalFires: number }>;
      };

      expect(result.success).toBe(true);
      // Not a can't-fail probe: with the pre-mt#4748 join(workspacePath,
      // relPath) resolution, `logCalibrationRecord`'s state-dir write is
      // invisible here and `exists` reads false with `totalFires: 0` —
      // indistinguishable from "no one has ever fired this detector".
      const causalPremise = result.results.find((r) => r.name === "causal-premise");
      expect(causalPremise?.exists).toBe(true);
      expect(causalPremise?.totalFires).toBeGreaterThanOrEqual(1);
    } finally {
      // The write lands under the shared state dir, outside `workspace` —
      // clean it up too, not just the mkdtemp'd workspace.
      const statePath = await resolveCalibrationStatePath(
        workspace,
        ".minsky/causal-premise-calibration.jsonl"
      );
      rmSync(statePath, { force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
