/**
 * Tests for the secret-file-read guard (mt#3282).
 *
 * The anchor case is the R3 command verbatim — the one that leaked a production
 * Postgres password on 2026-08-01. Everything else exists to pin the guard's
 * precision, because a guard that over-fires on ordinary file reads gets
 * overridden into irrelevance and then protects nothing.
 */
import { describe, test, expect } from "bun:test";
import {
  findSecretReads,
  findInToolInput,
  isSecretPath,
  isEmittingInvocation,
  splitSegments,
  tokenize,
  programOf,
  buildDenialReason,
  isOverrideSet,
  run,
  OVERRIDE_ENV_VAR,
} from "./block-secret-file-read";
import type { ToolHookInput } from "./types";
import type { DispatchContext } from "./registry";

/** The exact command from the mt#3282 R3 incident. */
const R3_COMMAND =
  "grep -rn 'connectionString\\|postgres://' ~/.config/minsky/config.yaml | sed 's/postgres:\\/\\/.*/postgres:\\/\\/<redacted>/'";

const CTX = {} as DispatchContext;

describe("R3 — the command that actually leaked", () => {
  test("denies the verbatim incident command", () => {
    const hits = findSecretReads(R3_COMMAND);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.reader).toBe("grep");
    expect(hits[0]?.path).toContain("config.yaml");
  });

  test("the downstream redaction does not rescue it", () => {
    // The whole point: a filter after the read is not a mitigation, because a
    // no-op filter is indistinguishable from a working one. The guard must fire
    // on the READ regardless of what follows in the pipeline.
    const withPerfectRedaction =
      "cat ~/.config/minsky/config.yaml | sed 's/postgresql:\\/\\/.*/REDACTED/'";
    expect(findSecretReads(withPerfectRedaction).length).toBeGreaterThan(0);
  });

  test("the safe form the denial message recommends is allowed", () => {
    expect(findSecretReads("grep -c connectionString ~/.config/minsky/config.yaml")).toEqual([]);
    expect(findSecretReads("grep -q connectionString ~/.config/minsky/config.yaml")).toEqual([]);
  });
});

describe("emitting readers on secret paths (denied)", () => {
  const denied = [
    "cat ~/.config/minsky/config.yaml",
    "head -20 .env",
    "tail -f .env.production",
    "less ~/.aws/credentials",
    "awk '{print $2}' ~/.netrc",
    "jq '.apiKey' secrets.json",
    "strings id_rsa",
    "cat server.pem",
    "sed -n '1,5p' .env.local",
    "cut -d= -f2 .env",
  ];
  for (const cmd of denied) {
    test(`denies: ${cmd}`, () => {
      expect(findSecretReads(cmd).length).toBeGreaterThan(0);
    });
  }
});

describe("precision — ordinary reads are untouched", () => {
  const allowed = [
    "cat README.md",
    "grep -rn TODO src/",
    "head -50 package.json",
    "jq '.name' package.json",
    "sed -n '1,10p' src/index.ts",
    "cat docs/architecture/adr-028-guard-hook-dispatcher-consolidation.md",
    // Names a secret path but does not emit its content.
    "ls -la ~/.config/minsky/config.yaml",
    "test -f .env && echo present",
    "wc -l ~/.config/minsky/config.yaml",
    "stat .env",
    "shasum ~/.aws/credentials",
    "rm .env.tmp",
    "cp .env.example .env",
    // A config file that is not a credential store.
    "cat tsconfig.json",
    "cat vite.config.ts",
  ];
  for (const cmd of allowed) {
    test(`allows: ${cmd}`, () => {
      expect(findSecretReads(cmd)).toEqual([]);
    });
  }
});

describe("path classification", () => {
  test("recognizes credential-bearing paths", () => {
    expect(isSecretPath("~/.config/minsky/config.yaml")).toBe(true);
    expect(isSecretPath("/Users/x/.config/minsky/config.yml")).toBe(true);
    expect(isSecretPath(".env")).toBe(true);
    expect(isSecretPath(".env.production")).toBe(true);
    expect(isSecretPath("~/.aws/credentials")).toBe(true);
    expect(isSecretPath("~/.netrc")).toBe(true);
    expect(isSecretPath("id_ed25519")).toBe(true);
    expect(isSecretPath("certs/server.pem")).toBe(true);
    expect(isSecretPath("my-credentials.json")).toBe(true);
    expect(isSecretPath("app-secrets.yaml")).toBe(true);
  });

  test("does not claim ordinary files", () => {
    expect(isSecretPath("package.json")).toBe(false);
    expect(isSecretPath("src/index.ts")).toBe(false);
    expect(isSecretPath("README.md")).toBe(false);
    expect(isSecretPath("tsconfig.json")).toBe(false);
    // `.env.example` is a template of NAMES, not values — but it still matches
    // the `.env.*` family. Documented as an accepted over-fire: the cost is one
    // override on a file nobody needs to cat, and carving it out would invite
    // `.env.example.real`-shaped evasion.
    expect(isSecretPath(".env.example")).toBe(true);
  });
});

