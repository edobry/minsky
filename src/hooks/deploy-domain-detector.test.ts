import { describe, test, expect } from "bun:test";
import {
  normalizeHost,
  toApex,
  isControlled,
  isDeployDomainOverrideTruthy,
  extractStringLiterals,
  extractAssertedDomainsFromCode,
  extractAssertedDomainsFromMarkdown,
  detectDeployDomainViolations,
  type ControlledDomainsAllowlist,
} from "./deploy-domain-detector";

const ALLOWLIST: ControlledDomainsAllowlist = {
  apexes: ["railway.app", "github.io", "ghcr.io"],
  exactHosts: [],
};

// The real serving host (a controlled railway.app sub-host). Extracted to a
// constant to satisfy custom/no-magic-string-duplication.
const SITE_HOST = "minsky-site-production.up.railway.app";

describe("normalizeHost", () => {
  test("strips scheme, path, port, trailing dot", () => {
    expect(normalizeHost("https://minsky.dev/foo")).toBe("minsky.dev");
    expect(normalizeHost("http://localhost:4321")).toBeNull();
    expect(normalizeHost("ghcr.io/edobry/minsky:latest")).toBe("ghcr.io");
    expect(normalizeHost(SITE_HOST)).toBe(SITE_HOST);
  });

  test("rejects single-label and localhost", () => {
    expect(normalizeHost("localhost")).toBeNull();
    expect(normalizeHost("config")).toBeNull();
    expect(normalizeHost("")).toBeNull();
  });
});

describe("toApex", () => {
  test("reduces to last two labels", () => {
    expect(toApex(SITE_HOST)).toBe("railway.app");
    expect(toApex("docs.minsky.dev")).toBe("minsky.dev");
    expect(toApex("ghcr.io")).toBe("ghcr.io");
    expect(toApex("edobry.github.io")).toBe("github.io");
  });
});

describe("isControlled", () => {
  test("apex match passes; uncontrolled apex fails", () => {
    expect(isControlled(SITE_HOST, ALLOWLIST)).toBe(true);
    expect(isControlled("edobry.github.io", ALLOWLIST)).toBe(true);
    expect(isControlled("ghcr.io", ALLOWLIST)).toBe(true);
    expect(isControlled("minsky.dev", ALLOWLIST)).toBe(false);
    expect(isControlled("docs.minsky.dev", ALLOWLIST)).toBe(false);
  });

  test("exactHosts match", () => {
    const al: ControlledDomainsAllowlist = { apexes: [], exactHosts: ["minsky.dev"] };
    expect(isControlled("minsky.dev", al)).toBe(true);
    expect(isControlled("www.minsky.dev", al)).toBe(false); // exact only
  });
});

describe("isDeployDomainOverrideTruthy", () => {
  test("recognizes 1/true/yes case-insensitively; rejects others", () => {
    for (const v of ["1", "true", "TRUE", "yes", "Yes"]) {
      expect(isDeployDomainOverrideTruthy(v)).toBe(true);
    }
    for (const v of [undefined, "", "0", "false", "no"]) {
      expect(isDeployDomainOverrideTruthy(v)).toBe(false);
    }
  });
});

describe("extractStringLiterals", () => {
  test("captures literal contents, ignores // inside https://", () => {
    const src = `const x = "https://minsky-site.up.railway.app";`;
    const lits = extractStringLiterals(src).map((l) => l.content);
    expect(lits).toContain("https://minsky-site.up.railway.app");
  });

  test("does not return a domain that lives only in a line comment", () => {
    const src = `// minsky.dev is third-party-owned\nconst x = "https://railway.app";`;
    const lits = extractStringLiterals(src).map((l) => l.content);
    expect(lits.some((l) => l.includes("minsky.dev"))).toBe(false);
    expect(lits).toContain("https://railway.app");
  });

  test("does not return a backtick-wrapped domain inside a line comment", () => {
    const src = "// do not control `minsky.dev` per mt#2193\nconst y = 1;";
    const lits = extractStringLiterals(src).map((l) => l.content);
    expect(lits.some((l) => l.includes("minsky.dev"))).toBe(false);
  });

  test("does not return domains in block comments", () => {
    const src = `/*\n * see minsky.dev\n */\nconst z = "ghcr.io/x";`;
    const lits = extractStringLiterals(src).map((l) => l.content);
    expect(lits.some((l) => l.includes("minsky.dev"))).toBe(false);
    expect(lits).toContain("ghcr.io/x");
  });

  test("does NOT capture code expressions like process.env.SITE_URL", () => {
    const src = `const SITE_URL = process.env.SITE_URL ?? DEFAULT_SITE_URL;`;
    const domains = extractAssertedDomainsFromCode(src);
    expect(domains).toHaveLength(0);
  });
});

