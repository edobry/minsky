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
  findSecretScriptInvocation,
  findSecretScriptInvocations,
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
  SECRET_EMITTING_SCRIPT_PATTERNS,
  findProcessListingReads,
  splitPipelines,
  psRequestsArgv,
  isArgvBearingProcessListing,
  isNonEmittingSink,
  findSecretDumpingCliReads,
  isSecretDumpingCliInvocation,
  isKeyOnlyJqStage,
  positionalArgs,
  SECRET_DUMPING_CLI_SPECS,
  isUnderSourceRoot,
} from "./block-secret-file-read";
import type { ToolHookInput } from "./types";
import type { DispatchContext } from "./registry";

/** The exact command from the mt#3282 R3 incident. */
const R3_COMMAND =
  "grep -rn 'connectionString\\|postgres://' ~/.config/minsky/config.yaml | sed 's/postgres:\\/\\/.*/postgres:\\/\\/<redacted>/'";

const CTX = {} as DispatchContext;

/** The canonical emitting read of Minsky's own config — used by several suites. */
const CAT_MINSKY_CONFIG = "cat ~/.config/minsky/config.yaml";

/** The canonical value-dumping railway invocation (mt#4570), shared by its own
 *  block and mt#4581's untouched-siblings check. */
const RAILWAY_VARIABLES_JSON = "railway variables --json";

// ── Process listings (mt#3850) ──────────────────────────────────────────────

/**
 * The originating incident command, verbatim (2026-08-08, session ws#438): an
 * agent looking for a stuck git process. It names no secret and no path, and
 * it printed a live GitHub token carried by an unrelated `docker run` row.
 */
const PS_INCIDENT_COMMAND = "ps -eo pid,etime,command | grep -iE 'git|credential'";

// ── Vendor CLI env-var dumps (mt#4570) ──────────────────────────────────────

/**
 * The originating incident command, verbatim (2026-08-25): checking whether the
 * reviewer service still carried a Braintrust key. It names no secret path,
 * invokes no script, and requests no argv column — so all three prior checks
 * pass it — and it printed the production BRAINTRUST_API_KEY.
 */
const RAILWAY_INCIDENT_COMMAND = "railway variables --json";

/**
 * The SAFE form the agent tried FIRST, which failed on a wrong service name.
 * The whole point of the carve-out: if this denied, the guard would push
 * callers straight onto the unsafe form the incident used.
 */
const RAILWAY_SAFE_COMMAND = "railway variables --service minsky-reviewer --json | jq -r 'keys[]'";

/** A value-LESS global flag before the noun — must not consume the next token. */
const RAILWAY_VALUELESS_FLAG_COMMAND = "railway --json variable list";

