/**
 * mt#4965 — tests for the empty-half-Postgres-URL classifier.
 *
 * Every fixture below is SYNTHETIC. None is a credential, and the file is
 * covered by `.gitleaks.toml`'s `.*\.test\.ts` path allowlist, so the widened
 * `database-url-credentials` rule (mt#4963) does not fire on it.
 *
 * The classifier is a pure function of a string, which is why these tests need
 * no database and no patching — the sweep's IO lives in `main()` behind an
 * `import.meta.main` guard.
 */

import { describe, test, expect } from "bun:test";
import {
  classifySecret,
  decideOutcome,
  scanText,
  entropy,
  caseMix,
} from "./classify-empty-half-postgres-urls";

/**
 * A NON-placeholder host, so these cases exercise the secret half rather than
 * the host rule. The first draft used `db.internal.example.net` and every case
 * that relied on it silently classified `synthetic` — `example.net` is a
 * reserved example domain, so the host rule was firing and the secret was never
 * being scored at all. Five tests failed for one fixture reason.
 */
const CTX = "postgresql://:X@prod-db-7f2a.internal:5432/minsky";

/** A credential-shaped fixture. Synthetic; reused so it is not a magic string. */
const REAL_SHAPED = "aB3xK9mQ7pL2vN4t";

describe("classifySecret", () => {
  describe("synthetic — placeholder vocabulary", () => {
    for (const word of ["password", "pass", "secret", "hunter2", "changeme", "fakepassword"]) {
      test(`"${word}" is a placeholder, not a credential`, () => {
        expect(classifySecret(word, CTX)).toBe("synthetic");
      });
    }
  });

  describe("synthetic — an example HOST makes the whole URL an example", () => {
    // This is the case that matters most for this corpus: docs and specs write
    // a realistic-looking secret against localhost or example.com. The secret
    // half alone would score as real-shaped; the host is what settles it.
    for (const host of [
      "postgresql://:aB3xK9mQ7pL2@localhost:5432/db",
      "postgresql://:aB3xK9mQ7pL2@127.0.0.1:5432/db",
      "postgresql://:aB3xK9mQ7pL2@db.example.com:5432/db",
      "postgresql://:aB3xK9mQ7pL2@db.example.invalid:5432/db",
    ]) {
      test(`example host wins over a high-entropy secret: ${host.split("@")[1]}`, () => {
        expect(classifySecret("aB3xK9mQ7pL2", host)).toBe("synthetic");
      });
    }
  });

  describe("synthetic — template markers", () => {
    for (const tpl of ["<password>", "${DB_PASSWORD}", "***", "[REDACTED]"]) {
      test(`"${tpl}" is a template, not a value`, () => {
        expect(classifySecret(tpl, CTX)).toBe("synthetic");
      });
    }
  });

  describe("real-shaped — the population that warrants escalation", () => {
    test("mixed-case alphanumeric of credential length", () => {
      expect(classifySecret(REAL_SHAPED, CTX)).toBe("real-shaped");
    });

    test("high-entropy base64-ish string", () => {
      expect(classifySecret("k3J8vQ2mZ9pX7wR4tY6uI1oP", CTX)).toBe("real-shaped");
    });

    // The verdict name is deliberately `real-shaped`, not `real`: the
    // discriminators did not fire, which is weaker than proof. The test asserts
    // the classification, not a claim about the world.
    test("a real-shaped verdict is a classification, not a proof of realness", () => {
      const v = classifySecret(REAL_SHAPED, CTX);
      expect(v).toBe("real-shaped");
      expect(["synthetic", "real-shaped", "undecidable"]).toContain(v);
    });
  });

  describe("undecidable — too short to discriminate", () => {
    test("a short non-placeholder string is not forced into either bucket", () => {
      expect(classifySecret("aB3x", CTX)).toBe("undecidable");
    });
  });

  describe("the placeholder-host rule matches a WHOLE host, not a prefix", () => {
    // Regression for the `\b` this replaced: the bare `db` alternative used to
    // match the start of a real hostname, so a genuine production database
    // classified as `synthetic`. That is the false-safe direction — the one
    // that would quietly drop a real credential out of the escalation set.
    for (const host of [
      "postgresql://:aB3xK9mQ7pL2@db.internal:5432/minsky",
      "postgresql://:aB3xK9mQ7pL2@db.production.company.com:5432/minsky",
      "postgresql://:aB3xK9mQ7pL2@hostname.company.com:5432/minsky",
    ]) {
      test(`a real host whose name STARTS with a placeholder word is not synthetic: ${host.split("@")[1]}`, () => {
        expect(classifySecret("aB3xK9mQ7pL2", host)).not.toBe("synthetic");
      });
    }

    test("a bare `db` host IS still a placeholder (docker-compose service name)", () => {
      expect(classifySecret("aB3xK9mQ7pL2", "postgresql://:aB3xK9mQ7pL2@db:5432/minsky")).toBe(
        "synthetic"
      );
    });
  });

  describe("the uncertain direction defaults toward treating it as sensitive", () => {
    // A false `synthetic` on a real credential is the expensive error, so
    // anything not demonstrably a placeholder must NOT land in `synthetic`.
    test("an unrecognized long mixed-case string never classifies as synthetic", () => {
      expect(classifySecret("Zq7Lm2Xv9Kd4Rt8w", CTX)).not.toBe("synthetic");
    });
  });
});

