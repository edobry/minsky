# mt#2348 — Automating the Pulumi apply workflow (GitOps for `infra/`)

**Date:** 2026-07-10
**Task:** mt#2348 (research) → follow-up implementation mt#2738
**Status:** Research complete; recommendation adopted; implementation gated on operator (Pulumi Cloud signup + prod-state migration authorization)

---

## Motivation

Minsky's infrastructure — the Railway services (`minsky-mcp`, `reviewer`, `site`, the `cockpit` preview) and their env vars — is defined as code in `infra/index.ts` using Pulumi (Railway via the terraform-community-providers/railway TF bridge, v1.1.1). Applying a change, however, is a **manual, laptop-only** step: `pulumi up` must be run by hand from the operator's machine, because the Pulumi state and stack secrets are not reachable from anywhere else.

Two facts about the current setup are the root of the problem:

1. **State is a local file** — the Pulumi backend is `file://~` on the operator's laptop.
2. **Secrets are local** — `Pulumi.prod.yaml` is gitignored and its secrets are encrypted with a passphrase held only on that machine.

This produces a cluster of failure modes:

- **Two-step-you-must-remember.** Merge the infra PR, then _separately_ remember to run `pulumi up`. Forgetting leaves prod silently half-shipped — the exact half-applied-infra class the mt#1695 out-of-band-merge guard exists to catch.
- **No preview-on-PR.** Neither the operator nor the reviewer bot can see what an infra change will do to prod before it merges.
- **No drift detection.** When Railway drifts from code (a dashboard tweak, or a service provisioned out-of-band), nothing notices until someone runs a preview by hand — by which point it's a landmine (e.g. a naive `pulumi up` would create a _duplicate_ cockpit service).

**The smoking gun:** the same pre-existing `infra/` drift was independently re-discovered and re-filed as a brand-new task **three times in one month** — mt#2351 (2026-06-08), mt#2407 (2026-06-10), and mt#2734 (2026-07-10, closed as a duplicate). Three sessions tripped over the same un-applied drift because nothing detects it automatically. That recurrence is what makes automating the apply loop worth more than hand-reconciling drift a fourth time.

## The load-bearing constraint: shared state

Automating any of this (preview-on-PR, apply-on-merge, drift-check) means running Pulumi in **CI (GitHub Actions)**. But CI has neither the operator's local state file nor the local passphrase, so it cannot run Pulumi at all today. The prerequisite for _every_ automation approach is therefore to migrate the state off the laptop into a **shared backend CI can read**, and to re-encrypt secrets under a provider CI can decrypt headless.

This is why "Pulumi Cloud" enters the picture — not as a product to buy for its own sake, but as the least-effort shared-state backend.

## Approaches evaluated

Evaluated against Minsky's concrete setup: single repo, Railway TF-bridge provider, local file-state today, single prod stack, solo operator, already-GitHub-Actions-centric CI.

| Approach                                      | What it is                                                                                                                                                                                                                                                                                                       | Fit for Minsky                                                                                                                                                                                    | Verdict                                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **`pulumi/actions` (GitHub Actions)**         | Official action. `pr.yml` runs `pulumi preview` and comments the diff on the PR (`comment-on-pr-number`; `edit-pr-comment` defaults to true since 3.2.0). `main.yml` runs `pulumi up` on merge. A scheduled workflow runs `pulumi preview` for drift detection. Runs in _your_ CI; needs a shared state backend. | **Highest** — Minsky already runs many GitHub Actions (`deploy-*.yml`, `bundle-boot-smoke`); apply logic stays in-repo and auditable; a single prod stack needs no ephemeral per-PR environments. | **RECOMMENDED (apply loop)**                                                                                                       |
| **Pulumi Deployments** (Pulumi Cloud managed) | Pulumi Cloud runs the apply; a GitHub App posts preview + commit checks; Review Stacks spin up ephemeral per-PR environments (created on open, destroyed on merge). Managed compute _and_ managed state.                                                                                                         | Good but heavier than needed: Review Stacks (ephemeral per-PR infra) are overkill for a single prod stack; managed apply-compute burns deployment minutes. The managed _state_ IS wanted.         | **Upgrade path** — adopt the managed state now; add managed apply / Review Stacks later only if per-PR environments become useful. |
| **Atlantis / Spacelift / env0**               | Atlantis (self-hosted daemon) supports Terraform / OpenTofu / Terragrunt only — **no native Pulumi**. Pulumi PR-automation exists via a community "Atlantis-like" action or managed control planes (Spacelift, env0).                                                                                            | Poor: Atlantis needs a self-hosted daemon and doesn't do Pulumi; Spacelift/env0 add a _second_ vendor + control plane. Overkill for a solo operator + single repo.                                | **Rejected**                                                                                                                       |

