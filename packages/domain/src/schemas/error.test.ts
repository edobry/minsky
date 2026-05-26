import { describe, test, expect } from "bun:test";
import { getCauseChain, getErrorMessage, getErrorMessageWithCause } from "./error";

// Canonical synthetic shape of a stale postgres-js client surfacing as
// ECONNRESET on first use. Referenced from multiple test bodies so the rule
// for magic-string-duplication is satisfied AND a future shape change only
// needs one edit here.
const ECONNRESET_SOCKET_HANG_UP = "ECONNRESET: socket hang up";

// Synthetic shape that mirrors drizzle-orm's `DrizzleQueryError` at the wire
// boundary: a wrapper Error whose `.message` is the SQL+params blob and whose
// `.cause` carries the real driver error. Reproduces the originating mt#1831
// failure mode where only `"Failed query: …"` reaches the MCP response.
function makeDrizzleLikeError(query: string, params: string, cause?: unknown): Error {
  const err = new Error(`Failed query: ${query}\nparams: ${params}`);
  if (cause !== undefined) {
    (err as Error & { cause?: unknown }).cause = cause;
  }
  return err;
}

describe("getCauseChain", () => {
  test("returns single-element array for an error with no cause", () => {
    const err = new Error("standalone");
    expect(getCauseChain(err)).toEqual(["standalone"]);
  });

  test("walks a single-level cause", () => {
    const inner = new Error(ECONNRESET_SOCKET_HANG_UP);
    const outer = makeDrizzleLikeError("SELECT 1", "[]", inner);
    expect(getCauseChain(outer)).toEqual([
      "Failed query: SELECT 1\nparams: []",
      ECONNRESET_SOCKET_HANG_UP,
    ]);
  });

  test("walks a deep cause chain (3 levels)", () => {
    const deepest = new Error("socket hang up");
    const middle = Object.assign(new Error("connection terminated unexpectedly"), {
      cause: deepest,
    });
    const outer = makeDrizzleLikeError("UPDATE memories SET ...", "[]", middle);
    const chain = getCauseChain(outer);
    expect(chain.length).toBe(3);
    expect(chain[0]).toContain("Failed query: UPDATE memories");
    expect(chain[1]).toBe("connection terminated unexpectedly");
    expect(chain[2]).toBe("socket hang up");
  });

  test("handles non-Error cause (string)", () => {
    const err = new Error("wrapped");
    (err as Error & { cause?: unknown }).cause = "raw string cause";
    expect(getCauseChain(err)).toEqual(["wrapped", "raw string cause"]);
  });

  test("handles non-Error cause (object literal with .message)", () => {
    const err = new Error("wrapped");
    (err as Error & { cause?: unknown }).cause = { message: "object-literal cause" };
    expect(getCauseChain(err)).toEqual(["wrapped", "object-literal cause"]);
  });

  test("handles non-Error cause (plain object without .message)", () => {
    const err = new Error("wrapped");
    (err as Error & { cause?: unknown }).cause = { code: "EXX" };
    const chain = getCauseChain(err);
    expect(chain[0]).toBe("wrapped");
    // Coerced via String() on the object; exact shape isn't important, just
    // that it doesn't crash and returns something.
    expect(chain.length).toBe(2);
  });

  test("terminates on cycle without infinite loop", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    const chain = getCauseChain(a);
    expect(chain).toEqual(["a", "b"]);
  });

  test("terminates on self-cycle", () => {
    const a: Error & { cause?: unknown } = new Error("self-loop");
    a.cause = a;
    const chain = getCauseChain(a);
    expect(chain).toEqual(["self-loop"]);
  });

  test("caps at MAX_CAUSE_DEPTH for pathologically deep chains", () => {
    // Build a chain of 20 unique errors. The cap is 8 (private constant), so
    // we expect exactly 8 levels in the output.
    let prev: Error & { cause?: unknown } = new Error("level-19");
    for (let i = 18; i >= 0; i--) {
      const next = new Error(`level-${i}`) as Error & { cause?: unknown };
      next.cause = prev;
      prev = next;
    }
    const chain = getCauseChain(prev);
    expect(chain.length).toBe(8);
    expect(chain[0]).toBe("level-0");
    expect(chain[7]).toBe("level-7");
  });

  test("handles undefined and null gracefully", () => {
    expect(getCauseChain(undefined)).toEqual([]);
    expect(getCauseChain(null)).toEqual([]);
  });
});

