# ADR-035: A failed initializer must not be memoized as a value

## Status

**ACCEPTED** — 2026-08-03

Task mt#3646, recording the finding of audit **mt#3637**. **Extends [ADR-002](adr-002-persistence-provider-architecture.md)**
by fixing the layer its graceful-degradation constraint belongs to, and generalizing that constraint
past persistence. Continues the direction of [ADR-018](adr-018-domain-persistence-pattern.md) and
[ADR-027](adr-027-postgres-only-persistence-confirmed.md) (no silent fallback).

## Context

On 2026-08-03 three unrelated Minsky subsystems failed within one working day, all triggered by the
same transient `getaddrinfo ENOTFOUND` resolver blip, all with the same outcome: a process that came
up, stayed up, served a degraded surface for its entire lifetime, and recovered only on restart.

mt#3637 audited them and reached an explicit **one-class** verdict. The class is _not_ the one the
originating report named ("nothing retries"). Retry is downstream. The defining property is:

> A composition root converts an initialization **failure** into a substitute **value**, and its own
> memoizer then cannot distinguish that value from a success.

|                                                                                                     | Instance 1 — Telegram principal channel                                      | Instance 2 — cockpit daemon DB pool                             | Instance 3 — MCP persistence provider                                                                                                         |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Owning task                                                                                         | mt#3608                                                                      | mt#3638 (after mt#3563 / mt#3592 / mt#3398)                     | mt#3635 + mt#3636                                                                                                                             |
| Network-dependent resolve at startup                                                                | `spawnSync("pulumi", ["config","get",…])`                                    | pool init / first query                                         | `PersistenceService.initialize()`                                                                                                             |
| Failure converted to a value                                                                        | `return null` — `src/cockpit/principal-channel-launch.ts:474-480`            | wedged pool retained as live                                    | `return new UnconfiguredPersistenceProvider(reason, true)` — `packages/domain/src/composition/domain.ts:138`                                  |
| Value memoized for process lifetime                                                                 | never re-called                                                              | pool singleton                                                  | `tsyringe.register(key, {useValue})` — `packages/domain/src/composition/container.ts:276`                                                     |
| **A recovery mechanism already existed, and the conversion put the failure where it cannot see it** | the resolver caches only success and is safe to re-call — and is called once | the mt#3592 socket inactivity bound was running and never fired | mt#2945's `deferredKeys` / `retryDeferred` is populated **only on a throw** (`container.ts:286-291`), so the local catch makes it unreachable |
| Recovery                                                                                            | restart                                                                      | restart                                                         | restart                                                                                                                                       |

Warrant, per `claim-confidence.mdc`: instances 1 and 3 are **verified-1a** (read against `main` at
`ededc3cd3`). Instance 2 is **strong-evidence** — its probe evidence comes from mt#3638's record
rather than direct observation here, and mt#3638 labels its own socket-level micro-mechanism
`inferred`.

**The last row is why this is one class rather than three bugs.** In each case the subsystem already
had, or had just been given, machinery for exactly this failure. A local `catch` that returned a
substitute value placed the failure somewhere that machinery structurally cannot reach. Two prior
fixes in this same family — mt#2945 (the container self-heal) and mt#2949 (the loud
configured-but-unavailable discriminator) — both shipped and both failed to contain the 2026-08-03
recurrence, because each closed a different half of the problem than the one the local catch opens.

### Why ADR-002 governs, and what it actually said

ADR-002 is the accepted record covering this decision for persistence, and it does not license the
behavior above. It assigns degradation to the **command** layer, three separate times:

> §Technical Constraints: "**Graceful degradation**: Commands should fallback when possible rather
> than fail completely"

> §Operational Benefits: "**Graceful degradation**: Commands implement fallback strategies
> appropriate to their domain"

> §Architecture Invariants, item 5: "**Commands own fallback strategies**: No central requirement
> coordination needed"

All three instances degrade at the **infrastructure** layer instead: one placeholder is substituted
for every consumer at once, and no consumer gets to decide. That is a layer transposition of ADR-002's
constraint, not an application of it. It also contradicts ADR-002 §Architecture Invariants item 3 —
"**Context provides guaranteed dependencies**: Database commands always receive initialized provider"
— since a command receives the placeholder while the type asserts an initialized provider.

