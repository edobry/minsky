# Playbook: a required CI check never ran

This covers the **"check absent" class**: a required GitHub Actions check (e.g. `build`,
`bundle-boot-smoke`) shows **zero** `check_runs` for the PR's current HEAD commit — as opposed to
a check that ran and failed, or a check that's still queued/in-progress. It is a distinct failure
signal from **"review didn't post"** (the reviewer-bot webhook-miss class — see
`.minsky/skills/merge-coordination/skill.ts` §7a) even though both are event-delivery misses and
both can co-occur. Treat them independently; the recovery for one does not necessarily fix the
other.

Originating incident: `mt#2800` — 2026-07-14, branch `task/mt-2751` (PR #1898). Two consecutive
pushes (`118e7fc0f`, `7541fd041`) produced zero Actions runs after the prior push
(`5ba8c32e8`, 00:25Z) got full CI. See `## Root cause` below for the investigation.

## 1. Discriminate before you recover

**Zero check_runs is ambiguous.** Before assuming "GitHub missed the webhook," rule out the
cheaper, more common causes first — each needs a _different_ fix, and the wrong fix wastes cycles
or actively harms the PR (an empty-commit nudge or a rebase both invalidate a standing reviewer
APPROVE, so don't fire one speculatively).

1. **Read the PR's actual HEAD SHA and query check-runs for exactly that SHA** —
   `mcp__minsky__forge_check_runs_list` or `mcp__minsky__forge_ci_run_list branch:<branch>`.
   Confirm the SHA you're investigating is truly the current HEAD (a stale mental model of "the
   latest push" is a common self-inflicted error mid-iteration).
2. **Check `mergeable_state` before concluding "webhook miss."** `dirty` (real conflict) or
   `behind`/`unknown` means GitHub cannot form the PR's merge ref and therefore never dispatches
   `pull_request`-triggered workflows at all — this looks identical to a webhook miss (zero
   check_runs) but the fix is completely different (`session_update` to bring the branch current,
   not any of the nudges below). Empty-commit nudges do **nothing** for this case and each one
   burns a reviewer-approval cycle for no benefit. See memory `6262934f` (the discriminator) and
   `mt#2312` (the structural gate fix that added this distinction to the merge-gate hook itself).
3. **Only once `mergeable_state` is `clean` (or `blocked` solely on the missing check) AND
   check-runs for the current HEAD are genuinely empty** do you have the "check never ran" class
   this playbook covers.

## 2. Root-cause hypotheses to weigh (config vs. transient vs. push-mechanics)

Before or alongside re-triggering, it's worth knowing _why_ — both to pick the right recovery and
because a structural cause (vs. a one-off transient) should be filed as a bug, not just worked
around.

- **Workflow-file trigger misconfiguration** (`paths`/`paths-ignore` filter excluding the changed
  files, wrong `branches:` filter, a `concurrency` group silently absorbing the run). Check the
  workflow file's `on:` block directly. For this repo's `ci.yml` and `bundle-boot-smoke.yml`,
  neither has a `paths:` filter and neither has a `concurrency:` group, so a path-filter miss or a
  same-group cancellation are ruled out as explanations here (a genuine `cancel-in-progress`
  cancellation would also still leave a `cancelled` check_run record — it would NOT produce zero
  records, which is a useful tell: **zero runs is a different symptom from a cancelled run**).
- **A genuine GitHub-side incident.** Check https://www.githubstatus.com/ — but query the actual
  incident **history/API**, not just the current homepage banner (the banner only reflects status
  _now_, not status at the time you're investigating). Two concrete data points from this task's
  research: the 2026-07-14 window relevant to the originating incident (~00:17–00:50Z) had **no**
  overlapping incident (GitHub's only incident that day was a Codespaces-scoped degradation from
  08:21–09:56 UTC, seven-plus hours later and a different service). By contrast, a **confirmed**
  incident _did_ occur two days later — 2026-07-16, "Degraded REST API Availability"
  (~22:00–23:50Z+) — which produced HTTP 503 "Unicorn" pages on `gh`-CLI check-run/PR reads and
  blocked three independent agents' merge attempts that evening (`mt#2887`, `mt#2888`, `mt#2890`,
  `mt#2892` — a _different_ mechanism than this playbook's zero-workflow-run class, see
  `## Related-but-distinct family` below, but useful as a concrete example of what an actual
  confirmed incident's evidence trail looks like, for calibration).
- **Push-authentication path (leading hypothesis for the mt#2800 incident specifically).** See
  `## Root cause` below — `session_commit`'s push conditionally uses a GitHub App installation
  token, silently falling back to system-keychain credentials on any token-resolution failure, and
  keychain-credential pushes are documented (in this repo's own `push-operations.ts`) to not
  reliably trigger `pull_request` workflows.
- **Rapid-force-push ref races.** Two force-pushes to the same ref in quick succession can cause
  GitHub to process only the later one, silently dropping the dispatch for the discarded ref
  update. Ruled out for the originating incident: both commits were normal fast-forward pushes (no
  `--force`), and the empty-commit wake was a deliberate, manually-triggered follow-up after
  noticing the first miss, not a rapid double-push.

## 3. Legitimate re-trigger options, in preference order

Only proceed here once §1's discriminator confirms a genuine "check never ran" (not
dirty/behind, not still-queued, not a real failure).

1. **Re-run failed jobs (`forge_ci_run_rerun`, failed-jobs mode) — NOT applicable to this class.**
   This mt#2775 tool re-runs failed jobs of a run that **exists**. If check-runs are genuinely
   zero, there is no run to re-run — skip straight to the options below. (Use `forge_ci_run_rerun`
   instead when the discriminator in §1 finds a run that _completed with a failure conclusion_ —
   that's the "check failed" class, not "check never ran.")
2. **Rebase-on-main repush** (`mcp__minsky__session_update`, even when it's a no-op merge because
   the branch is already current, followed by a fresh push). Lowest blast radius of the
   push-based options: it also resolves the `mergeable_state: behind`/`dirty` case from §1 if that
   was actually in play. Cost: a fresh push invalidates any standing reviewer APPROVE, requiring a
   fresh review round.
3. **Empty-commit wake** (`session_commit` with `noFiles: true, noStage: true`) — for the genuine
   webhook-miss sub-case only (mergeable state was already clean; this isn't fixing staleness,
   it's just nudging GitHub to re-deliver). Empirically effective roughly half the time (memory
   `8bd30dc2`) — if it doesn't fire CI on the first try, don't loop it repeatedly; move to the next
   option. Same cost as above: invalidates a standing reviewer APPROVE.
4. **`workflow_dispatch`, where the workflow defines it — diagnostic value only, verify before
   relying on it for merge-gate purposes.** Both `ci.yml` and `bundle-boot-smoke.yml` in this repo
   declare a `workflow_dispatch:` trigger. `ci.yml`'s own inline comment (dating to `mt#1469`) is
   explicit: a manually-dispatched run **does not satisfy GitHub branch protection's required
   status check**, because manual runs aren't `pull_request`-triggered events — branch protection
   matches on triggering context, not just check name + SHA. Use `gh workflow run <file> --ref
<branch>` to confirm the workflow itself isn't broken (i.e., rule out a workflow-file bug as the
   cause), but do not expect it alone to unblock a PR-merge gate that requires the `pull_request`
   event class. Note: a **SHA-scoped** custom gate that reads check-runs by commit SHA regardless
   of triggering event (e.g. this repo's `bundle-boot-smoke` PreToolUse evaluator, which queries
   `commits/<sha>/check-runs` with no event-type filter) may accept a `workflow_dispatch`-produced
   check_run even though native branch protection would not — this is plausible from the gate's
   own read-path but has not been empirically verified; treat it as worth trying, not as guaranteed.
5. **Close and reopen the PR.** The heaviest-weight option: forces a fresh `opened` event and
   reliably re-dispatches every `pull_request`-triggered workflow cleanly. Reserve for cases where
   options 2–4 have been tried and failed, since it disrupts review-thread continuity and forces a
   full fresh reviewer pass (not just a re-review — a genuinely new review sequence).

## 4. When to wait instead of acting

If §2's incident check finds an active, confirmed GitHub incident overlapping the affected commit's
push time — query `https://www.githubstatus.com/api/v2/incidents.json` (or the summary endpoint)
for the actual time window, not just the current banner — the correct response is to **wait** for
the incident to resolve and then re-verify, not to cycle through the re-trigger options above (they
won't fix a GitHub-side outage, and repeated empty-commit nudges during an active incident just
burn reviewer-approval cycles for nothing). Re-check check-runs for the SHA once the incident's
status moves to `resolved`.

## 5. Last resort: bypass overrides

`MINSKY_SKIP_BUNDLE_SMOKE=1` and `MINSKY_SKIP_REQUIRED_CHECKS=1` exist for exactly the case where
none of the above converges and a human operator has independently verified the underlying
property the check would have verified (e.g., manually confirmed the bundle boots locally). They
are **not** a first resort:

- Per `feedback_verify_ci_fired_before_bypass_merge`, verify CI's actual state on the current HEAD
  (using §1's discriminator) before invoking either override — the override should follow from a
  _confirmed_ "genuinely never ran / genuinely can't be verified" state, not from impatience.
- **Never bypass a check whose true state is unverifiable** (e.g. `gh` transport itself is
  returning errors and you cannot determine whether the check would have passed or failed — this
  is the distinct, still-open `mt#2892` gap: when `gh`'s transport is degraded, there is currently
  no reachable mid-session override path that confirms "verified green out-of-band" rather than
  just blindly skipping the check). If you cannot determine the true state, escalate/wait rather
  than bypass blind.
- Both env vars are launch-time-only (not settable mid-session) by design — see
  `docs/architecture/hooks/bundle-boot-smoke-gate.md` and `CLAUDE.md §Hook Files`. The ADR-028 D8
  grant-file channel (`mt#2658`) is the pattern for a mid-session-reachable, audited override;
  `mt#2892` (open) tracks extending that channel to this specific transport-failure gap.

## Related-but-distinct family

This playbook covers **GitHub Actions never dispatching a workflow run** (zero check_runs
created). It does _not_ cover:

- **Reviewer-bot webhook misses** (the review never posts) — see
  `.minsky/skills/merge-coordination/skill.ts` §7a; same event-delivery-miss shape, different
  system (the `minsky-reviewer[bot]` webhook receiver, not GitHub Actions), different mt-tracked
  incident lineage (`mt#1110`, `mt#2777`, `mt#2799`).
- **`gh`-CLI transport failures reading _existing_ check-run/PR state** (HTTP 503s, rate limits,
  mislabeled errors) during merge-gate evaluation — a 2026-07-16 GitHub REST degradation produced
  exactly this and is tracked separately (`mt#2888`, `mt#2890`, `mt#2892`). That family is about
  **reading** already-created state unreliably; this playbook is about the workflow run **never
  being created** in the first place.

## Root cause (mt#2800 investigation)

**Confirmed via direct evidence:**

- `forge_ci_run_list branch:task/mt-2751` returns zero runs for both `118e7fc0f` and `7541fd041`
  across every workflow in the repo (not just one) — consistent with a genuine dispatch miss, not
  a single misconfigured workflow.
- `118e7fc0f` touched only `src/cockpit/web/pages/DrivenSessionPage.{tsx,test.tsx}`; `7541fd041` is
  a true empty commit (zero file changes). Neither `ci.yml` nor `bundle-boot-smoke.yml` has a
  `paths:` filter that could have excluded either — ruled out.
- No `concurrency:` group exists on `ci.yml` or `bundle-boot-smoke.yml` — a cancellation-based
  explanation is ruled out (and would in any case have left a `cancelled` run record, not zero
  records).
- GitHub's incident history shows no overlap with the ~00:17–00:50Z window on 2026-07-14 (the only
  incident that day, 08:21–09:56 UTC, was Codespaces-scoped and hours later) — ruled out.
- Both pushes were normal fast-forwards (not force-pushed); `7541fd041` was a deliberate,
  manually-triggered wake attempt after the first miss was already noticed, not a rapid
  back-to-back push — a ref-race is not a plausible explanation here.

**Leading hypothesis (grounded in code, not directly confirmed via runtime log for this specific
instance):** `session_commit`'s push path (`packages/domain/src/session/session-commands.ts`,
~lines 383–401) conditionally resolves a GitHub App installation token via
`tokenProvider.getToken("implementer")`, gated on `tokenProvider?.isServiceAccountConfigured()`. On
any failure to obtain the token, it logs a `log.warn` and **silently falls back to system-keychain
credentials** for the push. Per this repo's own `push-operations.ts` (`mt#1477` fix, lines
105–108): pushing with the App token "triggers `pull_request` workflows (unlike GITHUB_TOKEN or
system-keychain credentials)" — i.e., the keychain-credential fallback path is _documented in this
codebase_ as unreliable for triggering downstream workflow dispatch. Since the two earlier pushes
on the same branch (`76a18097` at 00:17Z, `5ba8c32e8` at 00:25Z) _did_ get full CI while these two
later ones did not, the failure is intermittent per-push rather than a standing misconfiguration —
consistent with the prior finding on this exact class (memory `8bd30dc2` / task `mt#1469`: "the
trigger drop is intermittent, not 100% systematic").

This hypothesis is not confirmed by a direct runtime log for the specific two pushes (the
token-fallback warning is a `log.warn` on the MCP server process; no persisted server log from that
session was available to this investigation). If this recurs, the fallback warning should be
promoted from a log line to a structured, queryable signal (e.g., surfaced in the push result or a
metric) so a future recurrence can be confirmed directly rather than inferred from code-reading —
this playbook does not file that as a new task since it would duplicate the receipts-oriented
framing already tracked in memory `b7ea5048` ("State-mutating operations need verifiable receipts
of effect") and the existing `mt#1469`/`mt#1477` lineage; revisit if a third recurrence of this
specific class is observed.

## Cross-references

- `mt#2800` — this task (investigation + this playbook).
- `mt#1469` / `mt#1477` — prior investigation and fix for the App-token-vs-keychain push-trigger
  class; source of the leading hypothesis above.
- `8bd30dc2`, `6262934f`, `b7ea5048` — memories cited above (verify-CI-fired discipline, the
  mergeable_state discriminator, and the receipts framing).
- `mt#2312` — structural gate fix that added the `mergeable_state` discriminator to the merge-gate
  hook itself.
- `mt#2777` / `mt#2799` — reviewer-webhook-miss / redeploy-drain sibling family (distinct system,
  same event-delivery-miss shape).
- `mt#2887` / `mt#2888` / `mt#2890` / `mt#2892` — the 2026-07-16 `gh`-CLI transport-degradation
  family (distinct mechanism: reading existing state unreliably, not failing to create it).
- `.claude/hooks/require-review-before-merge.ts` — the merge-gate hook; its
  `evaluateBundleBootSmokePresence` function already implements the "check absent" vs "check
  failed" vs "still running" vs "API/parse failure" distinction this playbook assumes (see
  `docs/architecture/hooks/bundle-boot-smoke-gate.md`'s "Four denial classes").
- `.minsky/skills/merge-coordination/skill.ts` §7a — the reviewer-webhook-miss sibling ladder;
  cross-linked from there back to this file.