describe("getErrorMessageWithCause", () => {
  test("surfaces underlying cause from DrizzleQueryError-shaped wrapper (acceptance test 1)", () => {
    // The originating mt#1831 incident: a memory_update DrizzleQueryError
    // returns only "Failed query: …" at the MCP wire boundary. With the
    // new helper, both the wrapper text AND the underlying ECONNRESET
    // signal survive to the operator.
    const cause = new Error(ECONNRESET_SOCKET_HANG_UP);
    const wrapped = makeDrizzleLikeError("UPDATE memories SET content = $1", "[content]", cause);
    const message = getErrorMessageWithCause(wrapped);
    expect(message).toContain("Failed query:");
    expect(message).toContain("ECONNRESET");
    expect(message).toContain("socket hang up");
  });

  test("includes deepest meaningful message for 3-level chain (acceptance test 2)", () => {
    // undici → postgres-net → postgres-client shape: only the deepest
    // message names the actual TCP failure ("socket hang up"). It must
    // reach the wire format.
    const deepest = new Error("socket hang up");
    const middle = Object.assign(new Error("Connection terminated unexpectedly"), {
      cause: deepest,
    });
    const outer = makeDrizzleLikeError("SELECT 1", "[]", middle);
    const message = getErrorMessageWithCause(outer);
    expect(message).toContain("Failed query:");
    expect(message).toContain("Connection terminated");
    expect(message).toContain("socket hang up");
  });

  test("degrades gracefully when no cause is present (acceptance test 3)", () => {
    const err = makeDrizzleLikeError("SELECT 1", "[]");
    const message = getErrorMessageWithCause(err);
    expect(message).toBe("Failed query: SELECT 1\nparams: []");
  });

  test("handles non-Error cause without throwing (acceptance test 4)", () => {
    const err = new Error("wrapper") as Error & { cause?: unknown };
    err.cause = "plain string cause";
    expect(() => getErrorMessageWithCause(err)).not.toThrow();
    expect(getErrorMessageWithCause(err)).toContain("wrapper");
    expect(getErrorMessageWithCause(err)).toContain("plain string cause");
  });

  test("terminates on cycle without throwing or hanging (acceptance test 5)", () => {
    const a: Error & { cause?: unknown } = new Error("a");
    const b: Error & { cause?: unknown } = new Error("b");
    a.cause = b;
    b.cause = a;
    expect(() => getErrorMessageWithCause(a)).not.toThrow();
    const message = getErrorMessageWithCause(a);
    expect(message).toBe("a — caused by: b");
  });

  test("plain non-Drizzle errors pass through unchanged (acceptance test 6)", () => {
    const err = new Error("regular error");
    expect(getErrorMessageWithCause(err)).toBe("regular error");
    expect(getErrorMessageWithCause(err)).toBe(getErrorMessage(err));
  });

  test("handles non-Error top-level values (aligned with getErrorMessage semantics)", () => {
    // mt#1831 PR #1113 R1: when the chain is empty (undefined/null), fall
    // back to getErrorMessage's String() coercion so call sites previously
    // logging "undefined" / "null" don't suddenly surface blank lines.
    expect(getErrorMessageWithCause("string error")).toBe("string error");
    expect(getErrorMessageWithCause(42)).toBe("42");
    expect(getErrorMessageWithCause(undefined)).toBe(getErrorMessage(undefined));
    expect(getErrorMessageWithCause(null)).toBe(getErrorMessage(null));
    // Belt-and-suspenders: explicit string values (current `String()` output).
    expect(getErrorMessageWithCause(undefined)).toBe("undefined");
    expect(getErrorMessageWithCause(null)).toBe("null");
  });

  test("joins all chain levels with the configured separator", () => {
    const c = new Error("c");
    const b = Object.assign(new Error("b"), { cause: c });
    const a = Object.assign(new Error("a"), { cause: b });
    expect(getErrorMessageWithCause(a)).toBe("a — caused by: b — caused by: c");
  });
});
