/**
 * Tests for environment-variable -> configuration mappings.
 *
 * Specifically guards the persistence-config wiring that boots
 * PersistenceService on Minsky MCP startup. mt#1223: MINSKY_POSTGRES_URL did
 * not auto-map to persistence.postgres.connectionString; the explicit
 * environmentMappings entry is what makes hosted-MCP startup succeed.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadEnvironmentConfiguration, getEnvironmentConfiguration } from "./environment";

const TEST_POSTGRES_URL = "postgresql://user:pass@host:5432/db";

const PERSISTENCE_KEYS = [
  "MINSKY_PERSISTENCE_BACKEND",
  "MINSKY_PERSISTENCE_POSTGRES_URL",
  "MINSKY_POSTGRES_URL",
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
    postgres?: { connectionString?: string };
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