describe("mt#4570 — vendor CLIs that dump env-var values", () => {
  test("denies the verbatim railway incident command", () => {
    const hits = findSecretDumpingCliReads(RAILWAY_INCIDENT_COMMAND);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("cli-env-dump");
    expect(hits[0]?.reader).toBe("railway");
  });

  test("the incident command is invisible to all three prior checks", () => {
    // This is the whole justification for a fourth check rather than widening
    // one of the existing three. If any of these starts returning hits, this
    // check may be redundant — that is worth knowing.
    expect(findSecretReads(RAILWAY_INCIDENT_COMMAND)).toEqual([]);
    expect(findSecretScriptInvocations(RAILWAY_INCIDENT_COMMAND)).toEqual([]);
    expect(findProcessListingReads(RAILWAY_INCIDENT_COMMAND)).toEqual([]);
  });

  test("denies every spelling of the listing command", () => {
    // `railway variable` and `railway variables` are the same command; the
    // canonical form is `variable list` (alias `ls`); a bare noun lists too.
    // Verified against `railway variable --help`, 2026-08-25.
    for (const cmd of [
      "railway variables",
      "railway variable",
      "railway variable list",
      "railway variable ls",
      "railway variables list --json",
      "railway variable list -k",
      "railway variable list --kv",
      "railway variable list --service api --json",
      "railway --json variable list",
    ]) {
      expect(findSecretDumpingCliReads(cmd).length, cmd).toBeGreaterThan(0);
    }
  });

  test("allows a key-projecting jq pipeline — the recommended safe form", () => {
    for (const cmd of [
      RAILWAY_SAFE_COMMAND,
      "railway variable list --json | jq -r 'keys[]'",
      "railway variable list --json | jq 'keys'",
      "railway variable list --json | jq -r 'keys | length'",
      "railway variable list --json | jq -r 'keys_unsorted[]'",
      "railway variable list --json | jq -r '. | keys'",
    ]) {
      expect(findSecretDumpingCliReads(cmd), cmd).toEqual([]);
    }
  });

  test("allows a counting sink, same carve-out the ps check has", () => {
    for (const cmd of [
      "railway variable list --kv | grep -c BRAINTRUST",
      "railway variable list --kv | grep -q BRAINTRUST",
      "railway variable list --json | wc -l",
    ]) {
      expect(findSecretDumpingCliReads(cmd), cmd).toEqual([]);
    }
  });

  test("a jq filter that could render a VALUE is not a carve-out", () => {
    // Fail-closed: only the whitelisted key-projecting tokens suppress values.
    for (const cmd of [
      "railway variable list --json | jq -r '.BRAINTRUST_API_KEY'",
      "railway variable list --json | jq '.'",
      "railway variable list --json | jq -r 'to_entries[]'",
      "railway variable list --json | jq -r '.[]'",
      "railway variable list --json | jq -r 'keys[] as $k | .[$k]'",
    ]) {
      expect(findSecretDumpingCliReads(cmd).length, cmd).toBeGreaterThan(0);
    }
  });

  test("the suppressing stage may sit anywhere downstream", () => {
    // Once keys are projected, no later stage can resurrect the values —
    // mirrors findProcessListingReads' reducedDownstream rule.
    expect(
      findSecretDumpingCliReads("railway variable list --json | jq -r 'keys[]' | sort | tee out")
    ).toEqual([]);
  });

  test("leaves non-listing railway subcommands alone", () => {
    // Keyed on the value-dumping subcommand, not on the binary.
    for (const cmd of [
      "railway status",
      "railway whoami",
      "railway logs",
      "railway up",
      "railway variable set API_URL=https://example.com",
      "railway variable delete API_KEY",
      "railway variable rm API_KEY",
      "railway variable help",
    ]) {
      expect(findSecretDumpingCliReads(cmd), cmd).toEqual([]);
    }
  });

  test("a value-taking flag before the noun does not shift it out of position", () => {
    // PR #3336 R1 (BLOCKING): `filter(t => !t.startsWith("-"))` treats a flag's
    // VALUE as a positional, so the noun lands at index 1 and matches nothing —
    // a silent BYPASS, not a cosmetic parsing gap. Every value-taking flag from
    // `railway variable --help` is covered here, in both spellings.
    for (const cmd of [
      "railway -s api variable list",
      "railway --service api variable list",
      "railway -e production variable list",
      "railway --environment production variable list",
      "railway -p proj-id variable list",
      "railway --project proj-id variable list",
      "railway -s api -e production variable list",
      "railway --service api --json variables",
      // attached form: the value rides on the flag token, nothing to skip
      "railway --service=api variable list",
      // `--` ends flag parsing
      "railway --service api -- variable list",
    ]) {
      expect(findSecretDumpingCliReads(cmd).length, cmd).toBeGreaterThan(0);
    }
  });

  test("the flag-value skip does not swallow the noun itself", () => {
    // The inverse risk of the fix: over-consuming a token would make the guard
    // blind. A value-less flag must NOT eat the next token.
    expect(findSecretDumpingCliReads(RAILWAY_VALUELESS_FLAG_COMMAND).length).toBeGreaterThan(0);
    expect(findSecretDumpingCliReads("railway -k variable list").length).toBeGreaterThan(0);
    // ...and a safe verb is still reached through a value-taking flag.
    expect(findSecretDumpingCliReads("railway --service api variable set A=b")).toEqual([]);
  });

  test("positionalArgs skips flag values, not positionals", () => {
    const valueFlags = new Set(["-s", "--service"]);
    expect(positionalArgs(tokenize("railway -s api variable list"), valueFlags)).toEqual([
      "variable",
      "list",
    ]);
    expect(positionalArgs(tokenize("railway --service=api variable list"), valueFlags)).toEqual([
      "variable",
      "list",
    ]);
    expect(positionalArgs(tokenize(RAILWAY_VALUELESS_FLAG_COMMAND), valueFlags)).toEqual([
      "variable",
      "list",
    ]);
  });

  test("an unrecognised verb is treated as dumping (fail-closed)", () => {
    // safeVerbs is an allow-list on purpose: a subcommand this table has never
    // heard of is more likely a new read than a new write.
    expect(findSecretDumpingCliReads("railway variable dump").length).toBeGreaterThan(0);
  });

  test("leaves other programs alone", () => {
    for (const cmd of ["vercel env ls", "fly secrets list", "echo railway variables"]) {
      expect(findSecretDumpingCliReads(cmd), cmd).toEqual([]);
    }
  });

  test("sibling CLIs verified NOT to render values stay allowed", () => {
    // Each of these was checked against its own installed `--help` on
    // 2026-08-25 and does not emit a value; see the comment block above
    // SECRET_DUMPING_CLI_SPECS for the verbatim evidence. Pinned so a later
    // "while we're here" addition trips a test instead of shipping a guard
    // that denies a command which cannot leak.
    for (const cmd of [
      // digest only — "The actual value of the secret is only available to the application"
      "fly secrets list",
      "flyctl secrets list",
      // --json field set has no `value` — GitHub secrets are write-only
      "gh secret list",
      "gh secret ls",
      // renders `value`, but GitHub forbids storing a secret as a variable
      "gh variable list",
    ]) {
      expect(findSecretDumpingCliReads(cmd), cmd).toEqual([]);
    }
  });

  test("isSecretDumpingCliInvocation returns the matching spec", () => {
    const railwaySpec = SECRET_DUMPING_CLI_SPECS.find((s) => s.program === "railway");
    expect(railwaySpec).toBeDefined();
    expect(isSecretDumpingCliInvocation("railway", tokenize(RAILWAY_VARIABLES_JSON))).toBe(
      railwaySpec ?? null
    );
    expect(isSecretDumpingCliInvocation("railway", tokenize("railway status"))).toBeNull();
  });

  test("isKeyOnlyJqStage discriminates key projections from value reads", () => {
    expect(isKeyOnlyJqStage("jq", tokenize("jq -r 'keys[]'"))).toBe(true);
    expect(isKeyOnlyJqStage("jq", tokenize("jq 'keys'"))).toBe(true);
    expect(isKeyOnlyJqStage("jq", tokenize("jq -r '.SOME_KEY'"))).toBe(false);
    expect(isKeyOnlyJqStage("jq", tokenize("jq -r"))).toBe(false);
    expect(isKeyOnlyJqStage("grep", tokenize("grep -c x"))).toBe(false);
  });

  test("a filter of only pass-through tokens does not reduce (regression)", () => {
    // Caught by this suite during authoring: `.` is permitted as a pass-through
    // inside `. | keys`, so an allow-list alone accepted `jq '.'` — which
    // renders the whole object, values included. A key-projecting filter must
    // contain a token that actually DISCARDS values.
    expect(isKeyOnlyJqStage("jq", tokenize("jq '.'"))).toBe(false);
    expect(isKeyOnlyJqStage("jq", tokenize("jq -r '. | sort'"))).toBe(false);
    expect(isKeyOnlyJqStage("jq", tokenize("jq -r '. | keys'"))).toBe(true);
  });

  test("fires through findInToolInput and renders a denial naming the safe form", () => {
    const hits = findInToolInput({ command: RAILWAY_INCIDENT_COMMAND });
    expect(hits.some((h) => h.kind === "cli-env-dump")).toBe(true);

    const reason = buildDenialReason(hits);
    expect(reason).toContain("prints every variable WITH its value");
    expect(reason).toContain("jq -r 'keys[]'");
    // The denial must teach the probe-degradation lesson, not just refuse.
    expect(reason).toContain("do NOT re-run it without the filter");
  });

  test("the override covers this check like its three siblings", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: RAILWAY_INCIDENT_COMMAND },
    } as unknown as ToolHookInput;

    expect(run(input, CTX)?.deny).toBeDefined();

    const prev = process.env[OVERRIDE_ENV_VAR];
    process.env[OVERRIDE_ENV_VAR] = "1";
    try {
      expect(run(input, CTX)?.deny).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env[OVERRIDE_ENV_VAR];
      else process.env[OVERRIDE_ENV_VAR] = prev;
    }
  });
});