ADR-027 points the same way, recording `unconfigured-provider.ts` as _"the boot-tolerant replacement
that surfaces a clear 'PostgreSQL configuration required' error instead"_ of a silent fallback. The
placeholder was introduced to make failure **loud**. A read path that answers `{tasks: [], total: 0}`
through it is a regression against its own charter.

**Why a new record rather than an amendment.** ADR-002's subject is persistence. Two of the three
instances are not persistence — a Telegram credential read and a daemon connection pool — so the
constraint has to live somewhere that governs all of them.

## Decision

**1. A composition root must not register a substitute value for a failed initialization without
also registering the retry.** Either propagate the failure, so the container's existing
`bootDeferrable` path memoizes it _as a failure_ and `get()` re-attempts; or register the placeholder
**and** arm its retry in the same act. Never the placeholder alone.

The practical consequence is that **retry belongs to the container**, which already implements it,
rather than being re-derived per subsystem. Three hand-rolled retry loops in this family is the
symptom this rule retires.

**2. Degradation is a decision for the consumer, not a substitution made on its behalf.** This
restates ADR-002 §Architecture Invariants item 5 at the layer where it was being lost. A shared
infrastructure placeholder handed to every consumer at once is not "commands own fallback
strategies"; it is the central coordination that invariant says is unnecessary.

**3. "Configured but failing" MUST be distinguishable from "not configured."** These are different
states with different correct responses: the second is a quiet, expected local/dev boot path; the
first is a fault. This is already implemented twice, derived independently:

