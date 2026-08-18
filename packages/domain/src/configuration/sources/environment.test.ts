/**
 * Tests for environment-variable -> configuration mappings.
 *
 * Specifically guards the persistence-config wiring that boots
 * PersistenceService on Minsky MCP startup. mt#1223: MINSKY_POSTGRES_URL did
 * not auto-map to persistence.postgres.connectionString; the explicit
 * environmentMappings entry is what makes hosted-MCP startup succeed.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  loadEnvironmentConfiguration,
  getEnvironmentConfiguration,
  HOOK_ONLY_ENV_VARS,
} from "./environment";

// ---------------------------------------------------------------------------
// mt#4221: this file's subject is which env vars the REGISTRY admits, so its
// verdict must not depend on which ones the operator happens to export.
//
// Every assertion below inspects config derived from the live `process.env`,
// and the generic `MINSKY_*` -> dot-path fallback turns ANY unregistered
// `MINSKY_FOO_BAR` into a top-level `foo` key. So a variable this file never
// mentions can redden it on a tree where nothing is wrong:
// `MINSKY_MCP_NOT_A_REAL_KNOB=1` derives `mcp.not.a.real.knob` and fails the
// hook-only leak assertion below with `polluted: [ "mcp" ]`.
//
// Not hypothetical — that is how mt#4217 was found, via a real
// MINSKY_MCP_MEMORY_CEILING_POLL_MS sitting in the operator's environment while
// CI (which does not set it) stayed green. Registering that one name fixed that
// one name; establishing a known baseline here removes the class.
//
// Each describe below still deletes and restores the specific keys it sets.
// Those are unaffected: this runs FIRST (outer beforeEach) and restores LAST
// (outer afterEach), so an inner block sees an already-clean slate and its own
// restore is a no-op against it.
//
// Scoped to `MINSKY_*` deliberately. The non-MINSKY entries in
// `environmentMappings` (GITHUB_TOKEN, OPENAI_API_KEY, ...) are EXPLICIT
// mappings onto declared schema paths, so they cannot mint an unexpected
// top-level key the way the generic fallback can — only the `MINSKY_*` path
// derives a path nobody declared.
//
// Do NOT remove this as incidental setup. Without it this file asserts the
// machine it runs on as much as the registry it is about (mem#912: assert what
// the change owns, not the ambient state that reveals it).
//
// WHY A GLOBAL MUTATION IS SAFE HERE (PR #3081 R1). These hooks delete real
// variables — including the MINSKY_STATE_DIR / MINSKY_LOG_LEVEL / MINSKY_LOG_MODE
// that `tests/setup.ts` sets — for the duration of each test body. That would be
// a cross-file race if anything else could observe `process.env` during that
// window. Nothing can, under either concurrency mode bun offers:
//
//   - `--parallel` runs test FILES in worker processes and, per `bun test
//     --help`, "Implies --isolate". Separate processes have separate
//     environments, so a sibling file cannot see this file's mutation at all.
//   - `--concurrent` / `test.concurrent()` is what would interleave test bodies
//     inside ONE process. It is enabled nowhere: no `--concurrent`,
//     `--parallel`, `--isolate` or `--shard` flag appears in `scripts/*.ts`,
//     `package.json` or `bunfig.toml`; `bunfig.toml` sets `randomize = false`;
//     and the repo contains zero `test.concurrent` / `describe.concurrent`
//     call sites.
//
// So files and tests both run serially today, and the one mode that could break
// this isolates by process rather than sharing one. If someone ever turns
// `--concurrent` on, this file is not the only thing that breaks: the five
// describes below already delete and restore `process.env` keys in their own
// beforeEach/afterEach, as does much of the suite. Re-verify the two bullets
// above before assuming this block is the problem.
// ---------------------------------------------------------------------------

let ambientMinskyEnv: Array<[string, string]> = [];

beforeEach(() => {
  ambientMinskyEnv = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("MINSKY_") || value === undefined) continue;
    ambientMinskyEnv.push([key, value]);
    delete process.env[key];
  }
});

afterEach(() => {
  // Restore exactly what was there. Any MINSKY_* a test itself set is deleted
  // rather than left behind, so this file cannot leak into a sibling file
  // sharing the process.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("MINSKY_")) delete process.env[key];
  }
  for (const [key, value] of ambientMinskyEnv) {
    process.env[key] = value;
  }
  ambientMinskyEnv = [];
});

const TEST_POSTGRES_URL = "postgresql://user:pass@host:5432/db";

const PERSISTENCE_KEYS = [
  "MINSKY_PERSISTENCE_BACKEND",
  "MINSKY_PERSISTENCE_POSTGRES_URL",
  "MINSKY_POSTGRES_URL",
  "MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT",
];

/**
 * Subset of the resolved env-loaded shape this test cares about. Defined
 * here rather than reused from the runtime schema because the live shape is
 * `z.input<...>` of nested-optional schemas, which TypeScript can't navigate
 * deeply enough for the assertions below.
 */
