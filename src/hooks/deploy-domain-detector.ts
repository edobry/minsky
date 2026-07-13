/**
 * Detector for the deploy-domain ownership guard (mt#2208).
 *
 * Verifies that every domain ASSERTED as a deployment target in deploy/site
 * config is a domain we actually control — i.e., present in the verified
 * allowlist `infra/controlled-domains.json`. Adding a new deploy domain forces
 * adding it to the allowlist, which is the deliberate "I verified we own this"
 * gate.
 *
 * Tracking task: mt#2208 — the live successor to mt#2193, whose guard scope
 * never shipped (mt#2193's truthfulness-correction merged via PR #1433, then
 * the task auto-transitioned DONE and the status machine blocked reopening).
 *
 * Originating incident (2026-05-31): `minsky.dev` first appeared in Jul-2025
 * analysis prose as an *illustrative example URL*. It was later promoted to
 * authoritative deploy config (`infra/index.ts` SITE_URL,
 * `services/site/astro.config.ts`, README "Deployed at") with no ownership
 * check ever run; an agent then read it back and reported "we're deployed to
 * minsky.dev" — false. Verified via Cloudflare API + RDAP + crt.sh that
 * `minsky.dev` is registered to a third party and is not in our Cloudflare
 * account. A 30-second `GET /zones?name=<domain>` would have caught it.
 *
 * Family: assertion-without-verification (bridge memory `ac1a6761`; siblings
 * `d624c862` doc-comment-intent-vs-reality, `68b4a81f` negative-existence
 * claims, `2946a222` / mt#1787 dev-vs-deployed). The new surface here is an
 * external resource-ownership assertion ("we control this domain") frozen into
 * config without verification.
 *
 * --- Why string-literal / phrase-anchored extraction, not a raw domain grep ---
 *
 * The CORRECTED repo legitimately MENTIONS `minsky.dev` in WARNING COMMENTS
 * ("do not set this to a domain we do not control ... `minsky.dev` is
 * third-party-owned"). A naive domain grep would flag those mentions and fail
 * this guard's own acceptance test 4 (the repo at the fix commit must pass).
 * So the extractor distinguishes ASSERTIONS from MENTIONS:
 *
 *   - Code files (`.ts` / `.js`): comments are stripped first using a small
 *     string-aware state machine (so the `//` inside `https://` is NOT treated
 *     as a line comment, and a `` `minsky.dev` `` backtick run inside a `//`
 *     comment is never entered as a string). Domains are then extracted from
 *     the comment-free source — only value positions remain.
 *   - Markdown files (`README.md`): domains are extracted only when they
 *     FOLLOW a deploy-assertion phrase ("deployed at", "serves at", ...), not
 *     from arbitrary prose mentions.
 *
 * Limitations (documented intentionally):
 *   - Apex reduction is naive last-two-labels (no Public Suffix List). For the
 *     deploy-config domains in play (`*.up.railway.app`, `*.github.io`,
 *     `ghcr.io`, custom apexes like `minsky.dev`) this is correct; a multi-part
 *     public suffix like `co.uk` would over-reduce. Revisit if such a domain
 *     enters deploy config.
 *   - Platform apexes (`railway.app`, `github.io`, `ghcr.io`) are allowlisted
 *     at the APEX, which intentionally accepts any sub-host. These are
 *     multi-tenant platforms where our specific sub-host is provisioned to our
 *     account; the threat model is a CUSTOM apex we don't own (the minsky.dev
 *     class), so apex-listing the platform domains is the right granularity.
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * Env var that, when truthy (`1` / `true` / `yes`), skips the deploy-domain
 * ownership check. Follows the override-with-audit pattern of
 * `MINSKY_SKIP_NUL_CHECK`, `MINSKY_SKIP_IMMUTABLE_MIGRATION_CHECK`, etc.
 *
 * Registered in `HOOK_ONLY_ENV_VARS` at
 * `packages/domain/src/configuration/sources/environment.ts` per the mt#1788
 * ESLint-rule contract. The name's source of truth lives here so the hook,
 * tests, and rule documentation cannot drift.
 */
export const DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV = "MINSKY_SKIP_DEPLOY_DOMAIN_CHECK";

/**
 * Relative path to the verified-controlled-domains allowlist.
 */
