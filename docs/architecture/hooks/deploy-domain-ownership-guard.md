# Deploy-Domain Ownership Guard

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

A step in the pre-commit pipeline (`src/hooks/pre-commit.ts`, step 3e,
between the migration-journal check and the TypeScript type check) verifies
that every domain **asserted as a deployment target** in deploy/site config
is a domain we actually control — i.e., present in the verified allowlist
`infra/controlled-domains.json`. Blocks the commit when an asserted domain
is not allowlisted. Like the NUL-byte and Workspace-COPY guards, this is a
true git pre-commit step (not a Claude Code PreToolUse hook), invoked by the
`PreCommitHook` class from `.husky/pre-commit`.

**Hook file (in-pipeline step):** `src/hooks/pre-commit.ts` →
`runDeployDomainCheck()`. Pure-function implementation:
`src/hooks/deploy-domain-detector.ts`.

**Why this check exists.** Originating incident (2026-05-31): `minsky.dev`
first appeared in Jul-2025 analysis prose as an _illustrative example URL_.
It was later promoted to authoritative deploy config (`infra/index.ts`
SITE_URL, `services/site/astro.config.ts`, README "Deployed at") with no
ownership check ever run; an agent then read it back and reported "we're
deployed to minsky.dev" — false. Verified via Cloudflare API + RDAP +
crt.sh that `minsky.dev` is registered to a third party and is not in our
Cloudflare account. A 30-second `GET /zones?name=<domain>` would have caught
it. This is the external-resource-ownership member of the
assertion-without-verification family (bridge memory `ac1a6761`; siblings
`d624c862`, `68b4a81f`, `2946a222` / mt#1787).

**Scope (files scanned):** `infra/index.ts`, `services/*/deploy.config.ts`,
`services/*/astro.config.ts`, and `services/*/README.md` ("Deployed at" /
"serves at" claims). Always-on (runs every commit); the scan is well under
50 ms.

**Assertion-vs-mention discrimination.** The corrected repo legitimately
_mentions_ `minsky.dev` in WARNING COMMENTS ("do not set this to a domain we
do not control"). A naive domain grep would flag those and block. So the
detector distinguishes assertions from mentions:

- **Code files** (`.ts` / `.js`): domains are extracted only from
  string-literal VALUES. A comment-aware state machine excludes comments,
  and code expressions like `process.env.SITE_URL` are excluded too (its
  `SITE` segment would otherwise match the `site` TLD).
- **Markdown files**: domains are extracted only when they FOLLOW a
  deploy-assertion phrase ("deployed at", "serves at", ...), not from
  arbitrary prose mentions.

**Allowlist (`infra/controlled-domains.json`):** apex domains (`apexes`,
any sub-host passes — used for platform domains like `railway.app`,
`github.io`, `ghcr.io` where our sub-host is provisioned to our account) and
exact hostnames (`exactHosts`, when apex-listing would be too broad). Adding
a new deploy domain forces adding it here, which is the deliberate "I
verified we own this" gate. A separate periodic Cloudflare-zone drift check
(Option B, mt#2210) re-verifies allowlist entries are still zones in our
account.

**On hit:** the step blocks with a structured message naming each offending
file:line + host (repo-relative paths), the unmatched apex, a "Why this is
blocked" section pointing at mt#2208 / the originating incident / bridge
memory `ac1a6761`, and the instruction to verify ownership (e.g. confirm the
domain is a zone in our Cloudflare account) before adding it to the
allowlist.

**Override mechanism:** Set `MINSKY_SKIP_DEPLOY_DOMAIN_CHECK=1` (or
`true` / `yes`) in your environment before invoking the commit tool:

```bash
MINSKY_SKIP_DEPLOY_DOMAIN_CHECK=1 minsky session commit ...
```

The override emits an audit-log line to stdout naming the env-var value and
the ISO timestamp. Use only when the domain is genuinely controlled but not
yet allowlisted AND the allowlist entry is being added separately (the
better fix is almost always to add the verified entry to
`infra/controlled-domains.json`).

**Env-var registration:** `MINSKY_SKIP_DEPLOY_DOMAIN_CHECK` is registered in
`HOOK_ONLY_ENV_VARS` at
`packages/domain/src/configuration/sources/environment.ts` so the
env-var-to-config dot-path parser skips it at boot (per the
`custom/no-unregistered-minsky-env-var` ESLint rule from mt#1788). The
override env-var name's source of truth lives in
`src/hooks/deploy-domain-detector.ts` as the exported constant
`DEPLOY_DOMAIN_CHECK_OVERRIDE_ENV` so the hook, the test, and the rule
documentation cannot drift.

**Known limitations:** apex reduction is naive last-two-labels (no Public
Suffix List) — correct for the deploy-config domains in play; revisit if a
multi-part public suffix like `co.uk` enters deploy config. Platform apexes
are allowlisted at the apex, intentionally accepting any sub-host (the threat
model is a CUSTOM apex we don't own, the minsky.dev class).

**Cross-references:**

- mt#2208 — this guard's tracking task (live successor to mt#2193)
- mt#2193 — originating guard task; truthfulness-correction shipped via
  PR #1433, guard scope carried forward to mt#2208
- mt#2210 — Option B follow-up (periodic Cloudflare-zone drift check)
- `ac1a6761` — bridge memory (assertion-without-verification family);
  retirement target is this guard
- mt#1787 / `2946a222` — dev-vs-deployed sibling; `d624c862`,
  `68b4a81f` — adjacent assertion-without-verification members
- mt#1788 — ESLint rule + `HOOK_ONLY_ENV_VARS` (env-var registration)
- mt#1824 / mt#1984 — sibling pre-commit-step guards this one mirrors