type ExpectedShape = {
  persistence?: {
    backend?: string;
    postgres?: { connectionString?: string; connectTimeout?: number };
  };
};

function loadAsExpected(): ExpectedShape {
  return loadEnvironmentConfiguration() as ExpectedShape;
}

describe("environment configuration source — persistence mappings (mt#1223)", () => {
  let originalValues: Record<string, string | undefined>;

  beforeEach(() => {
    originalValues = {};
    for (const key of PERSISTENCE_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of PERSISTENCE_KEYS) {
      const value = originalValues[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("MINSKY_POSTGRES_URL maps to persistence.postgres.connectionString", () => {
    process.env.MINSKY_POSTGRES_URL = TEST_POSTGRES_URL;
    const config = loadAsExpected();
    expect(config.persistence?.postgres?.connectionString).toBe(TEST_POSTGRES_URL);
  });

  test("MINSKY_PERSISTENCE_POSTGRES_URL maps to persistence.postgres.connectionString (mt#1267)", () => {
    // Locks in the explicit mapping for the modern var name. Without this
    // mapping the auto-conversion fallback would route it to
    // `persistence.postgres.url` (note `_URL` -> `.url`, not `.connectionString`),
    // a non-schema key that the persistence factory would silently ignore. This
    // is the var name `scripts/deploy-minsky-mcp.ts` ENV_SPEC uploads to Railway.
    process.env.MINSKY_PERSISTENCE_POSTGRES_URL = TEST_POSTGRES_URL;
    const config = loadAsExpected();
    expect(config.persistence?.postgres?.connectionString).toBe(TEST_POSTGRES_URL);
  });

  test("MINSKY_PERSISTENCE_BACKEND auto-maps to persistence.backend", () => {
    process.env.MINSKY_PERSISTENCE_BACKEND = "postgres";
    const config = loadAsExpected();
    expect(config.persistence?.backend).toBe("postgres");
  });

  test("MINSKY_POSTGRES_URL + MINSKY_PERSISTENCE_BACKEND together produce a complete persistence config", () => {
    process.env.MINSKY_PERSISTENCE_BACKEND = "postgres";
    process.env.MINSKY_POSTGRES_URL = TEST_POSTGRES_URL;
    const config = loadAsExpected();
    expect(config.persistence?.backend).toBe("postgres");
    expect(config.persistence?.postgres?.connectionString).toBe(TEST_POSTGRES_URL);
  });

  test("MINSKY_POSTGRES_URL does NOT route to top-level postgres.url under auto-mapping fallback", () => {
    process.env.MINSKY_POSTGRES_URL = TEST_POSTGRES_URL;
    // Cast required: `postgres` is intentionally absent from the schema. The
    // assertion is structural — checking the schema doesn't accidentally grow
    // a top-level `postgres` key from the auto-mapping fallback.
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    expect(config.postgres).toBeUndefined();
  });

  test("MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT maps to persistence.postgres.connectTimeout as a NUMBER (mt#2982)", () => {
    // The persistence schema is z.number().int() with NO coercion — if the
    // fieldTypes entry is ever dropped, the value stays a string and config
    // load crashes at boot for every consumer that sets this var. toBe(2)
    // (not "2") locks both the mapping and the number conversion.
    process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT = "2";
    const config = loadAsExpected();
    expect(config.persistence?.postgres?.connectTimeout).toBe(2);
  });

  test("MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT does NOT route to persistence.postgres.connect.timeout under auto-mapping fallback", () => {
    process.env.MINSKY_PERSISTENCE_POSTGRES_CONNECT_TIMEOUT = "2";
    const config = loadEnvironmentConfiguration() as {
      persistence?: { postgres?: { connect?: unknown } };
    };
    expect(config.persistence?.postgres?.connect).toBeUndefined();
  });
});

describe("environment configuration source — supabase mapping (mt#1633)", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.MINSKY_SUPABASE_ACCESS_TOKEN;
    delete process.env.MINSKY_SUPABASE_ACCESS_TOKEN;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MINSKY_SUPABASE_ACCESS_TOKEN;
    } else {
      process.env.MINSKY_SUPABASE_ACCESS_TOKEN = original;
    }
  });

  test("MINSKY_SUPABASE_ACCESS_TOKEN maps to supabase.accessToken", () => {
    const TEST_PAT = "sbp_test_routing_check";
    process.env.MINSKY_SUPABASE_ACCESS_TOKEN = TEST_PAT;
    const config = loadEnvironmentConfiguration() as {
      supabase?: { accessToken?: string };
    };
    expect(config.supabase?.accessToken).toBe(TEST_PAT);
  });
});

