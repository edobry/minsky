/**
 * Unit tests for `createSessionPrChecksCommand`'s catch-block ordering
 * (mt#2888, PR #2018 R1 regression fix).
 *
 * `getDeps` is `await`-ed first inside the command's `try` block, so a
 * throwing `getDeps` reaches the SAME `catch` block a throwing domain call
 * would — the simplest injection point available without mocking the
 * `sessionPrChecks` module import.
 */
import { describe, expect, test } from "bun:test";
import { createSessionPrChecksCommand } from "./pr-checks-command";
import { ResourceNotFoundError, ValidationError } from "@minsky/domain/errors/index";

describe("createSessionPrChecksCommand — error-classification ordering (mt#2888)", () => {
  const CTX = { interface: "cli" } as any;

  test("REGRESSION: a ResourceNotFoundError whose message contains 'rate limit' passes through with its ORIGINAL type, not reclassified", async () => {
    const err = new ResourceNotFoundError(
      "Session 'my-session' not found (internal rate limit tracker had no entry)"
    );
    const command = createSessionPrChecksCommand(async () => {
      throw err;
    });
    await expect(command.execute({ sessionId: "my-session" }, CTX)).rejects.toBe(err);
  });

  test("REGRESSION: a ValidationError whose message contains '(HTTP 5' passes through with its ORIGINAL type, not reclassified", async () => {
    const err = new ValidationError("Invalid timeoutSeconds: '(HTTP 500-ish looking value)'");
    const command = createSessionPrChecksCommand(async () => {
      throw err;
    });
    await expect(command.execute({ sessionId: "my-session" }, CTX)).rejects.toBe(err);
  });

  test("a genuine GitHub-degraded MinskyError (handleOctokitError's exact headline) IS classified as SERVICE_DEGRADED", async () => {
    const command = createSessionPrChecksCommand(async () => {
      throw new Error(
        "GitHub API degraded/unavailable (HTTP 503)\n\nGitHub's API returned a server error for this request."
      );
    });
    try {
      await command.execute({ sessionId: "my-session" }, CTX);
      throw new Error("expected command.execute to throw");
    } catch (err) {
      expect((err as { payload?: { code?: string } })?.payload?.code).toBe("SERVICE_DEGRADED");
    }
  });

  test("an unrelated generic error still falls through to the original 'Failed to get session PR checks' wrap", async () => {
    const command = createSessionPrChecksCommand(async () => {
      throw new Error("network cable unplugged");
    });
    await expect(command.execute({ sessionId: "my-session" }, CTX)).rejects.toThrow(
      "Failed to get session PR checks: network cable unplugged"
    );
  });
});
