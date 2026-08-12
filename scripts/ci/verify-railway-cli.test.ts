/**
 * Tests for `verify-railway-cli.sh` (mt#4075).
 *
 * The script is exercised end to end by putting a FAKE `railway` on
 * `RAILWAY_BIN` — the same technique, for the same reason, as
 * `docker-push-with-retry.test.ts`: workflow YAML cannot be driven into a
 * chosen failure, so the probe has to live in a script to be testable at all.
 *
 * Covers the task's acceptance tests directly:
 *   AT1 — a non-runnable binary fails the run, names the INSTALL as the cause,
 *         and does NOT emit the token-blaming text.
 *   AT2 — the token-blaming text belongs to the credential branch of the
 *         WORKFLOW, so this script never emits it; asserted here because AT1's
 *         value depends on the two messages being disjoint.
 *   AT3 — a runnable binary passes silently-enough (exit 0) and reports the
 *         version it verified, leaving a normal run unchanged.
 *
 * Real filesystem use is deliberate and rule-disabled per site below: the unit
 * under test is a shell script spawned as a subprocess, so its `railway`
 * stand-in has to be a real executable file on a real path. An in-memory fs
 * cannot be seen by a child process — the substitution that would make this
 * suite blind to exactly what it checks.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- the subject is a shell script run as a subprocess; its fake `railway` must be a real executable on a real path, which a child process cannot get from an in-memory fs
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- see above; mkdtempSync under the real tmpdir guarantees per-run uniqueness, so there is no cross-test race for the fixed-path rule to prevent
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_PATH = join(import.meta.dir, "verify-railway-cli.sh");
const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The credential `deploy-minsky-mcp.yml` passes; the message must clear it by name. */
const CREDENTIAL = "RAILWAY_MCP_TOKEN";

/**
 * The exact shape the 2026-08-12 failure left behind: the file exists on PATH
 * and cannot be executed. Written non-executable so the kernel — not a mocked
 * branch — produces the failure.
 */
const NON_EXECUTABLE_STUB = "#!/usr/bin/env bash\nexit 0\n";

const WORKING_CLI = `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "railwayapp 4.44.0"
  exit 0
fi
exit 0
`;

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "verify-railway-cli-"));
});

afterEach(() => {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see file header
  rmSync(workdir, { recursive: true, force: true });
});

function writeFakeCli(contents: string, executable: boolean): string {
  const path = join(workdir, "railway");
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see file header
  writeFileSync(path, contents);

  chmodSync(path, executable ? 0o755 : 0o644);
  return path;
}

async function runScript(
  railwayBin: string,
  credentialName: string
): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn([SCRIPT_PATH, credentialName], {
    cwd: REPO_ROOT,
    env: { ...process.env, RAILWAY_BIN: railwayBin },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, output: `${stdout}${stderr}` };
}

describe("verify-railway-cli.sh", () => {
  it("AT1: fails and attributes the cause to the INSTALL when the binary cannot run", async () => {
    const bin = writeFakeCli(NON_EXECUTABLE_STUB, false);

    const { exitCode, output } = await runScript(bin, CREDENTIAL);

    expect(exitCode).toBe(1);
    expect(output).toContain("INSTALL failure");
    expect(output).toContain("is not runnable");
  });

  it("AT1: names the credential as NOT implicated, so the reader does not rotate it", async () => {
    const bin = writeFakeCli(NON_EXECUTABLE_STUB, false);

    const { output } = await runScript(bin, CREDENTIAL);

    expect(output).toContain(`${CREDENTIAL} is NOT implicated`);
    expect(output).toContain("do not re-mint");
  });

  it("AT2: never emits the workflow's token-scope text — the two diagnoses stay disjoint", async () => {
    const bin = writeFakeCli(NON_EXECUTABLE_STUB, false);

    const { output } = await runScript(bin, CREDENTIAL);

    // The exact phrases the redeploy loop uses when a credential IS rejected.
    // If either appeared here, the install failure would read as the credential
    // failure — the whole defect this task fixes.
    expect(output).not.toContain("is not valid for those services");
    expect(output).not.toContain("re-mint it against the minsky-mcp project");
  });

  it("AT3: passes and reports the verified version when the binary runs", async () => {
    const bin = writeFakeCli(WORKING_CLI, true);

    const { exitCode, output } = await runScript(bin, CREDENTIAL);

    expect(exitCode).toBe(0);
    expect(output).toContain("verified runnable");
    expect(output).toContain("railwayapp 4.44.0");
    expect(output).not.toContain("::error::");
  });

  it("a MISSING binary fails the same way as a non-executable one", async () => {
    // Presence and runnability are different questions, and the observed
    // failure was the second. This pins that the script still catches the
    // first, so replacing `--version` with a `command -v` check would not
    // silently narrow it.
    const { exitCode, output } = await runScript(join(workdir, "absent"), CREDENTIAL);

    expect(exitCode).toBe(1);
    expect(output).toContain("INSTALL failure");
  });
});