describe("mt#3850 — process listings that print argv", () => {
  test("denies the verbatim incident command", () => {
    const hits = findProcessListingReads(PS_INCIDENT_COMMAND);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.kind).toBe("process-listing");
    expect(hits[0]?.reader).toBe("ps");
  });

  test("fires on every argv-bearing form named in the spec", () => {
    for (const cmd of [
      "ps -eo command",
      "ps aux",
      "ps -ef",
      "ps",
      "ps -eo pid,command",
      "ps -eo args",
    ]) {
      expect(findProcessListingReads(cmd).length, cmd).toBeGreaterThan(0);
    }
  });

  test("does not fire on column-restricted forms", () => {
    for (const cmd of [
      "ps -eo pid,comm",
      "ps -eo pid,etime,comm",
      "ps -o comm=",
      "ps -eo pid,ucomm",
    ]) {
      expect(findProcessListingReads(cmd), cmd).toEqual([]);
    }
  });

  // PR #2996 R1 (BLOCKING): `ps` field entries carry a WIDTH (`command:80`)
  // and/or a HEADER (`command=CMD`), and both are still the argv column.
  // Stripping only `=` let `command:80` through as an unknown field name — a
  // false negative in the very check this suite exists for. Both modifier
  // forms are covered here, not just the one the reviewer cited.
  test("fires on argv fields carrying a width or header modifier", () => {
    for (const cmd of [
      "ps -eo command:80",
      "ps -eo pid,command:120",
      "ps -eo command=CMD",
      "ps -eo args:200=COMMAND",
      "ps -eo cmd:50",
    ]) {
      expect(findProcessListingReads(cmd).length, cmd).toBeGreaterThan(0);
    }
  });

  test("a modifier on a SAFE field stays safe", () => {
    for (const cmd of ["ps -eo comm:20", "ps -eo pid,comm:40=NAME"]) {
      expect(findProcessListingReads(cmd), cmd).toEqual([]);
    }
  });

  // PR #2996 R1 (non-blocking): once a stage reduces its input to a count, no
  // later stage can resurrect the argv, so the sink need not be LAST.
  test("permits a counting sink that is not the final stage", () => {
    for (const cmd of [
      "ps aux | grep -c docker | tee out",
      "ps -eo command | wc -l | cat",
      "ps -eo command | grep -q gho_ && echo found",
    ]) {
      expect(findProcessListingReads(cmd), cmd).toEqual([]);
    }
  });

  test("still denies when nothing downstream reduces the output", () => {
    expect(findProcessListingReads("ps aux | grep docker | tee out").length).toBeGreaterThan(0);
  });

  // The guard must not deny the form its own rule recommends. A counting sink
  // renders no row, so the argv never reaches the transcript.
  test("permits an argv listing whose pipeline ends in a counting sink", () => {
    for (const cmd of [
      "ps -eo command | grep -c gho_",
      "ps -eo command | grep -q GITHUB_PERSONAL_ACCESS_TOKEN",
      "ps -eo command | wc -l",
      "ps aux | grep -c docker",
    ]) {
      expect(findProcessListingReads(cmd), cmd).toEqual([]);
    }
  });

  test("still denies when the pipeline ends in an EMITTING consumer", () => {
    for (const cmd of ["ps -eo command | grep gho_", "ps aux | head -5", "ps -ef | sort"]) {
      expect(findProcessListingReads(cmd).length, cmd).toBeGreaterThan(0);
    }
  });

  test("top and pgrep fire only in their argv-printing forms", () => {
    expect(findProcessListingReads("top -c").length).toBeGreaterThan(0);
    expect(findProcessListingReads("top")).toEqual([]);
    expect(findProcessListingReads("pgrep -a docker").length).toBeGreaterThan(0);
    expect(findProcessListingReads("pgrep -af docker").length).toBeGreaterThan(0);
    expect(findProcessListingReads("pgrep docker")).toEqual([]);
    expect(findProcessListingReads("pgrep -l docker")).toEqual([]);
  });

  test("psRequestsArgv fails CLOSED when no format is given", () => {
    // A bare `ps`/`ps aux`/`ps -ef` prints the command line by default, so the
    // ABSENCE of an explicit field list must read as argv-bearing.
    expect(psRequestsArgv(tokenize("ps aux"))).toBe(true);
    expect(psRequestsArgv(tokenize("ps -eo pid,comm"))).toBe(false);
    expect(psRequestsArgv(tokenize("ps -eopid,command"))).toBe(true);
    expect(psRequestsArgv(tokenize("ps --format=pid,comm"))).toBe(false);
    expect(psRequestsArgv(tokenize("ps --format=pid,args"))).toBe(true);
  });

  test("isArgvBearingProcessListing ignores unrelated programs", () => {
    expect(isArgvBearingProcessListing("cat", tokenize("cat file"))).toBe(false);
    expect(isArgvBearingProcessListing("psql", tokenize("psql -c 'select 1'"))).toBe(false);
  });

  test("isNonEmittingSink recognises counting forms only", () => {
    expect(isNonEmittingSink("grep", tokenize("grep -c x"))).toBe(true);
    expect(isNonEmittingSink("grep", tokenize("grep x"))).toBe(false);
    expect(isNonEmittingSink("wc", tokenize("wc -l"))).toBe(true);
    expect(isNonEmittingSink("head", tokenize("head -5"))).toBe(false);
  });

  test("splitPipelines separates pipes from sequence operators", () => {
    expect(splitPipelines("a | b")).toEqual([["a", "b"]]);
    expect(splitPipelines("a && b")).toEqual([["a"], ["b"]]);
    // `||` must not be read as two pipes — that would merge separate pipelines.
    expect(splitPipelines("a || b")).toEqual([["a"], ["b"]]);
    expect(splitPipelines("a | b ; c")).toEqual([["a", "b"], ["c"]]);
    // A `|` inside quotes is data, not structure.
    expect(splitPipelines("grep -E 'git|cred' f")).toEqual([["grep -E 'git|cred' f"]]);
  });

  test("a sequence does not let one pipeline's sink excuse another", () => {
    // The counting sink belongs to the SECOND pipeline; the first still emits.
    const hits = findProcessListingReads("ps -eo command ; ps -eo command | grep -c x");
    expect(hits).toHaveLength(1);
  });

  test("the denial message names argv and teaches both safe forms", () => {
    const reason = buildDenialReason(findProcessListingReads("ps aux"));
    expect(reason).toContain("ARGV");
    expect(reason).toContain("ps -eo pid,etime,comm");
    expect(reason).toContain("grep -c");
    // It must NOT offer the file-read remedies for a process listing.
    expect(reason).not.toContain("test -f <file>");
  });

  test("run() denies an argv listing through the real tool-input path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: PS_INCIDENT_COMMAND },
    } as unknown as ToolHookInput;
    const outcome = run(input, CTX);
    expect(outcome?.deny).toBeDefined();
    expect(outcome?.deny?.reason).toContain("ARGV");
  });

  test("run() allows the counting form through the real tool-input path", () => {
    const input = {
      tool_name: "Bash",
      tool_input: { command: "ps -eo command | grep -c gho_" },
    } as unknown as ToolHookInput;
    expect(run(input, CTX)).toBeNull();
  });
});

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
    // mt#4159 — the read that printed a live bearer token into a transcript.
    "cat .mcp.json",
    "jq '.mcpServers' /Users/x/Projects/minsky/.mcp.json",
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
    // mt#4159. Matched by the EXPLICIT list, so the `.json` extension never
    // reaches `hasSourceCodeExtension` — the generic name pattern, which is
    // what that carve-out guards, does not fire on this name at all.
    expect(isSecretPath(".mcp.json")).toBe(true);
    expect(isSecretPath("/Users/x/Projects/minsky/.mcp.json")).toBe(true);
  });

  test("does not claim ordinary files", () => {
    expect(isSecretPath("package.json")).toBe(false);
    expect(isSecretPath("src/index.ts")).toBe(false);
    expect(isSecretPath("README.md")).toBe(false);
    expect(isSecretPath("tsconfig.json")).toBe(false);
    // The `.mcp.json` entry is anchored at a path separator, so a file that
    // merely ENDS in that name is not claimed.
    expect(isSecretPath("foo.mcp.json")).toBe(false);
    expect(isSecretPath("mcp.json")).toBe(false);
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

    test("-e supplies the pattern and the FILE is still checked", () => {
      const hits = findSecretReads("grep -e 'anything' ~/.aws/credentials");
      expect(hits.length).toBe(1);
    });

    test("a credential-shaped pattern passed via -e is allowed (PR #2778 R1)", () => {
      // R1 found the first version returning every argument when -e was present,
      // which reinstated the pattern-as-path false positive through the flag form.
      expect(
        findSecretReads("grep -e 'CredentialRead' packages/domain/src/notify/principal-channel.ts")
      ).toEqual([]);
      expect(
        findSecretReads(
          "grep --regexp='CredentialRead' packages/domain/src/notify/principal-channel.ts"
        )
      ).toEqual([]);
    });

    test("a directory argument is still checked when the pattern is skipped", () => {
      // The pattern is dropped, the remaining positional is not.
      expect(findSecretReads("grep -r anything ~/.config/minsky/config.yaml").length).toBe(1);
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

    test("drops -e and its VALUE, keeping the file (PR #2778 R1)", () => {
      expect(filePathCandidates("grep", ["grep", "-e", "p", "file.ts"])).toEqual(["file.ts"]);
    });

    test("drops an attached --regexp= pattern", () => {
      expect(filePathCandidates("grep", ["grep", "--regexp=p", "file.ts"])).toEqual(["file.ts"]);
    });

    test("keeps a non-pattern flag token", () => {
      // Flags are NOT dropped wholesale: `--include=<glob>` selects which files
      // grep reads, so its value must stay reachable by the path matcher.
      expect(filePathCandidates("grep", ["grep", "-r", "--include=x", "p", "dir"])).toContain(
        "--include=x"
      );
    });

    test("with -e present, the first positional is a FILE, not the pattern", () => {
      // The positional-skip must not also fire, or the real file is dropped.
      expect(filePathCandidates("grep", ["grep", "-e", "p", "a.ts", "b.ts"])).toEqual([
        "a.ts",
        "b.ts",
      ]);
    });

    test("a pattern-only grep (reading stdin) drops it and finds no file", () => {
      expect(filePathCandidates("grep", ["grep", "credentials"])).toEqual([]);
    });
  });
});

