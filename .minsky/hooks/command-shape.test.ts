import { describe, expect, test } from "bun:test";
import { isCompoundCommand, isReshapedRetry, leadingTokenOf, splitTopLevel } from "./command-shape";

// The 2026-08-08 Railway incident verbatim (mt#3533 §FOURTH INSTANCE): both
// denied attempts wrapped `curl` in a compound command, and the identical
// request succeeded on the first try once `curl` led.
const DENIED_COMPOUND =
  "railway whoami >/dev/null; TOKEN=$(jq -r .token ~/.railway/config.json); " +
  'curl -s -X POST https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer $TOKEN" -d @p.json';
const RESHAPED =
  'curl -s -X POST https://backboard.railway.com/graphql/v2 -H "Authorization: Bearer $(jq -r .token ~/.railway/config.json)" -d @p.json';

describe("leadingTokenOf", () => {
  test("takes the first program of the first segment", () => {
    expect(leadingTokenOf(DENIED_COMPOUND)).toBe("railway");
    expect(leadingTokenOf(RESHAPED)).toBe("curl");
  });

  test("strips env-var prefixes rather than reporting them as the program", () => {
    expect(leadingTokenOf("TOKEN=abc FOO=1 curl https://example.com")).toBe("curl");
  });

  test("reports the first pipeline stage, not the tail", () => {
    expect(leadingTokenOf("bun test ./x | tail -5")).toBe("bun");
  });

  test("is not fooled by a separator inside quotes", () => {
    expect(leadingTokenOf("echo 'a; b'")).toBe("echo");
  });

  test("returns empty for an empty command rather than throwing", () => {
    expect(leadingTokenOf("")).toBe("");
    expect(leadingTokenOf("   ")).toBe("");
  });
});

describe("isCompoundCommand", () => {
  test("is true for top-level separators", () => {
    expect(isCompoundCommand(DENIED_COMPOUND)).toBe(true);
    expect(isCompoundCommand("a && b")).toBe(true);
    expect(isCompoundCommand("a || b")).toBe(true);
  });

  test("is false for a single command", () => {
    expect(isCompoundCommand(RESHAPED)).toBe(false);
    expect(isCompoundCommand("curl https://example.com")).toBe(false);
  });

  test("is true for a pipeline — a dropped pipe counts as a simplification", () => {
    expect(isCompoundCommand("bun test | tail -5")).toBe(true);
    expect(isReshapedRetry("curl https://a.example | jq .x", "curl https://a.example")).toBe(true);
  });

  test("is false when the separator is quoted", () => {
    expect(isCompoundCommand("echo 'a; b'")).toBe(false);
    expect(splitTopLevel("echo 'a; b'")).toEqual(["echo 'a; b'"]);
  });
});

describe("isReshapedRetry", () => {
  test("the originating incident: compound railway-wrapped curl vs curl-first", () => {
    expect(isReshapedRetry(DENIED_COMPOUND, RESHAPED)).toBe(true);
  });

  test("compound to simple counts even when the leading token is unchanged", () => {
    // The axis that matters for a prefix allow-rule: `curl` leading vs `curl`
    // buried behind a separator. Same program, different reachability.
    expect(isReshapedRetry("curl a; curl b", "curl b")).toBe(true);
  });

  test("re-issuing the identical command is NOT a reshape", () => {
    expect(isReshapedRetry(RESHAPED, RESHAPED)).toBe(false);
    expect(isReshapedRetry(DENIED_COMPOUND, DENIED_COMPOUND)).toBe(false);
  });

  test("a differently-argued but same-shape retry is NOT a reshape", () => {
    expect(isReshapedRetry("curl https://a.example", "curl https://b.example")).toBe(false);
  });

  test("simple to compound is NOT a reshape — it moves the wrong way", () => {
    expect(isReshapedRetry("curl b", "curl a; curl b")).toBe(false);
  });
});