export const CONTROLLED_DOMAINS_REL_PATH = "infra/controlled-domains.json";

/**
 * Recognized TLDs for BARE (scheme-less) host extraction. A scheme-prefixed
 * host (`https://...`) is always extracted; a bare token is only treated as a
 * domain when its final label is in this set. This keeps dotted code
 * identifiers (`package.json`, `astro.config`, `service-resolver.ts`,
 * `process.env.PORT`) from being mistaken for domains.
 */
const BARE_DOMAIN_TLDS: ReadonlySet<string> = new Set([
  "dev",
  "com",
  "app",
  "io",
  "net",
  "org",
  "ai",
  "sh",
  "cloud",
  "co",
  "page",
  "pages",
  "run",
  "work",
  "link",
  "site",
  "xyz",
  "tech",
  "build",
  "gg",
  "me",
]);

/**
 * Deploy-assertion phrases that, in a markdown file, mark the domain that
 * FOLLOWS them as an authoritative deploy-target claim. Matched
 * case-insensitively. A bare prose mention NOT preceded by one of these (e.g.
 * "do not assume minsky.dev") is intentionally not extracted.
 */
const MARKDOWN_ASSERTION_RE =
  /(?:deployed\s+(?:at|on)|serv(?:es|ing)\s+at|hosted\s+(?:at|on)|available\s+at|live\s+at|deploys?\s+(?:it|them|this)\s+to)/gi;

/** Max chars after an assertion phrase to search for the asserted domain. */
const MARKDOWN_ASSERTION_WINDOW = 160;

export interface ControlledDomainsAllowlist {
  /** Apex domains (eTLD+1) we control as deploy targets. Any sub-host passes. */
  apexes: string[];
  /** Exact hostnames we control (used when apex-listing would be too broad). */
  exactHosts: string[];
}

export interface DeployDomainViolation {
  filePath: string;
  /** Normalized host as extracted from the assertion. */
  host: string;
  /** Computed apex (naive last-two-labels). */
  apex: string;
  /** 1-based line number of the assertion. */
  line: number;
  /** The line text containing the assertion (trimmed). */
  excerpt: string;
}

export interface DeployDomainCheckResult {
  violations: DeployDomainViolation[];
  scannedFiles: string[];
  allowlist: ControlledDomainsAllowlist;
}

