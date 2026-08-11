/**
 * Tests for `docker-push-with-retry.sh` (mt#3979).
 *
 * The script is exercised end to end by putting a FAKE `docker` on
 * `DOCKER_BIN` — that is the whole reason the retry lives in a script instead
 * of inline workflow YAML, which cannot be driven into a chosen failure.
 *
 * Covers the task's acceptance tests directly:
 *   AT1 — a transient error on the first attempt retries and succeeds, and the
 *         log names the successful attempt number.
 *   AT2 — a failure on EVERY attempt fails the run, and no later ref is pushed.
 *   AT3 — an authentication failure fails IMMEDIATELY without consuming retries.
 *
 * Real filesystem use is deliberate and rule-disabled per site below: the unit
 * under test is a shell script spawned as a subprocess, so its `docker` stand-in
 * has to be a real executable file on a real path. An in-memory fs cannot be
 * seen by a child process, which is exactly the substitution that would make
 * this suite blind to what it exists to check.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
// eslint-disable-next-line custom/no-real-fs-in-tests -- the subject is a shell script run as a subprocess; its fake `docker` must be a real executable on a real path, which a child process cannot get from an in-memory fs
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
// eslint-disable-next-line custom/no-real-fs-in-tests -- see above; mkdtempSync under the real tmpdir guarantees per-run uniqueness, so there is no cross-test race for the fixed-path rule to prevent
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT_RELATIVE_PATH = "scripts/ci/docker-push-with-retry.sh";
const SCRIPT_PATH = join(import.meta.dir, "docker-push-with-retry.sh");
const REPO_ROOT = join(import.meta.dir, "..", "..");

const SHA_REF = "ghcr.io/edobry/minsky:sha-abc1234";
const LATEST_REF = "ghcr.io/edobry/minsky:latest";

/**
 * A stand-in for `docker` whose behaviour is selected by FAKE_DOCKER_MODE and
 * which records every push it is asked to perform, so a test can assert both
 * the attempt COUNT and the ref ORDER.
 */
const FAKE_DOCKER = `#!/usr/bin/env bash
if [ "$1" != "push" ]; then
  exit 0
fi
ref="$2"
count_file="$FAKE_DOCKER_STATE/count"
n=$(( $(cat "$count_file" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$count_file"
echo "$ref" >> "$FAKE_DOCKER_STATE/refs"

echo "5eb3bc1f9a2d: Pushed"
case "$FAKE_DOCKER_MODE" in
  ok)
    exit 0
    ;;
  fail-once)
    if [ "$n" -eq 1 ]; then
      echo "$FAKE_DOCKER_ERROR"
      exit "$FAKE_DOCKER_EXIT"
    fi
    exit 0
    ;;
  fail-always)
    echo "$FAKE_DOCKER_ERROR"
    exit "$FAKE_DOCKER_EXIT"
    ;;
  *)
    echo "fake docker: unknown mode" >&2
    exit 99
    ;;
esac
`;

let workDir: string;
let fakeDockerPath: string;

beforeEach(() => {
  // Per-run unique temp dir (see the file header): the fake `docker` is spawned
  // as a real subprocess and must exist on disk.
  workDir = mkdtempSync(join(tmpdir(), "docker-push-retry-"));
  fakeDockerPath = join(workDir, "fake-docker.sh");
  // eslint-disable-next-line custom/no-real-fs-in-tests -- see above
  writeFileSync(fakeDockerPath, FAKE_DOCKER);
  chmodSync(fakeDockerPath, 0o755);
});

afterEach(() => {
  // eslint-disable-next-line custom/no-real-fs-in-tests -- tears down the per-test temp dir created above
  rmSync(workDir, { recursive: true, force: true });
});

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  attempts: number;
  pushedRefs: string[];
}

function readState(name: string): string {
  try {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- reads back what the spawned fake `docker` recorded; the subprocess can only communicate through the real fs
    return readFileSync(join(workDir, name), "utf8");
  } catch {
    return "";
  }
}