## Recommendation

**Adopt Pulumi Cloud managed state (free Individual tier) and drive the apply loop with `pulumi/actions` in Minsky's existing GitHub Actions CI — phased: detection first (preview-on-PR + drift-cron), apply-on-merge only later (see Phasing below). Defer Pulumi Deployments/Review Stacks as an optional later upgrade. Reject Atlantis/Spacelift/env0 for this scale.**

The split is: **buy the hard part** (shared state + secret management, via Pulumi Cloud) and **self-host the cheap glue** (2–3 thin workflow files wrapping the official action). This minimizes engineering time — no state backend to operate, no daemon to run — while keeping the apply logic auditable in-repo.

### Build-vs-buy reasoning

Per `decision-defaults.mdc §Build vs buy`, infra-apply automation is auxiliary CI infrastructure — explicitly _not_ Minsky's core value-add — so the default is adopt, not build. No build path clears the four-part flip bar (core relevance / no mature option / build ≪ buy cost / strategic ownership). OSS-hedge weight is low: managed state is the OTel-of-IaC, and migrating backends later is a bounded operation.

**Cost:** $0/month on Pulumi Cloud's Individual tier at Minsky's scale (single user; 500 deployment minutes/month, and infra applies are sporadic — far under the limit; ~34 resources, well within limits). The Team tier ($40/mo, up to 10 users, 150k free credits ≈ 200 resources) only becomes relevant if the operator count grows past one.

## Phasing and production-safety (follow-up research, 2026-07-10)

A second research pass validated the two decisions this commits us to at signup: **Pulumi Cloud vs self-managed backend**, and **auto-apply vs detection-only**.

**Backend — Pulumi Cloud confirmed over self-managed (S3/DIY).** For a solo operator, Pulumi Cloud's free tier wins on the exact axis we care about: it offers _first-class scheduled drift detection_ (scheduled refresh runs, a Drift tab, notifications, optional auto-remediation) with zero setup, plus a transactional state API that recovers cleanly from partial failures. A self-managed S3/DIY backend is free and gives more control, but drift detection is a manual `pulumi refresh --preview-only` you have to schedule yourself, and blob backends have weak concurrency control (Pulumi's DIY backend does add file-based locking by default, unlike Terraform). At solo scale, the operational-overhead saving is decisive.

**Apply loop — phase it; do NOT start with auto-apply-on-merge.** Community + vendor guidance is consistent: scheduled detection + human-approved remediation is the safer default; continuous auto-apply to production "carries risks" (a misconfigured loop can destroy a database, revoke an IAM role, or replace a protected resource) and is recommended only for highly-controlled environments after long staging soak. Pulumi's own automation (Neo) defaults to a Review mode where both the PR and the `pulumi up` require approval. Because Minsky's prod is live Railway services, the calibrated plan is:

- **Phase 1 (ship first — zero auto-mutation of prod):** migrate state to Pulumi Cloud; add `pulumi preview`-on-PR (diff comment) + a scheduled drift-cron that alerts (GitHub issue) on non-zero diff. Apply stays the operator's manual `pulumi up`, now with CI preview visibility and automatic drift alerts. **This alone eliminates the recurring-drift-re-discovery pain** (mt#2351/2407/2734) — that problem is a _detection_ gap, not an _apply_ gap.
- **Phase 2 (later, optional):** add apply-on-merge (or an approval-gated apply) once Phase 1 has built confidence, with `protect` on stateful resources.

