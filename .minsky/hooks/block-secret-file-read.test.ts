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
  filePathCandidates,
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

/** The canonical emitting read of Minsky's own config — used by several suites. */
const CAT_MINSKY_CONFIG = "cat ~/.config/minsky/config.yaml";

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
  const hits = findSecretReads(CAT_MINSKY_CONFIG);

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

describe("mt#3703 — the two false-positive classes", () => {
  // Every command here is a REAL denial, not a constructed one. The first two are
  // the ones mt#3703 was filed for; the second two happened while fixing it, on
  // this guard's own files.
  describe("a grep PATTERN is not a file path", () => {
    test("AT1: grepping a source file for a credential-shaped identifier is allowed", () => {
      expect(
        findSecretReads("grep -n 'CredentialRead' packages/domain/src/notify/principal-channel.ts")
      ).toEqual([]);
    });

    test("a pattern naming the guard's own vocabulary is allowed", () => {
      // Denied live on 2026-08-10 while planning this task: the guard blocked a
      // grep over its OWN source because the search pattern said "credential"
      // and "SECRET".
      expect(
        findSecretReads(
          "grep -n 'credential\\|Credential\\|SECRET' .minsky/hooks/block-secret-file-read.ts"
        )
      ).toEqual([]);
    });

    test("but a secret path as the FILE argument is still denied", () => {
      const hits = findSecretReads("grep -n 'anything' ~/.aws/credentials");
      expect(hits.length).toBe(1);
      expect(hits[0]?.path).toContain("credentials");
    });

    test("-e moves the pattern into the flag, so no argument is skipped", () => {
      const hits = findSecretReads("grep -e 'anything' ~/.aws/credentials");
      expect(hits.length).toBe(1);
    });

    test("a non-grep reader has no pattern argument, so every token is a file", () => {
      expect(findSecretReads("cat credentials").length).toBe(1);
    });
  });

  describe("a credentials/ DIRECTORY does not condemn the source file inside it", () => {
    test("AT2: a provider implementation under credentials/ is allowed", () => {
      expect(
        findSecretReads(
          "grep -n 'resolveInfraDir' packages/domain/src/credentials/providers/telegram.ts"
        )
      ).toEqual([]);
    });

    test("this guard's own test file is readable", () => {
      // Also denied live on 2026-08-10 — here the FILENAME matched, not the
      // pattern, so it is a distinct class from the block above.
      expect(findSecretReads("cat .minsky/hooks/block-secret-file-read.test.ts")).toEqual([]);
    });

    test("a data file under a secrets/ directory is still denied", () => {
      // The carve-out is about the FILE's extension, not the directory: this is
      // what keeps the narrowing from becoming a coverage hole.
      expect(findSecretReads("cat secrets/prod.yaml").length).toBe(1);
    });

    test("a credential-named data file is still denied", () => {
      expect(findSecretReads("cat my-credentials.json").length).toBe(1);
    });
  });

  describe("AT3/AT4 — the known-secret set still denies", () => {
    test.each([
      [CAT_MINSKY_CONFIG, "config.yaml"],
      ["cat .env", ".env"],
      ["cat .env.production", ".env.production"],
      ["cat ~/.aws/credentials", "credentials"],
      ["cat ~/.netrc", ".netrc"],
      ["cat ~/.npmrc", ".npmrc"],
      ["cat ~/.pgpass", ".pgpass"],
      ["cat ~/.ssh/id_rsa", "id_rsa"],
      ["cat server.pem", ".pem"],
    ])("%s is still denied", (command, expectedPath) => {
      const hits = findSecretReads(command);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.path).toContain(expectedPath);
    });

    test("an explicit pattern denies even with a source-code extension", () => {
      // The carve-out is scoped to the GENERIC name-resemblance pattern only.
      // A `.pem` is matched explicitly and is unaffected by extension logic.
      expect(findSecretReads("cat key.pem").length).toBe(1);
    });
  });

  describe("isSecretPath — the discriminator in isolation", () => {
    test("source extensions escape only the generic pattern", () => {
      expect(isSecretPath("src/credentials/providers/telegram.ts")).toBe(false);
      expect(isSecretPath("src/credentials/providers/telegram.js")).toBe(false);
      expect(isSecretPath("secrets/prod.yaml")).toBe(true);
      expect(isSecretPath("credentials")).toBe(true);
    });

    test("a bare identifier that merely mentions credentials is not a path", () => {
      expect(isSecretPath("CredentialRead.ts")).toBe(false);
    });
  });

  describe("filePathCandidates", () => {
    test("drops the pattern for grep-family readers", () => {
      expect(filePathCandidates("grep", ["grep", "-n", "pattern", "file.ts"])).toEqual([
        "-n",
        "file.ts",
      ]);
    });

    test("keeps every argument for non-conditional readers", () => {
      expect(filePathCandidates("cat", ["cat", "a", "b"])).toEqual(["a", "b"]);
    });

    test("keeps every argument when -e supplies the pattern", () => {
      expect(filePathCandidates("grep", ["grep", "-e", "p", "file.ts"])).toEqual([
        "-e",
        "p",
        "file.ts",
      ]);
    });

    test("a pattern-only grep (reading stdin) drops it and finds no file", () => {
      expect(filePathCandidates("grep", ["grep", "credentials"])).toEqual([]);
    });
  });
});
