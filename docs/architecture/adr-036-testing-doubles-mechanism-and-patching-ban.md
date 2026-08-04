# ADR-036: Testing doubles — mechanism hierarchy, assertion target, and the in-place-patching ban

## Status

**ACCEPTED** — 2026-08-04

Task mt#3565. Governing decision recorded at ask#6775 (mechanism/tier menu) and ask#6885
(operator approval of the superseded, transitional-carve-out-now-empty success criteria,
2026-08-04). **Applies [ADR-026](adr-026-dependency-injection-convention.md) to the test estate
rather than amending it** — ADR-026 is silent on test doubles; both seam builds this record
authorizes are its `deps`-parameter convention verbatim.

## Context

By 2026-08-03 the test corpus had accreted **69 direct `spyOn(` call sites across 19 files** —
patching loggers, third-party module namespaces, Node/Bun builtins, and platform APIs — while
`testing-standards.mdc §Testable Design` stated the correct doctrine ("inject dependencies...
push side effects to the edges") the entire time, unreferenced by any enforcement surface. Three
things let it persist:

1. **The prescribed alternative did not exist.** `bun-test-patterns.mdc` told readers to import
   `createSpy` from `src/utils/test-utils/mocking.ts`; that module never exported it. Anyone
   following the rule hit a missing import and fell back to `spyOn`.
2. **The only mechanically enforced rule pointed the opposite way.** `no-jest-patterns.js`,
   registered at ESLint `"error"`, **autofixed** `jest.spyOn(x, 'y')` → `spyOn(x, 'y')` and its
   message read as endorsement. A prose rule contradicted by an error-level autofix is dead text
   — the gradient of enforced surfaces pointed away from the doctrine on every one of the 69
   sites (mem#834).
3. **Production code was twice reshaped to keep spies working.** `packages/shared/src/logger.ts`
   converted `log` from a `Proxy` to a plain forwarding object under mt#1859 specifically because
   "bun's `spyOn` installs the patched method through a native path that bypasses proxy traps, so
   the spy landed nowhere." The same file pair (`postgres-notice-handler.test.ts` /
   `postgres-provider.test.ts`) broke on this exact mechanism twice — once as mt#1859, again as
   mt#3561's Bun-1.3.14 order-dependent leak.

### What the 69-site audit found

A per-site close read (not just a by-target census) classified every call by **why** it existed,
not just what it patched:

| Why-class                                                                                                                    | Sites | Necessary?                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------- |
| The patched call IS the SUT's entire observable contract (routing, redaction, channel choice, structured degradation events) | ~35   | Only if no other observable exists                                                                 |
| Fault injection into a global the SUT reaches directly (make `log.debug` throw to test a swallow contract)                   | ~7    | Only if no seam to inject the fault                                                                |
| Silencing test noise, no assertion on the spy                                                                                | ~9    | No — dead weight; the test harness already silences console output via `TEST_LOGGER_SILENCED_FLAG` |
| Missing seam for a real injection point (`execFile`, `aiModule.*`, `embeddingServiceFactory`)                                | 15    | No — a one-file constructor/`deps` parameter change removes the need entirely                      |
| Control-flow capture (`process.exit` → throwable, for `never`-typed gate functions)                                          | 2     | Only if the guard has no return-based decision shape                                               |
| Argument capture on a spawn call                                                                                             | 1     | Only if no return-based observable exists                                                          |

The largest class (~35) looked, at first pass, like a permanent carve-out: loggers are
import-time singletons with no injection seam, hook scripts are seamless standalone CLIs, and
platform APIs (`navigator.clipboard`, `process.exit`) have no return-value observable in the test
environment. Re-pricing at **cluster** grain rather than per-site overturned that: every spawn
touchpoint lives in one file, every log call funnels through one winston facade, and
`CopyId.test.tsx` already imports the library (`@testing-library/user-event`) that solves its
clipboard case. Four cluster-level moves retire nearly the entire class for the cost of 1–2
production files each.

**The operator's reframe went one step further than "seam it."** Evaluating each site against
the code _as designed_ — even with a capture-seam available — was still answering the wrong
question: why is a log line, or any single collaborator call, anyone's sole observable at all?
The answer, traced back: the silent-failure incident family (mem#682) produced "failure must be
loud" requirements; loudness was implemented as a structured log event because the log was the
channel at hand; tests then had to observe the logger to pin the requirement. Each step was
locally reasonable. The corrected target is **functional core, imperative shell**: extract the
decision logic (transition dedup, severity routing, sweeper-outcome classification) into a pure
function tested on its **return value**; keep a thin shell that emits the side effect; add **one
wiring test per shell** ("the shell emits what the core decided") so the seam-tested-but-unwired
failure class (mem#305/mem#620, mt#2508) doesn't reopen. The capture-seam mechanism survives only
as the implementation of those wiring tests, not as the migration target for the ~20 behavioral
assertions that used to live on spy call arguments.

**The migration is done.** mt#3622 (14 tier-1/2 sites: `execFile`, `aiModule`), mt#3628/mt#3629
(functional-core extraction waves), mt#3630 (hooks decision-return + injectable spawn) — six
merged PRs. Verified on `main` at `2685a50b8` (2026-08-04T07:25Z): **zero `spyOn` invocations and
zero `spyOn` imports** across `src/`, `packages/`, `tests/`, `.minsky/hooks/`. The 17 remaining
textual matches are 11 comments and 6 test-name strings recording that the migration happened.
This record exists to fix the policy/documentation half that let the corpus reach 69 in the first
place, so a re-accretion can't happen silently again.

### Bun-specific mechanics (why this repo can't treat spying the way Jest projects do)

Bun's `spyOn`/`mock.module` patch through **engine-internal symbol-table mutation** rather than a
managed mock registry. Three consequences, verified against this repo's own incident history:

- **ECMA-262 makes most object properties non-writable by default**; Jest and Sinon detect this
  and throw a clear error. Bun's engine-level patch bypasses that check — which is exactly why
  mt#1859 had to reshape `logger.ts` from a `Proxy` to a plain object: the Proxy's trap-based
  writability was invisible to Bun's patch path, so the spy silently no-op'd.
- **Bun has no `restoreMocks`-equivalent global config.** Jest's `restoreMocks: true` in
  `jest.config` guarantees every spy is torn down between tests with no per-test discipline
  required. Bun requires the test author to get the restore right by hand, every time.
- **One module registry is shared across every test file in a run.** A spy that survives past
  its owning test's `afterEach` (a reassigned holder variable, a missing `mockRestore()`) leaks
  into whichever test runs next against the same collaborator — this is the literal mechanism of
  mt#3561's Bun-1.3.14 order-dependence bug and the (verified, unrestored) latent defect found in
  `CopyId.test.tsx` during this task's audit.

This justifies a **mandatory restore protocol** wherever patching is used at all; it does not, by
itself, justify banning patching outright — that conclusion rests on the functional-core
reframe above, not on Bun's mechanics.

### Why the third-party-module carve-out is rejected

One workstream argued that patching a well-maintained third-party library's own export surface is
defensible in a way patching a codebase's own logger is not — Jest and Sinon can't even attempt
it (non-writable properties), so "if it works, it must be a legitimate surface." That argument
answers "which patch lands," not "which patch couples the test to a surface likely to shift
without notice." A third-party package's unversioned internal export shape is exactly the kind of
surface the don't-mock-what-you-don't-own doctrine (Freeman/Pryce; the vendor-mock counter-pattern
— MSW at the HTTP boundary, a vendor-authored fake) says not to reach into. The counter-check: can
the same call-argument assertions be made against an injected fake instead of a patched
namespace? For every site audited here (the `ai` SDK's `generateText`/`streamText`/
`generateObject`), yes — `DefaultAICompletionService` already took only `configurationService` in
its constructor; adding an optional `deps` parameter defaulting to the real imports is one
production file, no exported-type widening, non-breaking for all existing call sites. Where
injection is this cheap, the "it happens to work" defense for patching carries no weight.

## Decision

### 1. Mechanism hierarchy

Prefer, in this order: **a real dependency running in a sandboxed environment** (rare — a real
temp git repo, a real SQLite file — already this repo's stated hermeticity default per mem#316)
**> an injected recording double (a fake constructed and handed in via `deps`)** **> in-place
patching of a collaborator the code reaches itself.** The third tier is not banned because it is
low-quality engineering; it is banned because, per the reframe above, needing it is design
feedback about the production code, not a testing limitation.

### 2. The applicable rule (first "yes" decides)

1. **Third-party module export slot** (`import * as x from "some-package"` then patching
   `x.someExport`)? **Patching banned, unconditionally.** Build the injection seam (rule 2) or
   escalate if genuinely impossible.
2. **A seam exists, or can be added by changing ≤1 production file with no exported-type change**
   (an optional `deps` parameter with a real default counts as no change, per ADR-026 rule 2)?
   **Use or build it; patching banned at this site.**
3. **A seam would widen an exported type or touch ≥2 production files?** Case-by-case. Default to
   building the seam when the test asserts on **calls** (arguments, call count, call order);
   patching is acceptable only when it stubs purely for isolation with no call-shape assertion.
   Record the reason inline, or file a task, when patching is chosen here.
4. **Otherwise** (an owned singleton with no return-value observable, a Node/Bun builtin inside a
   standalone script with no DI container, a platform API the test environment can't otherwise
   observe): in-place patching **would be** sanctioned, subject to:

   - **(i) Restore protocol** — the spy is created in the test body or `beforeEach`, restored in
     `afterEach` (or via `restoreAllMocks()`), and its holder variable is never reassigned across
     tests.
   - **(ii) Assertion-target rule** — assert on the call only when the call is the sole observable
     trace of the behavior under test (a swallow contract, an emitted structured event, a channel
     choice). Where a return value or a state change exists instead, assert on that.

   **Tier 4 is currently empty.** The functional-core/imperative-shell reframe (Context, above)
   found that every site previously read as belonging here — logger contracts, hook-script spawn
   calls, clipboard writes, `process.exit` gates — resolves instead to: extract a pure decision
   core tested on its return value, keep one wiring test per shell using an injected sink/seam
   (never a patched collaborator), or (for `process.exit`) a decision function returning
   `{ exitCode, record }` behind a thin never-typed dispatch shell. No call site in the verified
   2026-08-04 corpus needs tier 4. New code should not add one without first checking whether the
   same extraction applies — if it genuinely doesn't, rule 4's two conditions govern that new
   site and it should be flagged for reviewer sign-off (§Enforcement).

### 3. Functional core, imperative shell

Push decision logic that used to require observing a collaborator call into a pure function that
**returns** the classifiable result; keep production code as a thin shell that acts on that
return value. Test the core directly (no mocking needed — it's pure). Add exactly **one wiring
test per shell** confirming the shell emits/acts on what the core decided, using an injected sink
or seam — never a patched collaborator. This is not optional cleanup: the seam-tested-but-unwired
production defect (mem#305, mt#2508; the reviewer service ran with a dead check-run binding for
~5 weeks, mt#2076→mt#2757) is this repo's other dominant incident class, and skipping the wiring
test reopens it.

### 4. Support vs. diagnostic logging (Khorikov's split)

- **Support logging** — a log event the system is contractually required to emit (a
  transition-only warn bound, a severity-channel choice, a structured degradation event, a
  security-relevant redaction) — is testable as **fact-of-emission**: assert an event with the
  right structured fields was emitted, via an injected sink (rule 2's seam), never via a patched
  logger.
- **Developer diagnostic logging** — has no behavioral contract. Do not test it: no spy, no
  captured-output assertion, no message-string check.
- **Never assert on message-string formatting** for either class. `testing-boundaries.mdc
§Console Output`'s prior text read as a blanket ban on testing logging at all; that overstated
  the correct rule and is corrected in the same PR as this ADR.

### 5. Bun rationale carries into the restore protocol, not into the ban

The mechanics in Context (non-writable-property bypass, no `restoreMocks` equivalent, one shared
module registry) justify rule 2(i)'s restore protocol wherever tier 4 is genuinely reached. They
do not, alone, justify the ban in §2.1–§2.2 — that rests on the mechanism hierarchy (§1) and the
functional-core reframe (§3), which apply independent of which test runner is in use.

## Enforcement

A new ESLint rule bans direct `spyOn(` calls in test files at `"error"`, with a companion check
that a `spyOn`-derived variable is paired with a `.mockRestore()` (or the file calls
`restoreAllMocks()`) — defense-in-depth for the tier-4-reopens-someday case, since the ban message
alone doesn't teach the restore discipline. Verified zero pre-existing violations against `main`
at `2685a50b8` (§Context), so the rule ships directly at `error` — no `warn` phase, no
per-site carve-out list to maintain.

**Naming is principal-reserved.** This ADR and the shipping PR use a descriptive working name for
the rule file and messageId prefix; treat both as renameable without requiring another ADR
revision — see the PR body for the exact working name in use.

`eslint-rules/no-jest-patterns.js`'s `jestSpyOn` message and autofix are updated in the same PR:
the autofix previously rewrote `jest.spyOn(x, 'y')` → `spyOn(x, 'y')`, which is exactly the
now-banned form — autofixing toward a banned mechanism. The autofix is removed; the message now
cites this ADR instead of describing `spyOn` as a landing pattern in its own right.

A reviewer-facing escalation path (not a lint-level one) covers the case where rule 3's
case-by-case judgment or rule 4's now-empty carve-out genuinely needs to be re-opened for a new
site: mark it inline (`// eslint-disable-next-line <rule-name> -- <reason>`) and it surfaces in
review per the reviewer's existing test-shape checks (mt#3631).

## Consequences

**Easier**

- One document answers "can I `spyOn` here?" — previously four documents disagreed
  (`bun-test-patterns.mdc`, `testing-boundaries.mdc`, mem#316, and the error-level
  `no-jest-patterns` autofix pointing the opposite way).
- New test code that would have reached for a spy gets a mechanical nudge toward the seam it
  should have had anyway, at write time rather than after 69 sites have accreted.
- The mt#1859 pressure — reshaping production code (`logger.ts`) to stay spy-compatible —
  releases now that spying itself is gone from the corpus.

**Harder / accepted costs**

- A genuinely tier-4-shaped new site (no return-value observable, no DI container in scope) still
  needs a documented exception and reviewer sign-off rather than a quick `spyOn` — that friction
  is deliberate; it is what keeps tier 4 empty by making the decision visible instead of silent.
- Bun's test-double story is young and still spec-divergent (open isolation bugs, no
  `restoreMocks` equivalent). If Bun ships an equivalent, §5's restore-protocol rationale should
  be revisited — the ban in §2 does not depend on it and would be unaffected.

## Cross-references

- **Applies:** [ADR-026](adr-026-dependency-injection-convention.md) — the `deps`-parameter
  convention this record's seam-building rules use verbatim; ADR-026 does not mention test
  doubles and is not amended by this record.
- **Originating task:** mt#3565 (this ADR + the doc/lint work); ask#6775 (mechanism/tier
  research); ask#6885 (operator approval of the superseded success-criteria set, 2026-08-04).
- **Migration (shipped, not redone here):** mt#3622, mt#3628, mt#3629, mt#3630 (six merged PRs,
  69→0 sites). mt#3631 (reviewer test-shape checks). mt#3632 (design-time delivery of
  `testing-standards.mdc §Testable Design`; the `no-jest-patterns` message re-point this record
  extends; the mem#316 reconciliation).
- **Memory:** mem#316 (Testing practices — updated by this PR to cite this ADR instead of "the
  testing-doubles ADR (mt#3565), not yet shipped"); mem#834 (2026-08-03 testability
  retrospective — root-cause analysis this record's Context section draws on); mem#305/mem#620
  (seam-tested-but-unwired incident class — the reason §3 mandates a wiring test per shell);
  mem#682 (silent-failure-must-be-loud incident family — the origin of the log-as-contract
  accretion this record's reframe addresses).
- **Incidents this record is a response to:** mt#1859 (logger reshaped to accommodate a spy,
  2026-05), mt#3561 (the same file pair broke again under Bun 1.3.14's test shuffle, 2026-08-01
  — the proximate trigger for this task).
- **Rule files amended in the same PR:** `.minsky/rules/bun-test-patterns.mdc` (removes the
  phantom `createSpy` prescription), `.minsky/rules/testing-boundaries.mdc §Console Output`
  (replaces the blanket-ban framing with the support/diagnostic split in §4 above).