This phasing also lowers the ongoing risk profile: after the one-time state migration, Phase-1 CI only _reads_/previews prod — it never mutates it.

## State-backend migration (the prerequisite)

Local `file://~` state + local-passphrase-encrypted `Pulumi.prod.yaml` is fundamentally incompatible with CI/GitOps: CI has access to neither. Every approach above requires migrating first:

- **Migrate state:** `pulumi login` to Pulumi Cloud → migrate the `prod` stack (`pulumi stack export` from the local backend → `pulumi stack import` into Pulumi Cloud). (A self-managed S3/GCS/Postgres backend is the OSS-hedge alternative but adds operational surface — not recommended at this scale.)
- **Re-encrypt secrets:** today's local-passphrase secret provider cannot be decrypted in CI. Re-encrypt stack secrets under Pulumi Cloud's default secret provider (or a CI-accessible KMS key) so `pulumi preview`/`up` run headless.
- **Vendor gate (operator-owned):** adopting Pulumi Cloud is a vendor signup (free tier, but a signup nonetheless — `CLAUDE.md §Vendor commitments`). The implementation is gated on the operator creating the account and authorizing the prod-state migration.

## Follow-up implementation

Filed as **mt#2738** — "Implement Pulumi GitOps for `infra/`: Pulumi Cloud state + `pulumi/actions` preview-on-PR / apply-on-merge / drift-cron." It carries the state-backend migration, the three workflows (`infra-preview.yml`, `infra-apply.yml`, `infra-drift-cron.yml`), CI secret configuration, and the `docs/deploy-minsky-railway.md` update.

**Supersedes mt#1443** ("CI integration for Railway synthesizer"), which automated the now-retired `scripts/railway/apply.ts` synthesizer + `services/*/railway.config.ts` (both removed in the Pulumi migration). Its _goal_ — drift-check on PR + apply on merge + drift cron — lives on in mt#2738 for the Pulumi era.

## Cross-references

- **mt#2738** — implementation follow-up (this research's deliverable).
- **mt#1443** — superseded predecessor (synthesizer-era CI automation).
- **mt#2473** — "make infra preview reproducible in ephemeral sessions"; its root cause (local state + gitignored secrets) is resolved by this migration.
- **mt#2351 / mt#2407 / mt#2734** — the recurring drift re-discovery this automation structurally removes (mt#2734 closed 2026-07-10 as a duplicate of the other two).
- **mt#1695** — out-of-band-merge guard; apply-on-merge closes the half-shipped-infra class it guards against.
- Position paper `0cebd854` (Notion `36c937f0-3cb4-8117-b8cb-f64b7ed2cad4`) — "Post-cdktf IaC trajectory for Minsky — Pulumi with TF bridge"; this research is its CI/GitOps continuation.

## Sources

- [Review stacks — Pulumi Docs](https://www.pulumi.com/docs/deployments/deployments/review-stacks/)
- [Pulumi Deployments — Pulumi Docs](https://www.pulumi.com/docs/deployments/deployments/)
- [pulumi/actions — GitHub](https://github.com/pulumi/actions)
- [Using GitHub Actions with Pulumi — Pulumi Docs](https://www.pulumi.com/docs/iac/operations/continuous-delivery/github-actions/)
- [Atlantis — GitHub](https://github.com/runatlantis/atlantis)
- [Pulumi pricing](https://www.pulumi.com/pricing/)
- [State and Backends — Pulumi Docs](https://www.pulumi.com/docs/iac/concepts/state-and-backends/)
- [Pulumi Cloud vs. OSS — Pulumi Docs](https://www.pulumi.com/docs/iac/guides/basics/pulumi-cloud-vs-oss/)
- [Detecting and reconciling drift — Pulumi Docs](https://www.pulumi.com/docs/iac/operations/stack-management/drift/)
- [GitOps Best Practices I Wish I Had Known Before — Pulumi Blog](https://www.pulumi.com/blog/gitops-best-practices-i-wish-i-had-known-before/)