describe("extractAssertedDomainsFromCode", () => {
  test("extracts value-position domains, ignores commented ones (AT4 shape)", () => {
    // Mirrors the corrected infra/index.ts: minsky.dev only in a comment.
    const src = [
      `defineVariables("site", siteEnv, siteServiceId, {`,
      `  NODE_ENV: plain("production"),`,
      `  // do not set this to a domain we do not control (mt#2193). \`minsky.dev\` is`,
      `  // third-party-owned (verified 2026-05-31).`,
      `  SITE_URL: plain("https://${SITE_HOST}"),`,
      `});`,
    ].join("\n");
    const domains = extractAssertedDomainsFromCode(src);
    const hosts = domains.map((d) => d.host);
    expect(hosts).toContain(SITE_HOST);
    expect(hosts).not.toContain("minsky.dev");
  });

  test("ignores dotted code identifiers and filenames", () => {
    const src = `import x from "fs/promises";\nconst p = readFile("package.json");\nconst c = "astro.config";`;
    const domains = extractAssertedDomainsFromCode(src);
    expect(domains).toHaveLength(0);
  });

  test("extracts a bare uncontrolled domain in a string value", () => {
    const src = `const SITE = "https://minsky.dev";`;
    const domains = extractAssertedDomainsFromCode(src);
    expect(domains.map((d) => d.host)).toContain("minsky.dev");
  });
});

describe("extractAssertedDomainsFromMarkdown", () => {
  test("extracts only the domain following an assertion phrase, not prose mentions", () => {
    // Mirrors the corrected services/site/README.md line 3.
    const md =
      "Marketing site for Minsky. Deployed on Railway (separate service); serves at " +
      `https://${SITE_HOST}. A custom marketing domain is pending ` +
      "(mt#2046) — do not assume `minsky.dev`, which is owned by a third party.";
    const domains = extractAssertedDomainsFromMarkdown(md);
    const hosts = domains.map((d) => d.host);
    expect(hosts).toContain(SITE_HOST);
    expect(hosts).not.toContain("minsky.dev");
  });

  test("extracts an uncontrolled domain when it IS the asserted target", () => {
    const md = "Deployed at https://minsky.dev for now.";
    const domains = extractAssertedDomainsFromMarkdown(md);
    expect(domains.map((d) => d.host)).toContain("minsky.dev");
  });

  test("ignores a domain with no preceding assertion phrase", () => {
    const md = "See the docs at https://docs.minsky.dev for details.";
    const domains = extractAssertedDomainsFromMarkdown(md);
    expect(domains).toHaveLength(0);
  });
});

describe("detectDeployDomainViolations", () => {
  test("AT1: config asserting an uncontrolled domain trips", () => {
    const files = new Map<string, string>([
      ["infra/index.ts", `const SITE_URL = "https://minsky.dev";`],
    ]);
    const violations = detectDeployDomainViolations(files, ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.host).toBe("minsky.dev");
    expect(violations[0]?.apex).toBe("minsky.dev");
    expect(violations[0]?.filePath).toBe("infra/index.ts");
  });

  test("AT2: config asserting a controlled/allowlisted domain passes", () => {
    const files = new Map<string, string>([
      ["infra/index.ts", `const SITE_URL = "https://${SITE_HOST}";`],
      ["services/minsky-mcp/deploy.config.ts", `const img = "ghcr.io/edobry/minsky:latest";`],
    ]);
    expect(detectDeployDomainViolations(files, ALLOWLIST)).toHaveLength(0);
  });

  test("AT4: corrected-repo shape (commented minsky.dev) passes", () => {
    const files = new Map<string, string>([
      [
        "infra/index.ts",
        [
          `  // do not set this to a domain we do not control (mt#2193). \`minsky.dev\` is`,
          `  SITE_URL: plain("https://${SITE_HOST}"),`,
        ].join("\n"),
      ],
      [
        "services/site/README.md",
        `Deployed on Railway; serves at https://${SITE_HOST}. ` +
          "Do not assume `minsky.dev`, which is third-party-owned.",
      ],
    ]);
    expect(detectDeployDomainViolations(files, ALLOWLIST)).toHaveLength(0);
  });

  test("reports line number and excerpt for the violation", () => {
    const files = new Map<string, string>([
      ["infra/index.ts", `const a = 1;\nconst SITE_URL = "https://evil.example.dev";`],
    ]);
    const violations = detectDeployDomainViolations(files, ALLOWLIST);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.excerpt).toContain("SITE_URL");
  });
});
