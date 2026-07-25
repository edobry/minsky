/**
 * Credential redaction on push failure (mt#3219).
 *
 * `deps.execAsync` takes a shell STRING, so a failed push throws an error whose
 * message is `Command failed: <the entire command>`. With `authToken` set that
 * command carries `-c http.https://github.com/.extraheader='AUTHORIZATION:
 * basic <base64>'`, and the base64 decodes to `x-access-token:<token>`. Tool
 * output is persisted and transcript-ingested, so every push failure wrote a
 * live credential into durable, searchable storage.
 *
 * The fixtures below build the header the SAME way the production code does
 * (base64 of `x-access-token:<token>`) rather than pasting a literal, so a
 * change to how the header is constructed cannot leave these tests asserting
 * against a shape that is no longer produced.
 */
import { describe, test, expect } from "bun:test";
import {
  pushImpl,
  redactPushCredentials,
  redactPushError,
  REDACTED_CREDENTIAL,
  type PushDependencies,
} from "./push-operations";

const TOKEN = "ghs_EXAMPLEtokenEXAMPLEtoken1234567890";
const ENCODED = Buffer.from(`x-access-token:${TOKEN}`).toString("base64");

/** The command text Node's `exec` echoes back on failure, as production builds it. */
const FAILING_COMMAND =
  `Command failed: git -C '/tmp/ws' -c credential.helper= ` +
  `-c http.https://github.com/.extraheader='AUTHORIZATION: basic ${ENCODED}' push 'origin' 'task/mt-3219'`;

const REMOTE_MESSAGE =
  "remote: Permission to edobry/minsky.git denied to minsky-ai[bot].\n" +
  "fatal: unable to access 'https://github.com/edobry/minsky.git/': The requested URL returned error: 403";

/** Asserts no credential material survives, in any encoding. */
function expectNoCredential(text: string): void {
  expect(text).not.toContain(TOKEN);
  expect(text).not.toContain(ENCODED);
  expect(text).not.toContain("x-access-token");
  // Catches a *differently* encoded leak of the same secret.
  expect(text.includes(Buffer.from(TOKEN).toString("base64"))).toBe(false);
}

describe("redactPushCredentials", () => {
  test("removes the injected Authorization header from an echoed command", () => {
    const redacted = redactPushCredentials(FAILING_COMMAND);
    expectNoCredential(redacted);
    expect(redacted).toContain(REDACTED_CREDENTIAL);
  });

  test("preserves everything that makes the failure diagnosable", () => {
    // Redaction must not cost diagnosability — the remote's own text is what
    // made mt#3210's root cause findable.
    const redacted = redactPushCredentials(`${FAILING_COMMAND}\n${REMOTE_MESSAGE}`);
    expect(redacted).toContain("Permission to edobry/minsky.git denied to minsky-ai[bot]");
    expect(redacted).toContain("403");
    expect(redacted).toContain("task/mt-3219");
    expect(redacted).toContain("push 'origin'");
  });

  test("removes a raw token appearing outside the header", () => {
    expectNoCredential(redactPushCredentials(`fatal: bad credentials for ${TOKEN}`));
  });

  test("leaves credential-free text untouched", () => {
    // Guards against over-redaction quietly eating ordinary output.
    expect(redactPushCredentials(REMOTE_MESSAGE)).toBe(REMOTE_MESSAGE);
  });
});

describe("redactPushError", () => {
  test("redacts message and stderr while preserving the fields callers branch on", () => {
    // mt#3210's keychain-fallback detector reads stderr for the permission
    // signature; if redaction dropped these fields it would silently disable
    // that fallback.
    const err = Object.assign(new Error(`${FAILING_COMMAND}\n${REMOTE_MESSAGE}`), {
      stderr: `${REMOTE_MESSAGE}\n${FAILING_COMMAND}`,
      stdout: "",
      code: 128,
    });

    const out = redactPushError(err) as Error & { stderr: string; code: number };

    expectNoCredential(out.message);
    expectNoCredential(out.stderr);
    expect(out.stderr).toContain("denied to minsky-ai[bot]");
    expect(out.code).toBe(128);
  });

  test("passes through a non-Error without throwing", () => {
    expect(redactPushError(42)).toBe(42);
  });
});

describe("pushImpl surfaces a redacted error (end to end)", () => {
  test("a push that fails with an auth error does not leak the token", async () => {
    // Drives the real pushImpl with a stub exec that fails the push exactly as
    // Node's exec does — proving the redaction is wired into the throw path,
    // not merely available as a helper.
    const deps: PushDependencies = {
      async execAsync(command: string) {
        if (command.includes("rev-parse")) return { stdout: "task/mt-3219\n", stderr: "" };
        if (command.includes("remote")) return { stdout: "origin\n", stderr: "" };
        if (command.includes(" push ")) {
          throw Object.assign(new Error(`${FAILING_COMMAND}\n${REMOTE_MESSAGE}`), {
            stderr: REMOTE_MESSAGE,
          });
        }
        return { stdout: "", stderr: "" };
      },
    };

    let thrown: unknown;
    try {
      await pushImpl({ repoPath: "/tmp/ws", authToken: TOKEN }, deps);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expectNoCredential(message);
    // Still diagnosable.
    expect(message).toContain("denied to minsky-ai[bot]");
  });
});
