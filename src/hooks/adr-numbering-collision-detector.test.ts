import { describe, test, expect } from "bun:test";
import {
  extractAdrNumber,
  normalizeAdrNumber,
  detectAdrNumberCollisions,
  isAdrNumberingCollisionOverrideTruthy,
  ADR_NUMBERING_COLLISION_CHECK_OVERRIDE_ENV,
} from "./adr-numbering-collision-detector";

describe("extractAdrNumber", () => {
  test("parses the leading NNN prefix from a bare filename", () => {
    expect(extractAdrNumber("adr-031-guidance-detector-lifecycle-event.md")).toBe("031");
  });

  test("parses the leading NNN prefix from a full repo-relative path", () => {
    expect(
      extractAdrNumber(
        "docs/architecture/adr-034-symbol-identification-in-code-mechanism-assertion.md"
      )
    ).toBe("034");
  });

  test("returns null for a non-ADR filename", () => {
    expect(extractAdrNumber("docs/architecture/agent-guidance-mechanisms.md")).toBeNull();
  });

  test("returns null when the number is missing or malformed", () => {
    expect(extractAdrNumber("adr-guidance-detector.md")).toBeNull();
    expect(extractAdrNumber("adr.md")).toBeNull();
  });
});

describe("normalizeAdrNumber", () => {
  test("pads a short number to 3 digits", () => {
    expect(normalizeAdrNumber("1")).toBe("001");
    expect(normalizeAdrNumber("31")).toBe("031");
  });

  test("is a no-op on an already-3-digit number", () => {
    expect(normalizeAdrNumber("031")).toBe("031");
  });

  test("collapses different paddings of the same number to the same canonical form", () => {
    expect(normalizeAdrNumber("1")).toBe(normalizeAdrNumber("001"));
    expect(normalizeAdrNumber("031")).toBe(normalizeAdrNumber("31"));
  });

  test("does not truncate a number wider than 3 digits", () => {
    expect(normalizeAdrNumber("1234")).toBe("1234");
  });
});

describe("detectAdrNumberCollisions", () => {
  test("clean corpus: every ADR has a unique number — no collisions", () => {
    const paths = [
      "docs/architecture/adr-029-numeric-short-ids-foundation.md",
      "docs/architecture/adr-030-reviewer-interaction-channel-allocation.md",
      "docs/architecture/adr-031-guidance-detector-lifecycle-event.md",
      "docs/architecture/adr-032-guard-threshold-tuning-loop.md",
      "docs/architecture/adr-033-cli-install-channel.md",
      "docs/architecture/adr-034-symbol-identification-in-code-mechanism-assertion.md",
    ];
    expect(detectAdrNumberCollisions(paths)).toHaveLength(0);
  });

  test("the mt#3613 originating case: two files share number 031", () => {
    const lifecycleEventAdr = "docs/architecture/adr-031-guidance-detector-lifecycle-event.md";
    const symbolIdentificationAdr =
      "docs/architecture/adr-031-symbol-identification-in-code-mechanism-assertion.md";
    const paths = [lifecycleEventAdr, symbolIdentificationAdr];
    const collisions = detectAdrNumberCollisions(paths);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      number: "031",
      paths: [lifecycleEventAdr, symbolIdentificationAdr],
    });
  });

  test("mixed padding: adr-1-*.md and adr-001-*.md are the SAME number and collide", () => {
    const paths = ["docs/architecture/adr-1-old-style.md", "docs/architecture/adr-001-new.md"];
    const collisions = detectAdrNumberCollisions(paths);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      number: "001",
      paths: ["docs/architecture/adr-001-new.md", "docs/architecture/adr-1-old-style.md"],
    });
  });

  test("reports multiple independent collisions", () => {
    const paths = [
      "docs/architecture/adr-005-a.md",
      "docs/architecture/adr-005-b.md",
      "docs/architecture/adr-010-c.md",
      "docs/architecture/adr-010-d.md",
      "docs/architecture/adr-011-e.md",
    ];
    const collisions = detectAdrNumberCollisions(paths);
    expect(collisions.map((c) => c.number)).toEqual(["005", "010"]);
  });

  test("a three-way collision is reported as one entry with all three paths", () => {
    const paths = [
      "docs/architecture/adr-007-a.md",
      "docs/architecture/adr-007-b.md",
      "docs/architecture/adr-007-c.md",
    ];
    const collisions = detectAdrNumberCollisions(paths);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.paths).toHaveLength(3);
  });

  test("ignores non-ADR-shaped paths mixed into the list", () => {
    const paths = [
      "docs/architecture/adr-001-foo.md",
      "docs/architecture/README.md",
      "docs/architecture/agent-guidance-mechanisms.md",
    ];
    expect(detectAdrNumberCollisions(paths)).toHaveLength(0);
  });

  test("empty input yields no collisions", () => {
    expect(detectAdrNumberCollisions([])).toHaveLength(0);
  });
});

describe("isAdrNumberingCollisionOverrideTruthy", () => {
  test("true for 1/true/yes (case-insensitive)", () => {
    expect(isAdrNumberingCollisionOverrideTruthy("1")).toBe(true);
    expect(isAdrNumberingCollisionOverrideTruthy("true")).toBe(true);
    expect(isAdrNumberingCollisionOverrideTruthy("YES")).toBe(true);
  });

  test("false for unset/empty/other", () => {
    expect(isAdrNumberingCollisionOverrideTruthy(undefined)).toBe(false);
    expect(isAdrNumberingCollisionOverrideTruthy("")).toBe(false);
    expect(isAdrNumberingCollisionOverrideTruthy("0")).toBe(false);
    expect(isAdrNumberingCollisionOverrideTruthy("nope")).toBe(false);
  });

  test("override env-var name is stable", () => {
    expect(ADR_NUMBERING_COLLISION_CHECK_OVERRIDE_ENV).toBe(
      "MINSKY_SKIP_ADR_NUMBERING_COLLISION_CHECK"
    );
  });
});
