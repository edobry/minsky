// Tests for code-mechanism-assertion-dedup-store.ts (mt#3113 leg 4).
//
// Mirrors guard-health-escalation-notify-store.test.ts's structure and
// in-memory fs stub — the two stores share the same cooldown-decision
// contract.

import { describe, test, expect } from "bun:test";
import {
  claimSetSignature,
  shouldInjectClaimSet,
  CLAIM_DEDUP_COOLDOWN_MS,
} from "./code-mechanism-assertion-dedup-store";

// In-memory fs stub — avoids real fs entirely for the pure-decision tests.
function memoryFs() {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    fs: {
      existsSync: (p: string) => files.has(p) || dirs.has(p),
      mkdirSync: (p: string) => {
        dirs.add(p);
      },
      readFileSync: (p: string) => {
        const content = files.get(p);
        if (content === undefined) throw new Error(`ENOENT: ${p}`);
        return content;
      },
      writeFileSync: (p: string, data: string) => {
        files.set(p, data);
      },
    },
  };
}

describe("claimSetSignature", () => {
  test("is stable regardless of input array order (sorted internally)", () => {
    const a = [
      { symbol: "foo", predicate: "clamps" },
      { symbol: "bar", predicate: "defaults to" },
    ];
    const b = [
      { symbol: "bar", predicate: "defaults to" },
      { symbol: "foo", predicate: "clamps" },
    ];
    expect(claimSetSignature(a)).toBe(claimSetSignature(b));
  });

  test("changes when the claim set changes (different symbol)", () => {
    const a = [{ symbol: "foo", predicate: "clamps" }];
    const b = [{ symbol: "baz", predicate: "clamps" }];
    expect(claimSetSignature(a)).not.toBe(claimSetSignature(b));
  });

  test("changes when the predicate changes for the same symbol", () => {
    const a = [{ symbol: "foo", predicate: "clamps" }];
    const b = [{ symbol: "foo", predicate: "defaults to" }];
    expect(claimSetSignature(a)).not.toBe(claimSetSignature(b));
  });

  test("empty claim set has a stable signature", () => {
    expect(claimSetSignature([])).toBe(claimSetSignature([]));
  });
});

describe("shouldInjectClaimSet (mt#3113 leg 4 — cooldown/dedup)", () => {
  test("injects on the FIRST call for a session (no prior record)", () => {
    const { fs } = memoryFs();
    const now = new Date("2026-07-23T00:00:00Z");
    expect(shouldInjectClaimSet("sess-1", "sig-A", { fs, now: () => now, dir: "/store" })).toBe(
      true
    );
  });

  test("SUPPRESSES a repeat of the SAME claim-set signature within the cooldown window (AT3)", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-23T00:00:00Z");
    expect(shouldInjectClaimSet("sess-1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    const t1 = new Date(t0.getTime() + 5 * 60 * 1000); // 5 minutes later
    expect(shouldInjectClaimSet("sess-1", "sig-A", { fs, now: () => t1, dir: "/store" })).toBe(
      false
    );
  });

  test("resurfaces once the cooldown elapses for the SAME signature", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-23T00:00:00Z");
    expect(shouldInjectClaimSet("sess-1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    const tAfter = new Date(t0.getTime() + CLAIM_DEDUP_COOLDOWN_MS + 1);
    expect(shouldInjectClaimSet("sess-1", "sig-A", { fs, now: () => tAfter, dir: "/store" })).toBe(
      true
    );
  });

  test("resurfaces IMMEDIATELY for a DIFFERENT signature, even mid-cooldown (a genuinely new claim set)", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-23T00:00:00Z");
    expect(shouldInjectClaimSet("sess-1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    const t1 = new Date(t0.getTime() + 60 * 1000); // 1 minute later — well within cooldown
    expect(shouldInjectClaimSet("sess-1", "sig-B", { fs, now: () => t1, dir: "/store" })).toBe(
      true
    );
  });

  test("a claim set repeating across many consecutive turns injects far below every-turn (the ~10h incident shape)", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-23T00:00:00Z").getTime();
    let injected = 0;
    const TURNS = 40;
    // 40 turns over ~3.3 hours (5 min apart) with the IDENTICAL claim-set
    // signature — the observed ~10h/nearly-every-turn incident shape.
    for (let i = 0; i < TURNS; i++) {
      const now = new Date(t0 + i * 5 * 60 * 1000);
      const didInject = shouldInjectClaimSet("sess-sustained", "sig-sustained", {
        fs,
        now: () => now,
        dir: "/store",
      });
      if (didInject) injected++;
    }
    // 40 turns over 200 minutes, 1h cooldown -> at most 4 injections; nowhere
    // near "nearly every turn."
    expect(injected).toBeLessThanOrEqual(4);
    expect(injected / TURNS).toBeLessThan(0.55);
  });

  test("two session ids that collide under naive char-sanitization get INDEPENDENT cooldowns", () => {
    const { fs, files } = memoryFs();
    const t0 = new Date("2026-07-23T00:00:00Z");
    expect(shouldInjectClaimSet("sess:1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    expect(shouldInjectClaimSet("sess/1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    expect(files.size).toBe(2);
  });

  test("a DIFFERENT session gets its own independent cooldown (per-session scope)", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-23T00:00:00Z");
    expect(shouldInjectClaimSet("sess-1", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
    expect(shouldInjectClaimSet("sess-2", "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
  });

  test("fails OPEN (injects) when the store read throws", () => {
    const fs = {
      existsSync: () => true,
      mkdirSync: () => {},
      readFileSync: () => {
        throw new Error("EACCES");
      },
      writeFileSync: () => {},
    };
    expect(shouldInjectClaimSet("sess-1", "sig-A", { fs, dir: "/store" })).toBe(true);
  });

  test("fails OPEN (still injects) when the store write throws", () => {
    const fs = {
      existsSync: () => false,
      mkdirSync: () => {},
      readFileSync: () => "",
      writeFileSync: () => {
        throw new Error("ENOSPC");
      },
    };
    expect(shouldInjectClaimSet("sess-1", "sig-A", { fs, dir: "/store" })).toBe(true);
  });

  test("undefined sessionId does not throw (falls back to unknown-session bucket)", () => {
    const { fs } = memoryFs();
    const t0 = new Date("2026-07-23T00:00:00Z");
    expect(shouldInjectClaimSet(undefined, "sig-A", { fs, now: () => t0, dir: "/store" })).toBe(
      true
    );
  });
});