describe("mt#4581 — a SOURCE directory argument is not a secret path", () => {
  // mt#3703 rescued the source FILE by its extension; a directory argument has
  // none, so `packages/domain/src/credentials/` still denied. These pin both
  // directions of the fix — the false positive removed, and the coverage hole a
  // prefix-only carve-out would have opened.

  /** The command denied verbatim on 2026-08-25, during mt#4486's implementation. */
  const DENIED_VERBATIM =
    "grep -rn 'parentTaskId' --include='*.test.ts' " +
    "src/adapters/shared/commands/config/ packages/domain/src/credentials/";

  describe("AT1 — the regression case", () => {
    test("the exact denied command is permitted", () => {
      expect(findSecretReads(DENIED_VERBATIM)).toEqual([]);
    });

    test("the same directory without an --include filter is permitted", () => {
      // SC1 says "whether or not it carries an --include filter" — the filter
      // was incidental to the denial, so pin the bare form too.
      expect(findSecretReads("grep -rn 'x' packages/domain/src/credentials/")).toEqual([]);
    });

    test("a leading ./ is tolerated", () => {
      expect(findSecretReads("grep -rn 'x' ./packages/domain/src/credentials/")).toEqual([]);
    });
  });

  describe("AT2 — the positive control", () => {
    test("a real secret file still denies", () => {
      // Without this, the fix would pass just as well if the whole check were
      // disabled.
      expect(findSecretReads(CAT_MINSKY_CONFIG).length).toBe(1);
    });
  });

  describe("AT3 — negative controls: a DATA file under a source root still denies", () => {
    // The hole a prefix-only carve-out would have opened. Neither case is
    // covered by mt#3703's bare `secrets/prod.yaml` test, which carries no
    // source-root prefix and so would have kept passing over the hole.
    test.each([
      ["cat packages/domain/src/secrets/prod.yaml", "prod.yaml"],
      ["grep -rn 'x' src/credentials/fixtures/creds.json", "creds.json"],
      ["cat services/reviewer/src/secrets/token.txt", "token.txt"],
    ])("%s still denies", (command, expectedPath) => {
      const hits = findSecretReads(command);
      expect(hits.length).toBe(1);
      expect(hits[0]?.path).toContain(expectedPath);
    });

    test("the explicit list still denies from under a source root", () => {
      // The carve-out narrows GENERIC_SECRET_NAME_PATTERN alone; the explicit
      // patterns are evaluated first and are unaffected (SC3).
      expect(findSecretReads("cat src/foo/.env").length).toBe(1);
      expect(findSecretReads("cat packages/domain/src/credentials/key.pem").length).toBe(1);
    });
  });

  describe("AT4 — mt#3703's behaviour is unregressed", () => {
    test("a source file under credentials/ is still permitted", () => {
      expect(findSecretReads("grep -rn 'x' packages/domain/src/credentials/lifecycle.ts")).toEqual(
        []
      );
    });

    test("a data file under a NON-source secrets/ directory still denies", () => {
      expect(findSecretReads("cat secrets/prod.yaml").length).toBe(1);
    });
  });

  describe("isUnderSourceRoot — the discriminator in isolation", () => {
    test("matches a repo-relative path rooted at a source root", () => {
      expect(isUnderSourceRoot("packages/domain/src/credentials/")).toBe(true);
      expect(isUnderSourceRoot("src/credentials/")).toBe(true);
      expect(isUnderSourceRoot("scripts/foo/")).toBe(true);
      expect(isUnderSourceRoot("./services/reviewer/src/")).toBe(true);
    });

    test("a directory merely PREFIXED with a root's name does not qualify", () => {
      expect(isUnderSourceRoot("services-archive/credentials/")).toBe(false);
      expect(isUnderSourceRoot("srcfoo/credentials/")).toBe(false);
    });

    test("a token naming no source root does not qualify", () => {
      expect(isUnderSourceRoot("docs/credentials/")).toBe(false);
      expect(isUnderSourceRoot("~/.config/minsky/")).toBe(false);
    });

    test("PR #3364 R1 — an INTERIOR source-root segment does not qualify", () => {
      // The carve-out belongs to this repo's top-level roots. Matching
      // `(^|/)<root>/` anywhere would have carved out real secret paths that
      // merely happen to contain such a segment.
      expect(isUnderSourceRoot("/var/secrets/services/credentials")).toBe(false);
      expect(isUnderSourceRoot("~/.config/app/src/credentials")).toBe(false);
      expect(isUnderSourceRoot("/etc/secrets/packages/credential-store")).toBe(false);
    });
  });

  describe("isSecretPath — the discriminator in isolation", () => {
    test("a source-tree directory escapes only the generic pattern", () => {
      expect(isSecretPath("packages/domain/src/credentials/")).toBe(false);
      expect(isSecretPath("packages/domain/src/credentials")).toBe(false);
      // ...but a data extension under the same root does not escape.
      expect(isSecretPath("packages/domain/src/secrets/prod.yaml")).toBe(true);
    });

    test("the accepted residuals still match", () => {
      // Named in the spec's "Known residual, accepted" — widening the root list
      // is a separate change with its own false-positive surface.
      expect(isSecretPath("docs/credentials/")).toBe(true);
      // ...and, since PR #3364 R1, an ABSOLUTE path into repo source. Denying a
      // legitimate read is the safe direction; carving out every interior
      // `/services/` was not.
      expect(isSecretPath("/Users/e/sessions/abc/packages/domain/src/credentials/")).toBe(true);
    });

    test("PR #3364 R1 — a real secret path with an interior source-root name still denies", () => {
      // End-to-end through the guard, not just the helper: these are the paths
      // the over-broad first version would have permitted outright.
      expect(findSecretReads("cat /var/secrets/services/credentials").length).toBe(1);
      expect(findSecretReads("cat ~/.config/app/src/credentials").length).toBe(1);
    });
  });

  describe("the other three checks are untouched", () => {
    test("the secret-emitting script check still denies", () => {
      expect(findSecretScriptInvocations("bun scripts/drizzle-config-loader.ts").length).toBe(1);
    });

    test("the argv-column process listing still denies", () => {
      expect(findProcessListingReads("ps -eo command").length).toBe(1);
    });

    test("the vendor-CLI env dump still denies", () => {
      expect(findSecretDumpingCliReads(RAILWAY_VARIABLES_JSON).length).toBe(1);
    });
  });
});

