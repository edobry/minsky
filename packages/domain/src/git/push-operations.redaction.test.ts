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

/** The fragment that must SURVIVE redaction — it is what made mt#3210 diagnosable. */
const DENIAL_FRAGMENT = "denied to minsky-ai[bot]";

const REMOTE_MESSAGE =
  `remote: Permission to edobry/minsky.git ${DENIAL_FRAGMENT}.\n` +
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
    expect(redacted).toContain(DENIAL_FRAGMENT);
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
    expect(out.stderr).toContain(DENIAL_FRAGMENT);
    expect(out.code).toBe(128);
  });

  test("passes through a non-Error without throwing", () => {
    expect(redactPushError(42)).toBe(42);
  });

  test("preserves the error's subclass, name, and identity (PR #2319 R1)", () => {
    // Redaction must not become a type change. An earlier draft rewrapped into
    // a plain `new Error(...)`, which silently broke `instanceof` for subclasses
    // and dropped `name` and non-enumerable properties — a behavior change well
    // beyond redaction that a caller branching on error type would hit without
    // warning. Mutating in place keeps all of it.
    class GitExecError extends Error {
      name = "GitExecError";
      stderr = REMOTE_MESSAGE;
      code = 128;
    }
    const original = new GitExecError(FAILING_COMMAND);
    Object.defineProperty(original, "hidden", { value: "kept", enumerable: false });

    const out = redactPushError(original);

    expect(out).toBe(original); // same object, not a copy
    expect(out).toBeInstanceOf(GitExecError);
    expect((out as GitExecError).name).toBe("GitExecError");
    expect((out as GitExecError).code).toBe(128);
    expect((out as { hidden: string }).hidden).toBe("kept");
    expectNoCredential((out as Error).message);
  });

  test("does not chew a matching prefix out of a longer identifier", () => {
    // Guards the over-match risk R1 raised in the other direction: the token
    // patterns are word-anchored, so text that merely STARTS like a token is
    // left alone rather than being partially eaten, which would corrupt the
    // diagnostic output redaction is supposed to preserve.
    const benign = "branch ghost_feature_work and file ghp_notatoken.md";
    expect(redactPushCredentials(benign)).toBe(benign);
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
    // stderr too, not just the message (R1 non-blocking): mt#3210's fallback
    // reads stderr, so it is a real consumer and a real leak surface.
    expectNoCredential((thrown as { stderr: string }).stderr ?? "");
    // Still diagnosable.
    expect(message).toContain(DENIAL_FRAGMENT);
    expect((thrown as { stderr: string }).stderr).toContain(DENIAL_FRAGMENT);
  });
});