describe("conditional readers", () => {
  test("grep emits by default", () => {
    expect(isEmittingInvocation("grep", ["grep", "-rn", "pat", ".env"])).toBe(true);
  });

  test("count/quiet/list flags make grep non-emitting", () => {
    expect(isEmittingInvocation("grep", ["grep", "-c", "pat", ".env"])).toBe(false);
    expect(isEmittingInvocation("grep", ["grep", "--count", "pat", ".env"])).toBe(false);
    expect(isEmittingInvocation("grep", ["grep", "-q", "pat", ".env"])).toBe(false);
    expect(isEmittingInvocation("grep", ["grep", "-l", "pat", ".env"])).toBe(false);
  });

  test("bundled short flags are recognized", () => {
    expect(isEmittingInvocation("grep", ["grep", "-rc", "pat", ".env"])).toBe(false);
    expect(isEmittingInvocation("grep", ["grep", "-rn", "pat", ".env"])).toBe(true);
  });

  test("unconditional readers ignore flags", () => {
    expect(isEmittingInvocation("cat", ["cat", "-n", ".env"])).toBe(true);
  });
});

describe("segment + token parsing", () => {
  test("splits pipelines and sequences", () => {
    expect(splitSegments("a | b && c ; d")).toEqual(["a", "b", "c", "d"]);
  });

  test("strips quotes from tokens", () => {
    expect(tokenize(`cat "my file.env"`)).toEqual(["cat", "my file.env"]);
  });

  test("programOf skips env assignments and prefixes", () => {
    expect(programOf(["FOO=bar", "cat", ".env"])).toBe("cat");
    expect(programOf(["sudo", "cat", ".env"])).toBe("cat");
    expect(programOf(["/usr/bin/cat", ".env"])).toBe("cat");
  });

  test("a secret read anywhere in a pipeline is caught, not just the head", () => {
    const hits = findSecretReads("echo start && cat ~/.aws/credentials");
    expect(hits.length).toBe(1);
    expect(hits[0]?.reader).toBe("cat");
  });
});

describe("denial message", () => {
  const hits = findSecretReads("cat ~/.config/minsky/config.yaml");

  test("names the blocked read", () => {
    expect(buildDenialReason(hits)).toContain("config.yaml");
  });

  test("warns against the redaction workaround — the R3 failure shape", () => {
    const reason = buildDenialReason(hits);
    expect(reason).toContain("redaction");
    expect(reason).toContain("UNCHANGED");
  });

  test("teaches the safe presence-check forms", () => {
    const reason = buildDenialReason(hits);
    expect(reason).toContain("grep -c");
    expect(reason).toContain("grep -q");
  });

  test("names the override", () => {
    expect(buildDenialReason(hits)).toContain(OVERRIDE_ENV_VAR);
  });
});

describe("run() — dispatcher entry point", () => {
  /**
   * Supplies the ToolHookInput fields these fixtures were omitting
   * (session_id / cwd / hook_event_name), which is why the bare `as` casts were
   * rejected as non-overlapping conversions once this file entered a typecheck
   * project. mt#2900.
   */
  function hookInput(toolName: string, toolInput: Record<string, unknown>): ToolHookInput {
    return {
      session_id: "block-secret-file-read-test",
      cwd: "/test/cwd",
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
    } as ToolHookInput;
  }

  const denyInput: ToolHookInput = hookInput("Bash", { command: R3_COMMAND });

  test("denies the incident command", () => {
    const prev = process.env[OVERRIDE_ENV_VAR];
    delete process.env[OVERRIDE_ENV_VAR];
    try {
      const out = run(denyInput, CTX);
      expect(out?.deny).toBeDefined();
      expect(out?.deny?.reason).toContain("credentials");
    } finally {
      if (prev !== undefined) process.env[OVERRIDE_ENV_VAR] = prev;
    }
  });

  test("allows an ordinary read", () => {
    const prev = process.env[OVERRIDE_ENV_VAR];
    delete process.env[OVERRIDE_ENV_VAR];
    try {
      const out = run(hookInput("Bash", { command: "cat README.md" }), CTX);
      expect(out).toBeNull();
    } finally {
      if (prev !== undefined) process.env[OVERRIDE_ENV_VAR] = prev;
    }
  });

  test("the override allows and leaves an audit line", () => {
    const prev = process.env[OVERRIDE_ENV_VAR];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      const out = run(denyInput, CTX);
      expect(out?.deny).toBeUndefined();
      expect(out?.auditLines?.[0]).toContain("OVERRIDE");
    } finally {
      if (prev === undefined) delete process.env[OVERRIDE_ENV_VAR];
      else process.env[OVERRIDE_ENV_VAR] = prev;
    }
  });

  test("scans session_exec input the same way as Bash", () => {
    const prev = process.env[OVERRIDE_ENV_VAR];
    delete process.env[OVERRIDE_ENV_VAR];
    try {
      const out = run(
        hookInput("mcp__minsky__session_exec", { command: "cat .env", task: "mt#3282" }),
        CTX
      );
      expect(out?.deny).toBeDefined();
    } finally {
      if (prev !== undefined) process.env[OVERRIDE_ENV_VAR] = prev;
    }
  });
});

describe("override parsing", () => {
  test("accepts affirmative spellings", () => {
    expect(isOverrideSet("1")).toBe(true);
    expect(isOverrideSet("true")).toBe(true);
    expect(isOverrideSet("TRUE")).toBe(true);
    expect(isOverrideSet("yes")).toBe(true);
  });

  test("rejects everything else", () => {
    expect(isOverrideSet(undefined)).toBe(false);
    expect(isOverrideSet("")).toBe(false);
    expect(isOverrideSet("0")).toBe(false);
    expect(isOverrideSet("false")).toBe(false);
  });
});

describe("findInToolInput dedupes repeated hits", () => {
  test("one entry per (reader, path) pair", () => {
    const hits = findInToolInput({
      command: "cat .env && cat .env",
    });
    expect(hits.length).toBe(1);
  });
});