describe("mt#4017 — script invocations (command-OUTPUT shape, R4)", () => {
  // Shared constants (custom/no-magic-string-duplication): the loader's path
  // in its two conventional forms, and the canonical invocation command.
  const LOADER_REL = "scripts/drizzle-config-loader.ts";
  const LOADER_DOT_REL = `./${LOADER_REL}`;
  const BUN_LOADER_CMD = `bun ${LOADER_DOT_REL}`;
  const SCRIPT_INVOCATION_KIND = "script-invocation";

  // AT3: attempt the guard's covered invocation → denied, with the denial
  // naming a non-emitting alternative.
  describe("findSecretScriptInvocations — direct invocations are denied", () => {
    const denied = [
      BUN_LOADER_CMD,
      `bun ${LOADER_REL}`,
      `bunx ${LOADER_REL}`,
      `node ${LOADER_REL}`,
      `ts-node ${LOADER_REL}`,
      LOADER_DOT_REL,
      LOADER_REL,
    ];
    for (const cmd of denied) {
      test(`denies: ${cmd}`, () => {
        const hits = findSecretScriptInvocations(cmd);
        expect(hits.length).toBe(1);
        expect(hits[0]?.kind).toBe(SCRIPT_INVOCATION_KIND);
        expect(hits[0]?.path).toContain(LOADER_REL);
      });
    }

    test("denied even with the sanctioned gate env var set inline", () => {
      // There is no safe way to invoke it directly, per the guard's own
      // denial text — setting the gate var in the command itself does not
      // exempt it, since the guard fires before the process even starts.
      const hits = findSecretScriptInvocations(`MINSKY_DRIZZLE_LOADER_GATE=1 ${BUN_LOADER_CMD}`);
      expect(hits.length).toBe(1);
    });

    // PR #2898 review, non-blocking: a shell -c/-lc/-ic payload embeds the
    // invocation inside a string the outer tokenizer never inspects.
    describe("shell -c payloads are unwrapped and checked (PR #2898 non-blocking finding)", () => {
      const wrapped = [
        `bash -c "${BUN_LOADER_CMD}"`,
        `bash -lc '${BUN_LOADER_CMD}'`,
        `sh -c "${BUN_LOADER_CMD}"`,
        `zsh -ic "${BUN_LOADER_CMD}"`,
        `bash --command "${BUN_LOADER_CMD}"`,
      ];
      for (const cmd of wrapped) {
        test(`denies: ${cmd}`, () => {
          const hits = findSecretScriptInvocations(cmd);
          expect(hits.length).toBe(1);
          expect(hits[0]?.kind).toBe(SCRIPT_INVOCATION_KIND);
          expect(hits[0]?.path).toContain(LOADER_REL);
        });
      }

      test("an unrelated -c payload is unaffected", () => {
        expect(findSecretScriptInvocations('bash -c "echo hello"')).toEqual([]);
      });

      test("a shell with no -c flag at all is unaffected", () => {
        expect(findSecretScriptInvocations("bash script.sh")).toEqual([]);
      });
    });

    test("caught anywhere in a pipeline or sequence, not just the head", () => {
      const hits = findSecretScriptInvocations(`echo start && ${BUN_LOADER_CMD}`);
      expect(hits.length).toBe(1);
      expect(hits[0]?.reader).toBe("bun");
    });

    test("sudo/env-assignment prefixes do not evade it", () => {
      expect(findSecretScriptInvocations(`sudo bun ${LOADER_REL}`).length).toBe(1);
    });
  });

  describe("ordinary drizzle-kit / DB-check commands are unaffected", () => {
    const allowed = [
      // The sanctioned caller invokes the loader via a Node/Bun SUBPROCESS
      // (execSync) from inside a drizzle-kit process — never a Bash/
      // session_exec tool call, so these never reach the guard at all. The
      // commands below are what an AGENT actually types, and none of them
      // name the loader script.
      "bun run db:generate:pg",
      "bunx --yes drizzle-kit generate --config ./drizzle.pg.config.ts",
      "bun run db:migrate:apply",
      "bun run src/cli.ts persistence check",
      "bun test drizzle.pg.config.test.ts",
      // Reading the SOURCE of the loader (not invoking it) is unaffected —
      // this is the file-read check's own source-extension carve-out, and
      // it is unrelated to the new script-invocation check.
      `cat ${LOADER_REL}`,
      `grep -n GATE_ENV_VAR ${LOADER_REL}`,
      // A DIFFERENT script that merely mentions the loader by name in a
      // comment/string is not itself the loader.
      "bun scripts/verify-npm-pack-install.ts",
    ];
    for (const cmd of allowed) {
      test(`allows: ${cmd}`, () => {
        expect(findSecretScriptInvocations(cmd)).toEqual([]);
      });
    }
  });

  describe("findSecretScriptInvocation — the discriminator in isolation", () => {
    test("matches an interpreter-prefixed invocation", () => {
      expect(findSecretScriptInvocation("bun", ["bun", LOADER_DOT_REL])).toBe(LOADER_DOT_REL);
    });

    test("matches direct execution via the script's own shebang", () => {
      expect(findSecretScriptInvocation(LOADER_REL, [LOADER_REL])).toBe(LOADER_REL);
    });

    test("returns null for an unrelated script", () => {
      expect(findSecretScriptInvocation("bun", ["bun", "scripts/smoke-setup-db.ts"])).toBeNull();
    });

    test("SECRET_EMITTING_SCRIPT_PATTERNS names the loader", () => {
      expect(SECRET_EMITTING_SCRIPT_PATTERNS.some((re) => re.test(LOADER_REL))).toBe(true);
    });
  });

  describe("buildDenialReason — the script-invocation branch", () => {
    const hits = findSecretScriptInvocations(BUN_LOADER_CMD);

    test("names the blocked invocation", () => {
      expect(buildDenialReason(hits)).toContain(LOADER_REL);
    });

    test("names the non-emitting alternative (AT3)", () => {
      expect(buildDenialReason(hits)).toContain("persistence check");
    });

    test("does not pull in the file-read-only redaction warning", () => {
      // That guidance is specific to a file-read hit and would be
      // misleading advice for a script that always prints by design.
      expect(buildDenialReason(hits)).not.toContain("redaction");
    });

    test("names the override", () => {
      expect(buildDenialReason(hits)).toContain(OVERRIDE_ENV_VAR);
    });
  });

  describe("run() — dispatcher entry point denies the script invocation", () => {
    function hookInput(toolName: string, toolInput: Record<string, unknown>) {
      return {
        session_id: "block-secret-file-read-test",
        cwd: "/test/cwd",
        hook_event_name: "PreToolUse",
        tool_name: toolName,
        tool_input: toolInput,
      } as import("./types").ToolHookInput;
    }
    const CTX = {} as import("./registry").DispatchContext;

    test("denies a direct loader invocation via Bash", () => {
      const prev = process.env[OVERRIDE_ENV_VAR];
      delete process.env[OVERRIDE_ENV_VAR];
      try {
        const out = run(hookInput("Bash", { command: BUN_LOADER_CMD }), CTX);
        expect(out?.deny).toBeDefined();
        expect(out?.deny?.reason).toContain("persistence check");
      } finally {
        if (prev !== undefined) process.env[OVERRIDE_ENV_VAR] = prev;
      }
    });

    test("denies via session_exec the same way as Bash", () => {
      const prev = process.env[OVERRIDE_ENV_VAR];
      delete process.env[OVERRIDE_ENV_VAR];
      try {
        const out = run(
          hookInput("mcp__minsky__session_exec", {
            command: `bun ${LOADER_REL}`,
            task: "mt#4017",
          }),
          CTX
        );
        expect(out?.deny).toBeDefined();
      } finally {
        if (prev !== undefined) process.env[OVERRIDE_ENV_VAR] = prev;
      }
    });

    test("the shared override allows it and leaves an audit line", () => {
      const prev = process.env[OVERRIDE_ENV_VAR];
      process.env[OVERRIDE_ENV_VAR] = "1";
      try {
        const out = run(hookInput("Bash", { command: BUN_LOADER_CMD }), CTX);
        expect(out?.deny).toBeUndefined();
        expect(out?.auditLines?.[0]).toContain("OVERRIDE");
      } finally {
        if (prev === undefined) delete process.env[OVERRIDE_ENV_VAR];
        else process.env[OVERRIDE_ENV_VAR] = prev;
      }
    });

    test("an ordinary drizzle-kit command is unaffected", () => {
      const prev = process.env[OVERRIDE_ENV_VAR];
      delete process.env[OVERRIDE_ENV_VAR];
      try {
        const out = run(hookInput("Bash", { command: "bun run db:generate:pg" }), CTX);
        expect(out).toBeNull();
      } finally {
        if (prev !== undefined) process.env[OVERRIDE_ENV_VAR] = prev;
      }
    });
  });

  describe("findInToolInput — dedupes across both hit shapes", () => {
    test("a repeated identical script invocation counts once", () => {
      const hits = findInToolInput({
        command: `${BUN_LOADER_CMD} && ${BUN_LOADER_CMD}`,
      });
      expect(hits.length).toBe(1);
    });

    test("a file-read hit and a script-invocation hit in the same command both surface", () => {
      const hits = findInToolInput({
        command: `cat ~/.aws/credentials && ${BUN_LOADER_CMD}`,
      });
      expect(hits.length).toBe(2);
      const kinds = hits.map((h) => h.kind).sort();
      expect(kinds).toEqual(["file-read", SCRIPT_INVOCATION_KIND]);
    });
  });
});
