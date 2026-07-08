import { describe, expect, it } from "bun:test";
import { buildGrantFromArgs } from "./grant-guard-override";

const NOW_ISO = "2026-07-08T20:00:00.000Z";
const GUARD_NAME = "duplicate-child-matcher";
const REASON = "concurrent decomposition — distinct sibling";

describe("buildGrantFromArgs", () => {
  it("returns null when --guard is missing", () => {
    expect(buildGrantFromArgs({ scope: "mt#2581", reason: REASON }, NOW_ISO)).toBeNull();
  });

  it("returns null when --scope is missing", () => {
    expect(buildGrantFromArgs({ guard: GUARD_NAME, reason: REASON }, NOW_ISO)).toBeNull();
  });

  it("returns null when --reason is missing (mandatory per mt#2658)", () => {
    expect(buildGrantFromArgs({ guard: GUARD_NAME, scope: "mt#2581" }, NOW_ISO)).toBeNull();
  });

  it("returns null when --reason is present but empty string", () => {
    expect(
      buildGrantFromArgs({ guard: GUARD_NAME, scope: "mt#2581", reason: "" }, NOW_ISO)
    ).toBeNull();
  });

  it("builds a grant with default ttl (30 min) when all required flags are given", () => {
    const grant = buildGrantFromArgs(
      { guard: GUARD_NAME, scope: "mt#2581", reason: REASON },
      NOW_ISO
    );
    expect(grant).not.toBeNull();
    expect(grant?.guardName).toBe(GUARD_NAME);
    expect(grant?.scope).toBe("mt2581"); // normalized
    expect(grant?.reason).toBe(REASON);
    expect(grant?.ttlMs).toBe(30 * 60 * 1000);
    expect(grant?.issuedAt).toBe(NOW_ISO);
  });

  it("honors --ttl-minutes", () => {
    const grant = buildGrantFromArgs(
      { guard: GUARD_NAME, scope: "mt#2581", reason: REASON, "ttl-minutes": "45" },
      NOW_ISO
    );
    expect(grant?.ttlMs).toBe(45 * 60 * 1000);
  });

  it("returns null for a non-positive --ttl-minutes", () => {
    expect(
      buildGrantFromArgs(
        { guard: GUARD_NAME, scope: "mt#2581", reason: REASON, "ttl-minutes": "0" },
        NOW_ISO
      )
    ).toBeNull();
    expect(
      buildGrantFromArgs(
        { guard: GUARD_NAME, scope: "mt#2581", reason: REASON, "ttl-minutes": "-5" },
        NOW_ISO
      )
    ).toBeNull();
  });

  it("returns null for a non-numeric --ttl-minutes", () => {
    expect(
      buildGrantFromArgs(
        { guard: GUARD_NAME, scope: "mt#2581", reason: REASON, "ttl-minutes": "abc" },
        NOW_ISO
      )
    ).toBeNull();
  });

  it("passes through --issued-by", () => {
    const grant = buildGrantFromArgs(
      {
        guard: GUARD_NAME,
        scope: "mt#2581",
        reason: REASON,
        "issued-by": "main-agent session abc",
      },
      NOW_ISO
    );
    expect(grant?.issuedBy).toBe("main-agent session abc");
  });

  it("normalizes the guard name (lowercases + trims)", () => {
    const grant = buildGrantFromArgs(
      { guard: "  Duplicate-Child-Matcher  ", scope: "mt#2581", reason: REASON },
      NOW_ISO
    );
    expect(grant?.guardName).toBe(GUARD_NAME);
  });

  it("normalizes the scope (strips # and lowercases)", () => {
    const grant = buildGrantFromArgs(
      { guard: GUARD_NAME, scope: "MT#2581", reason: REASON },
      NOW_ISO
    );
    expect(grant?.scope).toBe("mt2581");
  });
});