/**
 * PR #3621 R1 (BLOCKING) — the regression that matters most in this file.
 *
 * The `classifySecret` tests above pass a FULL URL as `surroundingContext`. The
 * sweep did not: its regex stopped at the `@`, so it passed a fragment with no
 * host, and the placeholder-host rule was unreachable in every real scan. Both
 * sides were internally consistent and jointly wrong, and no amount of testing
 * `classifySecret` could have found it — the disagreement was BETWEEN the test
 * and the caller.
 *
 * So these exercise `scanText`, which is what the sweep actually calls, on the
 * raw text it actually sees. A test that constructs the classifier's argument
 * by hand cannot catch an argument-construction bug.
 */
describe("scanText — the caller's own path", () => {
  test("an example-host URL classifies synthetic THROUGH the scan, not just the classifier", () => {
    const matches = scanText('DATABASE_URL="postgresql://:aB3xK9mQ7pL2@db.example.com:5432/mydb"');
    expect(matches).toHaveLength(1);
    expect(matches[0]?.verdict).toBe("synthetic");
  });

  test("localhost too — the case the fragment bug silently misclassified", () => {
    const matches = scanText("connect to postgresql://:aB3xK9mQ7pL2@localhost:5432/dev");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.verdict).toBe("synthetic");
  });

  test("a real host still reaches real-shaped through the scan", () => {
    const matches = scanText(`postgresql://:${REAL_SHAPED}@prod-db-7f2a.internal:5432/minsky`);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.verdict).toBe("real-shaped");
  });

  test("finds the empty-PASSWORD form as well as the empty-username one", () => {
    const matches = scanText(
      "a postgresql://:aB3xK9mQ7pL2@prod-a.internal/db b postgresql://someuser:@prod-b.internal/db"
    );
    expect(matches).toHaveLength(2);
  });

  test("a credential-less URL produces no match at all", () => {
    expect(scanText("postgresql://prod-db.internal:5432/minsky")).toHaveLength(0);
  });

  test("every match carries a correlator and never the value", () => {
    const secret = REAL_SHAPED;
    const matches = scanText(`postgresql://:${secret}@prod-db-7f2a.internal:5432/minsky`);
    expect(matches[0]?.correlator).toMatch(/^[0-9a-f]{12}$/);
    expect(matches[0]?.correlator).not.toContain(secret);
  });
});

describe("decideOutcome", () => {
  test("escalates when anything is real-shaped, regardless of the rest", () => {
    expect(decideOutcome(1, 0)).toBe("escalate");
    expect(decideOutcome(1, 99)).toBe("escalate");
  });

  // The case this function was extracted for. The first version of the script
  // printed "nothing to re-scrub / no operator action is indicated" whenever
  // real-shaped was 0 — while the live run had 62 undecidable matches. That is
  // a clean bill of health the evidence did not support, and it is silent, so
  // nothing downstream would have questioned it.
  test("does NOT report clean when real-shaped is 0 but matches are undecidable", () => {
    expect(decideOutcome(0, 62)).toBe("inconclusive");
    expect(decideOutcome(0, 1)).toBe("inconclusive");
  });

  test("clean requires BOTH zero real-shaped and zero undecidable", () => {
    expect(decideOutcome(0, 0)).toBe("clean");
  });
});

describe("entropy", () => {
  test("returns 0 for the empty string rather than NaN", () => {
    expect(entropy("")).toBe(0);
  });

  test("a single repeated character carries no information", () => {
    expect(entropy("aaaaaaaa")).toBe(0);
  });

  test("a mixed string scores above a repeated one", () => {
    expect(entropy("aB3xK9mQ")).toBeGreaterThan(entropy("aaaaaaaa"));
  });
});

describe("caseMix", () => {
  test("true only when lower, upper AND digit are all present", () => {
    expect(caseMix("aB3")).toBe(true);
    expect(caseMix("ab3")).toBe(false);
    expect(caseMix("aB")).toBe(false);
    expect(caseMix("AB3")).toBe(false);
  });
});