/** True when the env-var value enables the override (matches sibling hooks). */
export function isDeployDomainOverrideTruthy(envValue: string | undefined): boolean {
  if (!envValue) return false;
  const v = envValue.toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/**
 * Normalize a raw host/URL token to a bare lowercase hostname, or `null` when
 * it is not a usable external host (localhost, single-label, malformed).
 */
export function normalizeHost(raw: string): string | null {
  let h = raw.trim().toLowerCase();
  h = h.replace(/^https?:\/\//, ""); // strip scheme
  h = h.replace(/^[^@/]*@/, ""); // strip user:pass@
  h = h.split(/[/?#]/)[0] ?? h; // cut path/query/fragment
  h = h.split(":")[0] ?? h; // strip port
  h = h.replace(/^\.+/, "").replace(/\.+$/, ""); // strip leading/trailing dots
  if (!h || h === "localhost") return null;
  if (!h.includes(".")) return null; // single-label hostnames are not deploy domains
  if (!/^[a-z0-9.-]+$/.test(h)) return null;
  return h;
}

/**
 * Reduce a hostname to its apex (registrable domain), naive last-two-labels.
 * See the module header for the no-PSL limitation.
 */
export function toApex(host: string): string {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  return labels.slice(-2).join(".");
}

/**
 * True when `host` is controlled per the allowlist: an exact-host match, an
 * exact-apex match, or its apex is allowlisted.
 */
export function isControlled(host: string, allowlist: ControlledDomainsAllowlist): boolean {
  const exact = new Set((allowlist.exactHosts ?? []).map((x) => x.toLowerCase()));
  if (exact.has(host)) return true;
  const apexes = new Set((allowlist.apexes ?? []).map((x) => x.toLowerCase()));
  if (apexes.has(host)) return true;
  if (apexes.has(toApex(host))) return true;
  return false;
}

interface RawDomainHit {
  host: string;
  apex: string;
  index: number;
}

const DOMAIN_RE =
  /(https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;

/**
 * Yield every domain in `text`. A scheme-prefixed host always qualifies; a
 * bare host qualifies only when its final label is a recognized TLD.
 */
function iterateDomains(text: string): RawDomainHit[] {
  const hits: RawDomainHit[] = [];
  DOMAIN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DOMAIN_RE.exec(text)) !== null) {
    const hadScheme = Boolean(m[1]);
    const host = normalizeHost(m[2] ?? "");
    if (!host) continue;
    const lastLabel = host.split(".").pop() ?? "";
    if (!hadScheme && !BARE_DOMAIN_TLDS.has(lastLabel)) continue;
    hits.push({ host, apex: toApex(host), index: m.index });
  }
  return hits;
}

function lineInfo(original: string, index: number): { line: number; excerpt: string } {
  const before = original.slice(0, index);
  const line = before.split("\n").length;
  const lineStart = before.lastIndexOf("\n") + 1;
  let lineEnd = original.indexOf("\n", index);
  if (lineEnd === -1) lineEnd = original.length;
  return { line, excerpt: original.slice(lineStart, lineEnd).trim() };
}

/**
 * Extract the contents of every string literal (single, double, backtick) in
 * TS/JS source, with the absolute source offset of each literal's first
 * content character. Comments are NOT entered as strings (the `//` inside a
 * `https://` literal is handled because we're already in string mode), so a
 * domain mentioned in a comment is never returned.
 *
 * Extracting domains from string-literal VALUES — rather than from the whole
 * comment-stripped source — is what prevents code expressions like
 * `process.env.SITE_URL` (whose final segment `SITE` would otherwise match the
 * `site` TLD) from being mistaken for asserted domains. Only literal values
 * can assert a deploy domain.
 */
export function extractStringLiterals(src: string): Array<{ content: string; start: number }> {
  const literals: Array<{ content: string; start: number }> = [];
  let i = 0;
  const n = src.length;
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  let mode: Mode = "code";
  let buf = "";
  let start = 0;
  while (i < n) {
    const c = src[i] ?? "";
    const c2 = src[i + 1] ?? "";
    if (mode === "code") {
      if (c === "/" && c2 === "/") {
        i += 2;
        mode = "line";
        continue;
      }
      if (c === "/" && c2 === "*") {
        i += 2;
        mode = "block";
        continue;
      }
      if (c === "'" || c === '"' || c === "`") {
        mode = c === "'" ? "sq" : c === '"' ? "dq" : "tpl";
        buf = "";
        start = i + 1;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") mode = "code";
      i++;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && c2 === "/") {
        i += 2;
        mode = "code";
        continue;
      }
      i++;
      continue;
    }
    // string modes
    if (c === "\\") {
      buf += c + c2;
      i += 2;
      continue;
    }
    const closed =
      (mode === "sq" && c === "'") || (mode === "dq" && c === '"') || (mode === "tpl" && c === "`");
    if (closed) {
      literals.push({ content: buf, start });
      mode = "code";
      i++;
      continue;
    }
    buf += c;
    i++;
  }
  return literals;
}

/**
 * Extract asserted deploy domains from a code file: scan only string-literal
 * VALUES (comments and code expressions are excluded).
 */
export function extractAssertedDomainsFromCode(
  src: string
): Array<{ host: string; apex: string; line: number; excerpt: string }> {
  const out: Array<{ host: string; apex: string; line: number; excerpt: string }> = [];
  for (const lit of extractStringLiterals(src)) {
    for (const h of iterateDomains(lit.content)) {
      out.push({
        host: h.host,
        apex: h.apex,
        ...lineInfo(src, lit.start + h.index),
      });
    }
  }
  return out;
}

/**
 * Extract asserted deploy domains from a markdown file: only the FIRST domain
 * following each deploy-assertion phrase (within a bounded window), so prose
 * mentions not preceded by an assertion phrase are ignored.
 */
export function extractAssertedDomainsFromMarkdown(
  src: string
): Array<{ host: string; apex: string; line: number; excerpt: string }> {
  const found: Array<{ host: string; apex: string; line: number; excerpt: string }> = [];
  const seen = new Set<string>();
  MARKDOWN_ASSERTION_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKDOWN_ASSERTION_RE.exec(src)) !== null) {
    const windowStart = m.index + m[0].length;
    const windowText = src.slice(windowStart, windowStart + MARKDOWN_ASSERTION_WINDOW);
    const hits = iterateDomains(windowText);
    if (hits.length === 0) continue;
    const first = hits[0];
    if (first === undefined) continue;
    const absoluteIndex = windowStart + first.index;
    const info = lineInfo(src, absoluteIndex);
    const key = `${first.host}@${info.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({ host: first.host, apex: first.apex, ...info });
  }
  return found;
}

/**
 * Pure core: given a map of `filePath -> content` and the allowlist, return
 * every asserted domain not confirmed under our control. File kind is inferred
 * from the extension (`.md` => markdown, else code).
 */
export function detectDeployDomainViolations(
  files: ReadonlyMap<string, string>,
  allowlist: ControlledDomainsAllowlist
): DeployDomainViolation[] {
  const violations: DeployDomainViolation[] = [];
  for (const [filePath, content] of files) {
    const isMarkdown = filePath.toLowerCase().endsWith(".md");
    const assertions = isMarkdown
      ? extractAssertedDomainsFromMarkdown(content)
      : extractAssertedDomainsFromCode(content);
    for (const a of assertions) {
      if (isControlled(a.host, allowlist)) continue;
      violations.push({
        filePath,
        host: a.host,
        apex: a.apex,
        line: a.line,
        excerpt: a.excerpt,
      });
    }
  }
  return violations;
}

/**
 * Discover the in-scope deploy/site config files under `projectRoot`:
 *   - infra/index.ts
 *   - services/{*}/deploy.config.ts
 *   - services/{*}/astro.config.ts
 *   - services/{*}/README.md
 */
export function discoverDeployConfigFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const infra = join(projectRoot, "infra", "index.ts");
  if (existsSync(infra)) out.push(infra);

  const servicesDir = join(projectRoot, "services");
  if (existsSync(servicesDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(servicesDir);
    } catch {
      entries = [];
    }
    for (const name of entries.sort()) {
      const svcDir = join(servicesDir, name);
      for (const f of ["deploy.config.ts", "astro.config.ts", "README.md"]) {
        const p = join(svcDir, f);
        if (existsSync(p)) out.push(p);
      }
    }
  }
  return out;
}

/**
 * Load and parse the controlled-domains allowlist. Returns `null` when the
 * allowlist file is absent (the check is then inapplicable — a silent pass,
 * matching the sibling-guard "no contract to check" convention). Throws on a
 * present-but-malformed file (a real misconfiguration the operator must fix).
 */
export function loadControlledDomains(projectRoot: string): ControlledDomainsAllowlist | null {
  const p = join(projectRoot, CONTROLLED_DOMAINS_REL_PATH);
  if (!existsSync(p)) return null;
  const raw = String(readFileSync(p, "utf-8"));
  const parsed = JSON.parse(raw) as Partial<ControlledDomainsAllowlist>;
  return {
    apexes: Array.isArray(parsed.apexes) ? parsed.apexes : [],
    exactHosts: Array.isArray(parsed.exactHosts) ? parsed.exactHosts : [],
  };
}

/**
 * Impure wrapper for the pre-commit pipeline: discover files, load the
 * allowlist, and detect violations. Returns `null` when the allowlist file is
 * absent (inapplicable). The pre-commit hook handler formats the result.
 */
export function runDeployDomainCheck(projectRoot: string): DeployDomainCheckResult | null {
  const allowlist = loadControlledDomains(projectRoot);
  if (allowlist === null) return null;

  // Key the file map by REPO-RELATIVE path so violation output is readable and
  // consistent with the sibling guards (which report repo-relative paths), per
  // PR #1453 reviewer feedback. discoverDeployConfigFiles returns absolute
  // paths (needed to read); we convert to relative for keys + scannedFiles.
  const absFiles = discoverDeployConfigFiles(projectRoot);
  const files = new Map<string, string>();
  const scannedFiles: string[] = [];
  for (const abs of absFiles) {
    const rel = relative(projectRoot, abs);
    try {
      files.set(rel, String(readFileSync(abs, "utf-8")));
      scannedFiles.push(rel);
    } catch {
      // Unreadable file (race with deletion, permissions) — skip; the check
      // is conservative and never blocks on its own inability to read.
    }
  }

  const violations = detectDeployDomainViolations(files, allowlist);
  return { violations, scannedFiles, allowlist };
}