// ---------------------------------------------------------------------------
// mt#1644: hook-only MINSKY_* env vars must NOT be coerced into the config
// object. Before this fix, `MINSKY_FORCE_PARALLEL=1 minsky session start ...`
// crashed at config load with `root: Unrecognized key: "force"` because the
// auto-mapping fallback routed it to a `force.parallel` path that mt#1612's
// strict-mode validation rejected. Same failure shape applied to
// MINSKY_SKIP_FRESHNESS, MINSKY_TWO_STRIKES_STATE_DIR, MINSKY_TWO_STRIKES_MODE.
// ---------------------------------------------------------------------------

describe("environment configuration source — hook-only env vars (mt#1644)", () => {
  const HOOK_ONLY_KEYS = [
    "MINSKY_FORCE_PARALLEL",
    "MINSKY_SKIP_FRESHNESS",
    "MINSKY_TWO_STRIKES_STATE_DIR",
    "MINSKY_TWO_STRIKES_MODE",
  ];

  const TWO_STRIKES_PATH = "/tmp/minsky-two-strikes";

  let originalValues: Record<string, string | undefined>;

  beforeEach(() => {
    originalValues = {};
    for (const key of HOOK_ONLY_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of HOOK_ONLY_KEYS) {
      const value = originalValues[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("MINSKY_FORCE_PARALLEL=1 does NOT produce a `force` config key", () => {
    process.env.MINSKY_FORCE_PARALLEL = "1";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    expect(config.force).toBeUndefined();
  });

  test("MINSKY_SKIP_FRESHNESS=1 does NOT produce a `skip` config key", () => {
    process.env.MINSKY_SKIP_FRESHNESS = "1";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    expect(config.skip).toBeUndefined();
  });

  test("MINSKY_TWO_STRIKES_STATE_DIR does NOT produce a `two` config key", () => {
    process.env.MINSKY_TWO_STRIKES_STATE_DIR = TWO_STRIKES_PATH;
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    expect(config.two).toBeUndefined();
  });

  test("MINSKY_TWO_STRIKES_MODE=live does NOT produce a `two` config key", () => {
    process.env.MINSKY_TWO_STRIKES_MODE = "live";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    expect(config.two).toBeUndefined();
  });

  test("hook-only vars set together produce no top-level pollution", () => {
    process.env.MINSKY_FORCE_PARALLEL = "1";
    process.env.MINSKY_SKIP_FRESHNESS = "1";
    process.env.MINSKY_TWO_STRIKES_STATE_DIR = TWO_STRIKES_PATH;
    process.env.MINSKY_TWO_STRIKES_MODE = "live";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    expect(config.force).toBeUndefined();
    expect(config.skip).toBeUndefined();
    expect(config.two).toBeUndefined();
  });

  test("getEnvironmentConfiguration() metadata also excludes hook-only env vars", () => {
    // Reviewer-bot caught this gap (PR #983 R1): the loader was patched but
    // getEnvironmentConfiguration's metadata-reporting loop was not, producing
    // a divergence where diagnostics would still report MINSKY_FORCE_PARALLEL
    // as "loaded" with mapping "force.parallel" even though the loader skipped
    // it. Both paths must stay in sync.
    process.env.MINSKY_FORCE_PARALLEL = "1";
    process.env.MINSKY_SKIP_FRESHNESS = "1";
    process.env.MINSKY_TWO_STRIKES_STATE_DIR = TWO_STRIKES_PATH;
    process.env.MINSKY_TWO_STRIKES_MODE = "live";
    const { metadata } = getEnvironmentConfiguration();
    for (const key of HOOK_ONLY_KEYS) {
      expect(metadata.loadedVariables).not.toContain(key);
      expect(metadata.mappings[key]).toBeUndefined();
    }
  });

  // mt#3997 (PR #2881 R1): the four cases above are a hand-picked SAMPLE, so a
  // newly-registered hook-only var — like this task's own
  // MINSKY_SKIP_MEMORY_CAPTURE_NOTICE — was covered by nothing. Adding one more
  // sampled case per var does not scale and would drift the moment someone
  // forgets. Assert the property over the WHOLE allowlist instead, so every
  // future registration is covered on the day it lands.
  test("EVERY registered hook-only var is excluded from config and metadata", () => {
    const restore: Record<string, string | undefined> = {};
    for (const key of HOOK_ONLY_ENV_VARS) {
      restore[key] = process.env[key];
      process.env[key] = "1";
    }
    try {
      const { config, metadata } = getEnvironmentConfiguration();
      for (const key of HOOK_ONLY_ENV_VARS) {
        // No hook-only var may ever acquire a config dot-path mapping. This
        // half is universal — there is no legitimate exception.
        expect(metadata.mappings[key]).toBeUndefined();

        // Absence from `loadedVariables` has exactly ONE sanctioned exception:
        // MINSKY_PROJECT is deliberately surfaced for observability (mt#2414,
        // documented at its call site) so operators get an audit trail for why
        // a project resolved as it did — while still carrying no mapping.
        // Pinned by name rather than skipped generically, so a SECOND silent
        // exception fails this test instead of quietly joining the first.
        if (key === "MINSKY_PROJECT") {
          expect(metadata.loadedVariables).toContain(key);
        } else {
          expect(metadata.loadedVariables).not.toContain(key);
        }
      }
      // And no hook-only var CONTRIBUTES anything to the config object (the
      // `force` / `skip` / `two` shape the sampled cases above check
      // individually).
      //
      // Compared against a baseline derived with those vars UNSET, rather than
      // by guessing leaked key names from each var's first underscore-delimited
      // segment (mt#4223). The guess was wrong in both directions:
      //
      //   - FALSE POSITIVE, which is what surfaced it. `MINSKY_GITHUB_TOKEN` is
      //     hook-only as of mt#4223, so its first segment put `github` in the
      //     guessed set — but `github` is a real declared config key, and CI
      //     always has a plain `GITHUB_TOKEN` set, which the EXPLICIT mapping
      //     legitimately routes to `github.token`. The test then reported
      //     `polluted: ["github"]` on a tree where nothing had leaked. It passed
      //     locally only because a dev machine usually exports no GITHUB_TOKEN —
      //     the same ambient-environment dependence mt#4221 removed elsewhere in
      //     this file, resurfacing through a different door.
      //   - FALSE NEGATIVE. A hook-only var leaking into a NESTED path whose
      //     top-level segment was already present would not change the key set
      //     at all, so the guess could not see it.
      //
      // The delta is exact: anything the hook-only vars add is a leak, whatever
      // it is called and however deep it sits.
      for (const key of HOOK_ONLY_ENV_VARS) {
        if (restore[key] === undefined) delete process.env[key];
        else process.env[key] = restore[key];
      }
      const baseline = getEnvironmentConfiguration().config;
      for (const key of HOOK_ONLY_ENV_VARS) process.env[key] = "1";

      expect(config).toEqual(baseline);
    } finally {
      for (const key of HOOK_ONLY_ENV_VARS) {
        const value = restore[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// mt#2452: reviewer-service env vars (MINSKY_REVIEWER_APP_ID, etc.) must NOT
// be coerced into the config object.
//
// Failure mode (before fix): with MINSKY_REVIEWER_APP_ID=123 set on the
// Railway reviewer service, the auto-mapping fallback converted the var to the
// path "reviewer.app.id", which set "reviewer.app" as a top-level sub-key of
// the reviewer config slot. The reviewerConfigSchema is a z.strictObject
// accepting only "webhookSecret" and "url"; encountering "app", "tier2",
// "private", or "installation" triggered "Unrecognized keys" validation
// failure and crashed bootDomainContainer(), leaving the reviewer service with
// domainServicesEnabled: false.
// ---------------------------------------------------------------------------

describe("environment configuration source — reviewer-service env vars (mt#2452)", () => {
  const REVIEWER_SERVICE_KEYS = [
    "MINSKY_REVIEWER_APP_ID",
    "MINSKY_REVIEWER_INSTALLATION_ID",
    "MINSKY_REVIEWER_PRIVATE_KEY",
    "MINSKY_REVIEWER_TIER2_ENABLED",
  ];

  // Stub value for the private key var (a real key would be multi-line PEM;
  // the header is sufficient to exercise the auto-mapping skip path).
  const STUB_PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";

  let originalValues: Record<string, string | undefined>;

  beforeEach(() => {
    originalValues = {};
    for (const key of REVIEWER_SERVICE_KEYS) {
      originalValues[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of REVIEWER_SERVICE_KEYS) {
      const value = originalValues[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("MINSKY_REVIEWER_APP_ID does NOT produce a reviewer.app config key", () => {
    process.env.MINSKY_REVIEWER_APP_ID = "3470137";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    // The strict reviewerConfigSchema only accepts webhookSecret and url.
    // If auto-mapping is NOT skipped, this would produce reviewer.app.id,
    // which sets reviewer.app — an unrecognized key that triggers a zod
    // strictObject validation failure at boot.
    const reviewer = config.reviewer as Record<string, unknown> | undefined;
    expect(reviewer?.["app"]).toBeUndefined();
  });

  test("MINSKY_REVIEWER_INSTALLATION_ID does NOT produce a reviewer.installation config key", () => {
    process.env.MINSKY_REVIEWER_INSTALLATION_ID = "126244115";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    const reviewer = config.reviewer as Record<string, unknown> | undefined;
    expect(reviewer?.["installation"]).toBeUndefined();
  });

  test("MINSKY_REVIEWER_PRIVATE_KEY does NOT produce a reviewer.private config key", () => {
    process.env.MINSKY_REVIEWER_PRIVATE_KEY = STUB_PRIVATE_KEY;
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    const reviewer = config.reviewer as Record<string, unknown> | undefined;
    expect(reviewer?.["private"]).toBeUndefined();
  });

  test("MINSKY_REVIEWER_TIER2_ENABLED does NOT produce a reviewer.tier2 config key", () => {
    process.env.MINSKY_REVIEWER_TIER2_ENABLED = "true";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    const reviewer = config.reviewer as Record<string, unknown> | undefined;
    expect(reviewer?.["tier2"]).toBeUndefined();
  });

  test("all four reviewer-service vars set together do not pollute the reviewer config slot", () => {
    process.env.MINSKY_REVIEWER_APP_ID = "3470137";
    process.env.MINSKY_REVIEWER_INSTALLATION_ID = "126244115";
    process.env.MINSKY_REVIEWER_PRIVATE_KEY = STUB_PRIVATE_KEY;
    process.env.MINSKY_REVIEWER_TIER2_ENABLED = "true";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    const reviewer = config.reviewer as Record<string, unknown> | undefined;
    expect(reviewer?.["app"]).toBeUndefined();
    expect(reviewer?.["installation"]).toBeUndefined();
    expect(reviewer?.["private"]).toBeUndefined();
    expect(reviewer?.["tier2"]).toBeUndefined();
  });

  test("getEnvironmentConfiguration() metadata excludes reviewer-service env vars", () => {
    process.env.MINSKY_REVIEWER_APP_ID = "3470137";
    process.env.MINSKY_REVIEWER_INSTALLATION_ID = "126244115";
    process.env.MINSKY_REVIEWER_PRIVATE_KEY = STUB_PRIVATE_KEY;
    process.env.MINSKY_REVIEWER_TIER2_ENABLED = "true";
    const { metadata } = getEnvironmentConfiguration();
    for (const key of REVIEWER_SERVICE_KEYS) {
      expect(metadata.loadedVariables).not.toContain(key);
      expect(metadata.mappings[key]).toBeUndefined();
    }
  });

  test("MINSKY_REVIEWER_WEBHOOK_SECRET still maps to reviewer.webhookSecret (existing explicit mapping)", () => {
    // This var is in environmentMappings (NOT in HOOK_ONLY_ENV_VARS), so it
    // must continue to produce reviewer.webhookSecret — the strict schema
    // accepts this key.
    const originalWebhookSecret = process.env.MINSKY_REVIEWER_WEBHOOK_SECRET;
    process.env.MINSKY_REVIEWER_WEBHOOK_SECRET = "test-secret";
    try {
      const config = loadEnvironmentConfiguration() as {
        reviewer?: { webhookSecret?: string };
      };
      expect(config.reviewer?.webhookSecret).toBe("test-secret");
    } finally {
      if (originalWebhookSecret === undefined) {
        delete process.env.MINSKY_REVIEWER_WEBHOOK_SECRET;
      } else {
        process.env.MINSKY_REVIEWER_WEBHOOK_SECRET = originalWebhookSecret;
      }
    }
  });

  test("MINSKY_REVIEWER_URL still maps to reviewer.url (existing explicit mapping)", () => {
    // PR #1674 R1 (non-blocking): sibling of the webhookSecret test above —
    // the other explicitly-mapped reviewer var must keep routing to its
    // schema-accepted key.
    const originalUrl = process.env.MINSKY_REVIEWER_URL;
    process.env.MINSKY_REVIEWER_URL = "https://reviewer.example";
    try {
      const config = loadEnvironmentConfiguration() as {
        reviewer?: { url?: string };
      };
      expect(config.reviewer?.url).toBe("https://reviewer.example");
    } finally {
      if (originalUrl === undefined) {
        delete process.env.MINSKY_REVIEWER_URL;
      } else {
        process.env.MINSKY_REVIEWER_URL = originalUrl;
      }
    }
  });

  test("mapped reviewer vars appear in metadata.loadedVariables with correct mappings (positive observability)", () => {
    // PR #1674 R1 (non-blocking): complement to the negative metadata test —
    // explicitly-mapped reviewer vars must surface in the audit metadata.
    const originalUrl = process.env.MINSKY_REVIEWER_URL;
    const originalWebhookSecret = process.env.MINSKY_REVIEWER_WEBHOOK_SECRET;
    process.env.MINSKY_REVIEWER_URL = "https://reviewer.example";
    process.env.MINSKY_REVIEWER_WEBHOOK_SECRET = "test-secret";
    try {
      const { metadata } = getEnvironmentConfiguration();
      expect(metadata.loadedVariables).toContain("MINSKY_REVIEWER_URL");
      expect(metadata.mappings["MINSKY_REVIEWER_URL"]).toBe("reviewer.url");
      expect(metadata.loadedVariables).toContain("MINSKY_REVIEWER_WEBHOOK_SECRET");
      expect(metadata.mappings["MINSKY_REVIEWER_WEBHOOK_SECRET"]).toBe("reviewer.webhookSecret");
    } finally {
      if (originalUrl === undefined) {
        delete process.env.MINSKY_REVIEWER_URL;
      } else {
        process.env.MINSKY_REVIEWER_URL = originalUrl;
      }
      if (originalWebhookSecret === undefined) {
        delete process.env.MINSKY_REVIEWER_WEBHOOK_SECRET;
      } else {
        process.env.MINSKY_REVIEWER_WEBHOOK_SECRET = originalWebhookSecret;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// mt#2414: MINSKY_PROJECT observability in metadata.loadedVariables
//
// MINSKY_PROJECT is hook-only (no dot-path config mapping — it would be
// rejected as "minsky.project" by the strict schema). However, it DOES
// influence which project identity was resolved, so operators need an audit
// trail. The fix: surface it in loadedVariables when set, WITHOUT adding it
// to `mappings`. This test guards that invariant.
// ---------------------------------------------------------------------------

describe("environment configuration source — MINSKY_PROJECT observability (mt#2414)", () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.MINSKY_PROJECT;
    delete process.env.MINSKY_PROJECT;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.MINSKY_PROJECT;
    } else {
      process.env.MINSKY_PROJECT = original;
    }
  });

  test("MINSKY_PROJECT set: appears in loadedVariables", () => {
    process.env.MINSKY_PROJECT = "owner/repo";
    const { metadata } = getEnvironmentConfiguration();
    expect(metadata.loadedVariables).toContain("MINSKY_PROJECT");
  });

  test("MINSKY_PROJECT set: does NOT appear in mappings (not dot-path-mapped)", () => {
    process.env.MINSKY_PROJECT = "owner/repo";
    const { metadata } = getEnvironmentConfiguration();
    expect(metadata.mappings["MINSKY_PROJECT"]).toBeUndefined();
  });

  test("MINSKY_PROJECT unset: does NOT appear in loadedVariables", () => {
    // env var cleared in beforeEach — nothing to set
    const { metadata } = getEnvironmentConfiguration();
    expect(metadata.loadedVariables).not.toContain("MINSKY_PROJECT");
  });

  test("MINSKY_PROJECT set: does NOT produce a top-level config key (stays hook-only)", () => {
    process.env.MINSKY_PROJECT = "owner/repo";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    expect(config.minsky).toBeUndefined();
    expect(config.project).toBeUndefined();
  });
});

describe("environment configuration source — principal channel (mt#3230)", () => {
  const KEYS = [
    "MINSKY_PRINCIPAL_CHANNEL_ENABLED",
    "MINSKY_PRINCIPAL_CHANNEL_CWD",
    "MINSKY_PRINCIPAL_CHANNEL_PERMISSION_MODE",
    "MINSKY_PRINCIPAL_CHANNEL_ALLOWED_USER_IDS",
  ];
  let originals: Record<string, string | undefined>;

  type ChannelShape = {
    principalChannel?: {
      enabled?: unknown;
      cwd?: unknown;
      permissionMode?: unknown;
      allowedUserIds?: unknown;
    };
    principal?: unknown;
  };

  const load = (): ChannelShape => loadEnvironmentConfiguration() as ChannelShape;

  beforeEach(() => {
    originals = {};
    for (const key of KEYS) {
      originals[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = originals[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("enabled maps as a BOOLEAN, not the string 'true'", () => {
    // The schema is z.boolean() with no coercion — a string here would fail
    // validation and take the whole config load down at daemon boot.
    process.env.MINSKY_PRINCIPAL_CHANNEL_ENABLED = "true";
    expect(load().principalChannel?.enabled).toBe(true);
  });

  test("the allowlist maps as an ARRAY from a comma-separated value", () => {
    // An operator setting an allowlist in a shell writes `1,2` — not a JSON
    // array — so this needs the csv converter, and the schema needs an array.
    process.env.MINSKY_PRINCIPAL_CHANNEL_ALLOWED_USER_IDS = "777, 888 ,";
    expect(load().principalChannel?.allowedUserIds).toEqual(["777", "888"]);
  });

  test("cwd and permissionMode map through as strings", () => {
    process.env.MINSKY_PRINCIPAL_CHANNEL_CWD = "/srv/work";
    process.env.MINSKY_PRINCIPAL_CHANNEL_PERMISSION_MODE = "default";
    const config = load();
    expect(config.principalChannel?.cwd).toBe("/srv/work");
    expect(config.principalChannel?.permissionMode).toBe("default");
  });

  test("does NOT route to a top-level `principal` key under the auto-mapping fallback", () => {
    // Without the explicit mappings, MINSKY_PRINCIPAL_CHANNEL_* auto-converts
    // to `principal.channel.*` — a top-level key the strict schema rejects,
    // crashing the loader at boot for anyone who has these set.
    process.env.MINSKY_PRINCIPAL_CHANNEL_ENABLED = "true";
    expect(load().principal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mt#4221: guards on the ambient-env baseline established at the top of this
// file. Without them the baseline is unfalsifiable — someone could delete the
// beforeEach and every other test here would still pass on a machine that
// happens to export nothing, which is precisely the condition under which this
// file was green while being wrong.
// ---------------------------------------------------------------------------

describe("environment configuration source — ambient-env isolation (mt#4221)", () => {
  test("no MINSKY_* variable survives into a test body", () => {
    // What makes this a guard rather than a coincidence: `tests/setup.ts` is
    // preloaded for EVERY run (bunfig.toml `[test].preload`) and sets
    // MINSKY_LOG_LEVEL and MINSKY_LOG_MODE unconditionally, so there is always
    // something for the baseline to strip. Delete the beforeEach and this fails
    // on every machine and in CI — not only where an operator has extra vars
    // exported.
    const surviving = Object.keys(process.env).filter((key) => key.startsWith("MINSKY_"));
    expect(surviving).toEqual([]);
  });

  test("an unregistered MINSKY_* var derives a top-level key — the mechanism isolated against", () => {
    // Why the baseline is needed at all. This name is registered nowhere, so
    // the generic fallback maps it to `mcp.not.a.real.knob` and mints a
    // top-level `mcp` key. Inherited rather than set deliberately, that is
    // exactly what fails the hook-only leak assertion above — the failure
    // mt#4221 was filed for, reached through a name no registry mentions.
    //
    // If a loader change ever stops this deriving, THIS is the test that should
    // fail and force the baseline's rationale to be re-read. Note that mt#1651
    // as specced would not: it filters auto-mapped paths against the schema's
    // declared top-level keys, and `mcp` IS declared
    // (packages/domain/src/configuration/schemas/index.ts), so this path passes
    // that filter untouched.
    // Being UNREGISTERED is the fixture. The rule below guards production reads
    // that would auto-map and crash config load at boot; this var is written by
    // a test to demonstrate that very derivation and is read by no production
    // code. Registering it would invert the assertion — a registered var is
    // SKIPPED by the fallback, so `config.mcp` would be undefined and this test
    // could no longer show why the baseline above is needed. Suppressed rather
    // than renamed around the matcher: dodging a guard's heuristic defeats it
    // for the next genuine case (mem#601).
    // eslint-disable-next-line custom/no-unregistered-minsky-env-var
    process.env.MINSKY_MCP_NOT_A_REAL_KNOB = "1";
    const config = loadEnvironmentConfiguration() as Record<string, unknown>;
    expect(config.mcp).toBeDefined();
  });
});
