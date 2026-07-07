# Bundle-Boot Smoke Gate

> Extracted from `.minsky/rules/hook-files.mdc` (mt#2620) — full incident narration,
> cross-references, and worked examples for this hook/guard. The compiled rule corpus
> carries only a terse index entry; this file is the durable detail.

Extension to the merge-gate hook (`.claude/hooks/require-review-before-merge.ts`)
that denies `mcp__minsky__session_pr_merge` when the bundle-boot smoke check
did not fire and conclude `success` on the PR's HEAD commit. This is the
structural fix (mt#1787) for the dev-vs-deployed divergence class: changes
that look fine in `src/` but crash when the bundled `dist/minsky.js` boots
under Railway. Originating incidents: mt#1681 (procedural OOB step),
mt#1763 (`import.meta.url`-relative path resolution outside `/app`),
mt#1785 (env-var-namespace conflict crashing the config loader).

**Workflow file:** `.github/workflows/bundle-boot-smoke.yml` — runs
`bun install --frozen-lockfile && bun run build && bun dist/minsky.js
mcp start --http --host=127.0.0.1 --port=<random>`, then polls
`GET /health` for up to 30s and fails if it does not respond 200.

**Hook integration:** the merge gate feeds a check-runs response through
`parseBundleBootSmokeResponse` + `evaluateBundleBootSmokePresence`. As of
mt#2617, the query is `gh api repos/<owner>/<repo>/commits/<sha>/check-runs?per_page=100`
— the owner/repo is derived from the git remote (`deriveRepoFromGit`, no
longer hardcoded `edobry/minsky`), and the response is ONE shared
`fetchCheckRunsRaw` call (see `.claude/hooks/pr-context.ts`) reused by the
sibling mt#1309 presence check and the mt#1938 required-checks check —
`parseBundleBootSmokeResponse` already filters `check_runs[]` client-side by
name, so it doesn't need (and never needed) the server-side `check_name=`
filter the pre-mt#2617 query used. Four denial classes:

1. **API/parse failure** — gh transport error or malformed response. Distinct
   reason so operators investigate gh, not the workflow.
2. **No matching check_run** — workflow never fired. Causes: PR predates the
   workflow (rebase on main); webhook miss (push an empty commit to wake);
   workflow file malformed.
3. **Still in progress / queued** — wait for completion.
4. **Completed but conclusion ≠ success** — the bundle did not boot cleanly.
   The denial reason includes the run's `html_url` for triage.

Pass: at least one matching check_run with `conclusion === "success"`.

**Override mechanism:** Set `MINSKY_SKIP_BUNDLE_SMOKE=1` (or `true` / `yes`)
in the environment before invoking the merge tool:

```bash
MINSKY_SKIP_BUNDLE_SMOKE=1 minsky session pr merge ...
```

The override is **logged to session stdout** (PR number, short HEAD sha, ISO
timestamp). Use only when the operator has manually verified local boot
(`bun run build && bun dist/minsky.js mcp start --http --host=127.0.0.1
--port=<n>` then `curl http://127.0.0.1:<n>/health`) AND the workflow
itself is what's broken on the PR being merged. Reaching for this override
otherwise re-introduces the deploy-time-blind merge that mt#1787 fixed.

**Env-var registration:** `MINSKY_SKIP_BUNDLE_SMOKE` is registered in
`HOOK_ONLY_ENV_VARS` at `packages/domain/src/configuration/sources/environment.ts`
so it does not get auto-mapped to a config-key path by the env-var-to-config
parser (mt#1785 incident class). The contract source-of-truth for both the
check name (`bundle-boot-smoke`) and the override env var name lives in the
hook file as exported constants `BUNDLE_BOOT_SMOKE_CHECK_NAME` and
`BUNDLE_BOOT_SMOKE_OVERRIDE_ENV` so the workflow, the hook, and tests
cannot drift.

**Cross-references:**

- mt#1681 / mt#1695 — procedural-step subset and its OOB-merge-text hook
- mt#1763 / mt#1766 — bundle-path drift incident + revert
- mt#1785 — env-var-namespace conflict (sibling class)
- mt#1788 — ESLint rule for new `MINSKY_*` env-var registration (sibling
  PR-time gate; this guard is the merge-time gate)
- mt#2617 — shared `fetchPrContext` fetch layer (`.claude/hooks/pr-context.ts`)
  that this gate's check-runs/branch-protection/review fetches now go
  through; see `§Single Shared PR-Data Fetch Layer` below