- `UnconfiguredPersistenceProvider.configuredButUnavailable` (mt#2949)
- `CredentialRead` / `PrincipalChannelResolution.transient` (mt#3608)

Two independent derivations of the same discriminator, four months apart, in different subsystems, is
the evidence that it belongs in a standing rule rather than in each subsystem's head.

**4. A subsystem with a network-dependent initializer must expose a uniform status shape on its
liveness surface**, carrying at minimum:

| Field           | Meaning                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`          | `connected` \| `unconfigured` \| `unavailable` — the three states rule 3 requires be distinct. `unconfigured` is healthy; `unavailable` is not |
| `reason`        | The underlying error, when `mode` is `unavailable`                                                                                             |
| `lastAttemptAt` | When re-initialization was last attempted — absent means never retried since boot                                                              |

`assessPersistenceHealth`'s `PersistenceHealthMode` (`packages/domain/src/persistence/health.ts`) is
the existing shape for the first two fields; mt#3608 added a sibling `principalChannel` field to the
same `/api/health` payload. `lastAttemptAt` is the addition — without it, "stuck since boot" and "still
retrying against a real outage" are indistinguishable to an operator, which is the specific
confusion mt#3635 criterion 3 names.

**5. An honest health surface does not discharge rules 1-4.** mt#3637 F4 establishes this with
evidence rather than assertion: surface honesty was already shipped in two of the three instances
and neither stopped being expensive.

- Instance 2's surface was honest — `db: "degraded"` across 501 consecutive polls — and the daemon
  still ran 40+ minutes with every DB route hung.
- Instance 3's `/health` was honest — `{healthy: false, mode: "unavailable"}` — while the MCP data
  plane answered `tasks_list` with `{tasks: [], total: 0}`.

So three distinct obligations, and satisfying one is not evidence for the others: **surface honesty**
(is the probe truthful?), **recovery** (does anything act on it?), and **data-plane honesty** (does
the tool a caller actually invokes tell the truth?). The third is the sharpest: a truthful `/health`
is not read by an agent calling `tasks_list`, and a read that answers "not found" for a row that
exists invites the caller to act on it.

## Consequences

**Easier**

- A transient boot-time blip stops being a lifetime outage without each subsystem writing its own
  retry.
- An operator can tell a stuck initializer from a live outage, from the liveness surface alone.
- A reviewer has a citable rule for the `catch → return placeholder` shape, which currently reads as
  ordinary defensive code.

**Harder / accepted costs**

- Propagating a failure instead of substituting a placeholder means a boot path that previously
  "worked" now surfaces an error. That is the intent, but it will look like a regression the first
  time it fires, and the `unconfigured` vs `unavailable` distinction (rule 3) is what keeps a laptop
  without a DB, and the bundle-boot-smoke CI gate, from being bricked by it.
- Rule 4 asks subsystems to converge on a status shape they currently define ad hoc.

**Rejected alternative: a static lint rule.** A rule of the form "a `catch` under `**/composition/**`
that returns a value must also register the key for retry" was considered and rejected (mt#3637 F7).
It would have caught instance 3 and neither of the others — instance 1's `return null` is not in a
composition root, and instance 2 has no catch at all. Note also that the nearest existing rule,
`custom/no-silent-catch` (mt#3299), does **not** cover this class: it is satisfied by a catch that
logs, and all three instances log. Not worth its false-positive budget as a standalone mechanism.

**Preferred mechanization: a runtime detector**, gated on rule 4's uniform shape — "any subsystem
reporting `unavailable` for longer than N with no `lastAttemptAt` since boot." Rule 4 is therefore
both the operator-facing requirement and the precondition for mechanizing this ADR. Not authorized
here; file it when the shape has landed in more than one subsystem.

**Known deviation, named rather than fixed.** ADR-002 §"Alternative 3: Global Eager Initialization"
was **rejected**. `TsyringeContainer.initialize()`
(`packages/domain/src/composition/container.ts:266-296`) resolves every registration at boot, which
is that shape. ADR-002's stated grounds for rejecting it were performance ("Wastes database
connections for non-database commands"), not resilience, and [ADR-026](adr-026-dependency-injection-convention.md)
postdates it without re-deciding. This ADR records the inconsistency; acting on it is separate work
and is not authorized here.

**Consistency check against `decision-defaults.mdc §Reliability`.** That frame prefers
"sweeper+ack-immediate+drain, not a durable queue" — reconcile against an external source of truth
rather than replicating state locally. Rule 1 is the same idea applied to initialization: do not
durably hold a failed init as though it were state; re-derive from the external source of truth (the
database, Pulumi) on next use. No conflict, and no fresh design was needed.

**This ADR blocks nothing.** It is a decision record. mt#3608 (in review), mt#3638, mt#3635, and
mt#3636 ship independently of it, and mt#3608's already-implemented bespoke retry is correct as
written — rule 1 is about what the _next_ one should do, not a reason to hold that fix.

## Cross-references

- **Extends:** [ADR-002](adr-002-persistence-provider-architecture.md) §Technical Constraints,
  §Operational Benefits, and §Architecture Invariants items 3 and 5.
- **Continues:** [ADR-018](adr-018-domain-persistence-pattern.md),
  [ADR-027](adr-027-postgres-only-persistence-confirmed.md) — no silent fallback.
- **Considered, non-governing:** [ADR-014](adr-014-cockpit-daemon-lifecycle-ownership.md) owns daemon
  _process_ supervision, not in-process initializer state.
- **Originating audit:** mt#3637 (findings F1-F7 carry the evidence this record rests on; F6 carries
  the line-level mechanism for instance 3, F7 the detector analysis).
- **Instances:** mt#3608 (channel), mt#3638 (daemon pool recovery), mt#3635 (persistence recovery),
  mt#3636 (persistence data-plane honesty).
- **Prior fixes in this family that did not contain it:** mt#2945 (container self-heal — built the
  retry the local catch makes unreachable), mt#2949 (the `configuredButUnavailable` discriminator and
  the honest `/health`).
- **Adjacent, deliberately excluded (mt#3637 F2):** mt#1427 (MCP server caches `config.yaml` at boot).
  Its read _succeeds_; the defect is staleness-after-success, not failure-frozen-as-a-value. Staleness
  wants invalidation; this class wants failure propagation.
  **Class owner (added mt#4185):** the excluded class had no owner for four months, and mt#1427 is
  one narrow instance in a different subsystem rather than a stand-in for it. In the cockpit daemon
  the class is now owned by the sweep-liveness registry: `createIntervalSweeper` /
  `registerSelfSchedulingSweep` make every long-lived loop's `lastAttemptAt` datable, and
  `startSweepMetaWatchdog` acts on it. That is what rule 4's `lastAttemptAt` is for — the field
  without which "stuck since boot" and "still retrying" are the same reading — applied to a loop
  rather than to an initializer. Originating recurrence: mt#4183, where `principalChannel` reported
  `running` for ~44 hours after its poller stopped, with no field a reader could date.