async function runPush(
  refs: string[],
  opts: { mode: string; error?: string; attempts?: number; dockerExit?: number }
): Promise<RunResult> {
  const proc = Bun.spawn([SCRIPT_PATH, ...refs], {
    env: {
      ...process.env,
      DOCKER_BIN: fakeDockerPath,
      DOCKER_PUSH_ATTEMPTS: String(opts.attempts ?? 3),
      // Keep the suite fast: the backoff behaviour under test is "there is one
      // and it is bounded", not its wall-clock duration.
      DOCKER_PUSH_RETRY_BASE_DELAY: "0",
      FAKE_DOCKER_STATE: workDir,
      FAKE_DOCKER_MODE: opts.mode,
      FAKE_DOCKER_ERROR: opts.error ?? "",
      FAKE_DOCKER_EXIT: String(opts.dockerExit ?? 1),
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return {
    stdout,
    stderr,
    exitCode,
    attempts: Number(readState("count").trim() || "0"),
    pushedRefs: readState("refs").split("\n").filter(Boolean),
  };
}

describe("docker-push-with-retry.sh (mt#3979)", () => {
  it("is committed executable — the workflow invokes it directly, not via `bash`", () => {
    // eslint-disable-next-line custom/no-real-fs-in-tests -- asserts the committed file mode, which only the real fs carries
    const mode = statSync(SCRIPT_PATH).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });

  it("AT1: retries an `unknown blob` first attempt and names the attempt that succeeded", async () => {
    const result = await runPush([SHA_REF], { mode: "fail-once", error: "unknown blob" });

    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(2);
    expect(result.stdout).toContain(`push of ${SHA_REF} succeeded on attempt 2/3`);
    expect(result.stdout).toContain("hit a transient registry error on attempt 1/3");
  });

  it("AT2: fails the run when every attempt fails, after exactly the bounded attempt count", async () => {
    const result = await runPush([SHA_REF, LATEST_REF], {
      mode: "fail-always",
      error: "unknown blob",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.attempts).toBe(3);
    expect(result.stdout).toContain("failed on all 3 attempts");
    // No image is promoted: the run stops at the first ref it cannot push, so
    // `:latest` is never attempted.
    expect(result.pushedRefs).toEqual([SHA_REF, SHA_REF, SHA_REF]);
  });

  it("AT3: fails immediately on an authentication error without consuming retries", async () => {
    const result = await runPush([SHA_REF], {
      mode: "fail-always",
      error: "unauthorized: authentication required",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.stdout).toContain("NON-transient error");
    expect(result.stdout).not.toContain("retrying in");
  });

  it("names the attempt on a clean first-try push, so the flake rate has a denominator", async () => {
    const result = await runPush([SHA_REF], { mode: "ok" });

    expect(result.exitCode).toBe(0);
    expect(result.attempts).toBe(1);
    expect(result.stdout).toContain(`push of ${SHA_REF} succeeded on attempt 1/3`);
  });

  it("pushes every ref in the order given when all succeed", async () => {
    const result = await runPush([SHA_REF, LATEST_REF], { mode: "ok" });

    expect(result.exitCode).toBe(0);
    expect(result.pushedRefs).toEqual([SHA_REF, LATEST_REF]);
  });

  it("does not push a later ref once an earlier one fails non-transiently", async () => {
    const result = await runPush([SHA_REF, LATEST_REF], {
      mode: "fail-once",
      error: "denied: permission_denied",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.pushedRefs).toEqual([SHA_REF]);
  });

  it("propagates docker's own exit code rather than collapsing every failure to 1", async () => {
    const result = await runPush([SHA_REF], {
      mode: "fail-always",
      error: "denied: permission_denied",
      dockerExit: 7,
    });

    expect(result.exitCode).toBe(7);
  });

  it("propagates docker's exit code after retry exhaustion too", async () => {
    const result = await runPush([SHA_REF], {
      mode: "fail-always",
      error: "unknown blob",
      dockerExit: 5,
    });

    expect(result.exitCode).toBe(5);
    expect(result.attempts).toBe(3);
  });

  it("exits 2 with a usage message when given no refs", async () => {
    const result = await runPush([], { mode: "ok" });

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("usage:");
  });

  const TRANSIENT_CASES = [
    "unknown blob",
    "blob upload unknown",
    "BLOB_UPLOAD_UNKNOWN: blob upload unknown to registry",
    "unexpected EOF",
    // The registry emits a BARE `EOF` too, which is the form mt#3979's SC2
    // names; matching only `unexpected EOF` would fail-fast on it.
    "error: EOF",
    'failed commit on ref "layer-sha256:9f3e": unexpected status: EOF',
    "write tcp 10.1.0.4:52134->140.82.113.33:443: write: connection reset by peer",
    "dial tcp 140.82.113.33:443: i/o timeout",
    "net/http: TLS handshake timeout",
    "failed to copy: cannot reuse body, request must be retried",
    "received unexpected HTTP status: 502 Bad Gateway",
    "error parsing HTTP 503 response body",
  ];

  for (const error of TRANSIENT_CASES) {
    it(`retries the transient condition: ${error.slice(0, 48)}`, async () => {
      const result = await runPush([SHA_REF], { mode: "fail-once", error });

      expect(result.exitCode).toBe(0);
      expect(result.attempts).toBe(2);
    });
  }

  const NON_TRANSIENT_CASES = [
    "unauthorized: authentication required",
    "denied: permission_denied: write_package",
    "errors: manifest invalid: manifest invalid",
    "name unknown: repository name not known to registry",
    // 429 is deliberately NOT retried: a rate limit is a real signal an
    // operator should see, not a flake to absorb.
    "toomanyrequests: You have reached your pull rate limit",
    // An unrecognised message must fail closed, not be absorbed.
    "some brand new registry error nobody has classified",
    // `EOF` is matched as a standalone word, so it must NOT fire on a token
    // that merely starts with those letters.
    "unauthorized: token is missing the EOFCACHE scope",
  ];

  for (const error of NON_TRANSIENT_CASES) {
    it(`fails fast on the non-transient condition: ${error.slice(0, 48)}`, async () => {
      const result = await runPush([SHA_REF], { mode: "fail-always", error });

      expect(result.exitCode).not.toBe(0);
      expect(result.attempts).toBe(1);
    });
  }
});

describe("deploy workflows use the retry wrapper (mt#3979)", () => {
  const WORKFLOWS = [
    ".github/workflows/deploy-minsky-mcp.yml",
    ".github/workflows/deploy-reviewer.yml",
  ];

  for (const workflow of WORKFLOWS) {
    describe(workflow, () => {
      // Assertions below are made against EXTRACTED lines rather than the whole
      // YAML, so a failure prints the handful of lines that matter instead of
      // several hundred lines of unrelated workflow.
      const lines = (): string[] =>
        // eslint-disable-next-line custom/no-real-fs-in-tests -- reads the committed workflow to assert it is wired to the script; the workflow's content IS the thing under test
        readFileSync(join(REPO_ROOT, workflow), "utf8").split("\n");

      it("has no bare `docker push` left in it", () => {
        const barePushes = lines().filter((line) => /^\s*docker push /.test(line));
        expect(barePushes).toEqual([]);
      });

      it("invokes the retry wrapper exactly once", () => {
        const invocations = lines().filter(
          (line) => line.includes(SCRIPT_RELATIVE_PATH) && !line.trimStart().startsWith("#")
        );
        expect(invocations.length).toBe(1);
      });

      it("passes the immutable sha tag before the mutable :latest pointer", () => {
        const invocation =
          lines().find(
            (line) => line.includes(SCRIPT_RELATIVE_PATH) && !line.trimStart().startsWith("#")
          ) ?? "";
        const shaIndex = invocation.indexOf("sha-");
        const latestIndex = invocation.indexOf(":latest");

        expect(shaIndex).toBeGreaterThan(-1);
        expect(latestIndex).toBeGreaterThan(-1);
        expect(shaIndex).toBeLessThan(latestIndex);
      });
    });
  }
});
