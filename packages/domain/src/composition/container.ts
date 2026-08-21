/**
 * Typed DI Container — tsyringe-backed
 *
 * Wraps tsyringe's DependencyContainer to implement AppContainerInterface.
 * Preserves the existing register/get/set/initialize/close lifecycle while
 * delegating resolution to tsyringe.
 *
 * The async initialize() pattern is not native to tsyringe (which resolves
 * synchronously). We handle it by running factories during initialize() and
 * registering resolved instances into tsyringe with useValue.
 *
 * @see mt#842 — Phase D: tsyringe adoption
 */

import { container as rootContainer, type DependencyContainer } from "tsyringe";

import type {
  AppServices,
  ServiceKey,
  ServiceFactory,
  RegisterOptions,
  AppContainerInterface,
} from "./types";

interface Registration<T> {
  factory: ServiceFactory<T>;
  dispose?: (instance: T) => Promise<void>;
}

/**
 * True when an error carries the structural `bootDeferrable` marker — used by
 * `initialize()` to distinguish "resource not configured at boot" (defer to
 * use-time) from real wiring bugs (fail fast). The marker is checked
 * structurally so this generic container layer stays decoupled from the
 * persistence layer that raises it (see `PersistenceUnavailableError`).
 */
function isBootDeferrable(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { bootDeferrable?: unknown }).bootDeferrable === true
  );
}

/**
 * Structural view of a substitute value a factory RETURNED in place of a failed
 * initialization (mt#3635 / ADR-035 rule 1: "a composition root must not
 * register a substitute value for a failed initialization without also
 * registering the retry").
 *
 * The mirror image of {@link isBootDeferrable}: that marks a failure that was
 * THROWN, this marks one that was CONVERTED INTO A VALUE. A thrown failure is
 * enrolled for retry by `initialize()`'s catch branch; before this, a returned
 * one was indistinguishable from a successful resolution and so could never be
 * enrolled — which is precisely why the self-heal below existed for two months
 * without ever being reachable for the `persistence` key.
 *
 * Checked structurally, for the same decoupling reason `isBootDeferrable` is
 * (see `DegradedSubstitute` in `../persistence/unconfigured-provider`, the
 * persistence-side contract this mirrors).
 */
interface DegradedSubstituteLike {
  degradedSubstitute: boolean;
  noteRetryAttempt(at: Date, error: string): void;
}

function asDegradedSubstitute(value: unknown): DegradedSubstituteLike | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<DegradedSubstituteLike>;
  if (candidate.degradedSubstitute !== true) return null;
  if (typeof candidate.noteRetryAttempt !== "function") return null;
  return candidate as DegradedSubstituteLike;
}

/**
 * Floor between re-initialization attempts for one key (mt#3635).
 *
 * `get()` fires a retry opportunistically, so on a busy process the only thing
 * bounding attempt RATE would otherwise be call rate. Grounded in observed
 * cadence per `decision-defaults.mdc §Thresholds`: the originating outage was a
 * ~20 s DNS blip, so a 10 s floor recovers within about one blip-length of the
 * condition clearing while capping attempts at 6/min under any call volume.
 */
export const RETRY_MIN_INTERVAL_MS = 10_000;

/**
 * Ceiling for the exponential backoff. Bounds a LONG outage: the 2026-07-19
 * five-hour outage (mem#636) would see ~60 attempts at this cap rather than
 * ~1,800 at the floor, while still recovering within 5 minutes of the database
 * coming back.
 */
export const RETRY_MAX_INTERVAL_MS = 5 * 60_000;

/** Per-key backoff bookkeeping for {@link TsyringeContainer.retryDeferred}. */
interface RetryState {
  /** Monotonic ms of the last attempt, or null when none has run yet. */
  lastAttemptAtMs: number | null;
  /** Delay that must elapse before the next attempt. */
  delayMs: number;
}

/**
 * Build a placeholder for a service whose construction was deferred because a
 * required resource (Postgres) was unavailable at boot.
 *
 * Design (per PR #1647 review): property READS are benign — they never throw —
 * so light-touch inspection (logging, stringification, capability/`in` probes,
 * `await`) doesn't spuriously crash and undermine boot-tolerance. Only actually
 * USING the service throws: a normal property read returns a function that
 * throws when CALLED, so `service.someMethod()` surfaces the clear deferred-
 * failure error. Symbols and `then` return undefined (so the placeholder isn't
 * mistaken for a thenable); `toString` / `valueOf` / `toJSON` return a safe
 * stringifier so logging the service is fine.
 *
 * `constructor` (mt#2945 fix): previously ALSO returned `undefined` here,
 * alongside `then`/symbols. That broke the common two-level diagnostic idiom
 * `service.constructor.name` used elsewhere in this codebase (e.g.
 * `session-context-resolver.ts`'s `log.debug` call) — reading `.constructor`
 * on the placeholder returned `undefined`, and then reading `.name` on THAT
 * threw a raw, opaque `undefined is not an object (evaluating
 * 'sessionProvider.constructor.name')` TypeError, crashing the whole call
 * before this placeholder's own clear "service unavailable" error ever got a
 * chance to fire (see mt#2945's root-cause writeup). `constructor` now
 * returns a benign, distinctly-named constructor-like function — a genuine
 * property read, consistent with every other benign-read prop — so
 * `.constructor.name` resolves to a readable string instead of throwing.
 *
 * Nested reads (mt#2945 PR #2113 R1 review): "any other property" previously
 * returned a bare `() => fail()` function — benign to READ, but a plain
 * function, so a caller chaining a FURTHER property off it (`service.foo.bar`)
 * got `undefined` rather than another benign, throws-on-call node. That's not
 * a crash, but it silently changes shape expectations for deeper inspection
 * idioms (nested capability objects, `Object.keys`, etc.). Every non-special
 * property now returns ANOTHER node built by the same recursive factory below,
 * so benign reads stay safe to ARBITRARY depth, while calling any node in the
 * chain still throws the same clear deferred-failure error.
 */
export function makeDeferredFailurePlaceholder(key: string, message: string): object {
  const fail = (): never => {
    throw new Error(
      `Service "${key}" is unavailable: it could not be constructed at startup because a required resource is not configured. ${message} ` +
        "If this resource has since become available, restart this process to pick it up " +
        "(for the MCP server, run `/mcp` to reconnect)."
    );
  };
  const label = `[unavailable service "${key}"]`;
  // Named per-key so `.constructor.name` is informative in logs rather than a
  // generic placeholder label — e.g. "UnavailablePlaceholder_sessionProvider".
  const constructorName = `UnavailablePlaceholder_${key.replace(/[^a-zA-Z0-9_$]/g, "_")}`;
  const placeholderConstructor = { [constructorName]: function () {} }[constructorName];

  // Recursive benign-chain node factory. Each node is a callable target
  // wrapped in the same benign-read / throws-on-call Proxy, so property
  // chains of any depth (`service.foo.bar.baz`) stay benign to read and only
  // throw the instant something in the chain is actually INVOKED.
  const makeNode = (): object => {
    // A callable target so the apply/construct traps are valid for service
    // placeholders that may be invoked as functions or constructors.
    const target = function placeholderNode() {};
    return new Proxy(target, {
      get(_t, prop) {
        // Benign introspection — never throw, and don't return a throwing function
        // (so stringify / await / prototype lookups behave normally).
        if (typeof prop === "symbol" || prop === "then") {
          return undefined;
        }
        if (prop === "constructor") {
          return placeholderConstructor;
        }
        if (prop === "toString" || prop === "valueOf" || prop === "toJSON") {
          return () => label;
        }
        // Any other property read is benign and returns ANOTHER benign node —
        // so `service.method()` fails clearly the instant it's invoked, while
        // a bare read at any depth (logging, existence/feature checks, nested
        // capability inspection) never crashes.
        return makeNode();
      },
      apply: () => fail(),
      construct: () => fail(),
    }) as object;
  };

  return makeNode();
}

export class TsyringeContainer implements AppContainerInterface {
  private readonly tsyringe: DependencyContainer;
  private readonly factories = new Map<string, Registration<unknown>>();
  /** Tracks registration order for sequential initialization and reverse-order disposal. */
  private readonly registrationOrder: string[] = [];
  /**
   * Keys currently resolved to a deferred-failure placeholder (mt#2945) —
   * populated by `initialize()` when a factory's `bootDeferrable` error is
   * tolerated. `get()` consults this set to kick off a best-effort background
   * re-resolution attempt, so a TRANSIENT outage at boot/reload time (e.g. a
   * Postgres connection pool that hasn't finished warming up yet) can self-heal
   * on a LATER call instead of staying wedged behind the placeholder for the
   * rest of the process's life (previously the only recovery path was a full
   * process restart / MCP reconnect).
   */
  private readonly deferredKeys = new Set<string>();
  /** Guards against overlapping retry attempts for the same key. */
  private readonly retryInFlight = new Set<string>();
  /**
   * Per-key backoff state (mt#3635). The in-flight guard above bounds
   * CONCURRENCY but not RATE — without this, a busy process retries a dead
   * dependency on every `get()`, which is the retry storm the spec forbids.
   */
  private readonly retryState = new Map<string, RetryState>();
  /**
   * Lifecycle generation, bumped by `close()` (PR #2603 R1).
   *
   * Both `retryDeferred()` and `reresolveDependents()` register an instance
   * AFTER awaiting a factory. If `close()` runs during that await, the pending
   * `register()` would land on a container that has already been torn down —
   * resurrecting a service after teardown, on a `tsyringe` instance that
   * `close()` just `reset()`. A boolean "closed" flag would make the container
   * permanently unusable after one close; a generation counter also lets a
   * re-`initialize()` proceed cleanly, because the stale task compares against
   * the value it captured at spawn rather than against "has close ever run".
   */
  private lifecycleEpoch = 0;
  /**
   * True while `initialize()` is walking the registration order (mt#3635).
   *
   * Retries are suppressed for the duration. A dependent's factory calls
   * `c.get("persistence")` DURING boot, which would otherwise kick off a retry
   * whose success path re-resolves that same dependent concurrently with the
   * boot loop's own resolution of it — two writers for one key, with the boot
   * loop's `register()` landing last and silently reinstating the value built
   * against the degraded provider. Enrollment happens at boot; retrying starts
   * once the container is up, which is also what "re-attempts on subsequent
   * use" means.
   */
  private initializing = false;
  /**
   * Keys explicitly overridden via `set()` (PR #2113 R2 review). Once a
   * caller has manually provided an instance for a key, NOTHING should
   * silently replace it — including a background `retryDeferred()` attempt
   * that was already in flight when `set()` was called. `set()` stops
   * FUTURE retries by clearing the key from `deferredKeys`, but an
   * in-flight retry's resolution callback still needs to check this set
   * before swapping in the factory's result, or it would clobber the
   * override the instant it settles.
   */
  private readonly manuallyOverridden = new Set<string>();

  constructor() {
    // Use a child container so each TsyringeContainer instance is isolated
    this.tsyringe = rootContainer.createChildContainer();
  }

  register<K extends ServiceKey>(
    key: K,
    factory: ServiceFactory<AppServices[K]>,
    options?: RegisterOptions<AppServices[K]>
  ): this {
    this.factories.set(key, {
      factory: factory as ServiceFactory<unknown>,
      dispose: options?.dispose as ((instance: unknown) => Promise<void>) | undefined,
    });
    // Track order — remove if re-registered to maintain last-registration position
    const idx = this.registrationOrder.indexOf(key);
    if (idx !== -1) this.registrationOrder.splice(idx, 1);
    this.registrationOrder.push(key);
    return this;
  }

  set<K extends ServiceKey>(key: K, instance: AppServices[K]): this {
    // mt#2945 R2: a manual override must never be clobbered by the
    // deferred-placeholder self-recovery mechanism. Stop future retries
    // (`deferredKeys`) and mark the key so any retry ALREADY in flight
    // discards its result instead of overwriting this override when it
    // settles (see the check in `retryDeferred`'s success path).
    this.deferredKeys.delete(String(key));
    this.manuallyOverridden.add(String(key));
    this.tsyringe.register(key, { useValue: instance });
    return this;
  }

  get<K extends ServiceKey>(key: K): AppServices[K] {
    if (!this.tsyringe.isRegistered(key)) {
      throw new Error(
        `Service "${String(key)}" is not available. ` +
          `Call initialize() first or use set() to provide an instance.`
      );
    }
    // mt#2945: a placeholder-backed key gets a best-effort, fire-and-forget
    // re-resolution attempt on every get() — cheap when it's still down
    // (the retry just fails again and the placeholder stays in place), and
    // self-healing when the underlying resource has recovered since boot.
    // This call never blocks or throws; it only affects FUTURE get() calls.
    if (!this.initializing && this.deferredKeys.has(String(key))) {
      this.retryDeferred(String(key));
    }
    return this.tsyringe.resolve(key) as AppServices[K];
  }

  /**
   * Best-effort, fire-and-forget re-resolution of a placeholder-backed
   * service (mt#2945). Runs at most once concurrently per key. On success,
   * swaps the tsyringe registration for the real instance so the NEXT get()
   * call returns healthy state — no restart required. On failure, the
   * placeholder stays in place and a later get() will try again.
   */
  private retryDeferred(key: string): void {
    if (this.retryInFlight.has(key)) return;
    const registration = this.factories.get(key);
    if (!registration) return;
    // Claim the key BEFORE the backoff computation (PR #2603 R1). As written,
    // every statement between the check above and this line is synchronous, so
    // the event loop cannot interleave a second caller into the window and the
    // race described in review cannot occur on this runtime. Claiming first is
    // hardening, not a bug fix: it keeps "at most one attempt in flight per
    // key" from silently depending on nobody ever introducing an `await` into
    // that window. The early return below MUST release the claim.
    this.retryInFlight.add(key);
    const epoch = this.lifecycleEpoch;
    // Backoff gate (mt#3635). `get()` calls this opportunistically on every
    // resolution of a deferred key, so without a floor the attempt rate is the
    // process's call rate — a retry storm against the very dependency that is
    // already failing. A blocked attempt costs one map lookup.
    const state = this.retryState.get(key) ?? {
      lastAttemptAtMs: null,
      delayMs: RETRY_MIN_INTERVAL_MS,
    };
    const nowMs = Date.now();
    if (state.lastAttemptAtMs !== null && nowMs - state.lastAttemptAtMs < state.delayMs) {
      // Release the claim taken above — holding it here would wedge the key
      // permanently in-flight and stop it from EVER retrying again, turning a
      // rate limit into the exact permanent degradation this task removes.
      this.retryInFlight.delete(key);
      return;
    }
    state.lastAttemptAtMs = nowMs;
    this.retryState.set(key, state);
    // NOTE: the factory call MUST happen inside this async IIFE's try block,
    // not as a bare expression passed to Promise.resolve(). A factory that
    // throws SYNCHRONOUSLY (the common case — see bootDeferrableError in
    // container.test.ts) would otherwise throw immediately out of
    // retryDeferred() itself (and therefore out of get()) before
    // Promise.resolve() ever got a chance to wrap it in a rejected promise.
    void (async () => {
      try {
        const instance = await Promise.resolve(registration.factory(this));
        // mt#2945 R2: if `set()` provided a manual override WHILE this retry
        // was in flight, that override must win — discard this result rather
        // than clobbering it. (A retry started BEFORE the override can only
        // reach here AFTER `set()` already ran, since this is the first
        // `await` boundary since the retry began.)
        if (this.manuallyOverridden.has(key)) return;
        // The container was closed (or closed and re-initialized) while this
        // factory was awaiting (PR #2603 R1). Registering now would resurrect a
        // service on a container that has already been torn down.
        if (this.lifecycleEpoch !== epoch) return;
        // Contract (PR #2113 R1 review): tsyringe's `register(token, {useValue})`
        // REPLACES any prior registration for the same token rather than
        // stacking a second binding — a single `useValue` registration is a
        // plain map-entry overwrite, not an additive multi-binding (multi-
        // binding requires tsyringe's separate `resolveAll`/`@injectAll` API,
        // which this container never uses; `get()` always calls the singular
        // `resolve()`). This call therefore deterministically swaps out the
        // placeholder for the real instance — no ambiguous resolution order,
        // and the placeholder becomes unreferenced (GC-eligible) once
        // overwritten. Regression-guarded by
        // container.test.ts's "a service that fails once then succeeds
        // resolves to the real instance on a later get()" — that test only
        // passes if this second `register()` call actually wins over the
        // first.
        this.tsyringe.register(key, { useValue: instance });
        // mt#3635: the factory may hand back ANOTHER degraded substitute —
        // the dependency is still down. That is not a success: keep the key
        // enrolled, record the attempt on the substitute so `persistence_check`
        // and `/health` can distinguish "stuck since boot" from "retried at
        // <ts> and still failing" (ADR-035 rule 4), and widen the backoff.
        const stillDegraded = asDegradedSubstitute(instance);
        if (stillDegraded) {
          stillDegraded.noteRetryAttempt(new Date(), `re-initialization failed for "${key}"`);
          this.widenBackoff(key);
          return;
        }
        this.deferredKeys.delete(key);
        this.retryState.delete(key);
        // The dependency recovered. Keys registered AFTER this one may have
        // captured the degraded value at their own construction time and are
        // memoized as `useValue`, so they would keep serving it forever — the
        // reason a healed `persistence` key alone does not restore
        // `taskService`. Rebuild them.
        await this.reresolveDependents(key);
      } catch (err) {
        // Still unavailable — leave the substitute in place and try again
        // later, on a widened delay. Record the attempt against the currently
        // registered substitute, if it is one, for the same reporting reason as
        // the still-degraded branch above.
        const current = this.tsyringe.isRegistered(key)
          ? asDegradedSubstitute(this.tsyringe.resolve(key))
          : null;
        current?.noteRetryAttempt(new Date(), err instanceof Error ? err.message : String(err));
        this.widenBackoff(key);
      } finally {
        this.retryInFlight.delete(key);
      }
    })();
  }

  /**
   * Double this key's retry delay, capped (mt#3635). Called on every attempt
   * that did not restore the dependency, so a long outage settles at the cap
   * instead of hammering at the floor for hours.
   */
  private widenBackoff(key: string): void {
    const state = this.retryState.get(key);
    if (!state) return;
    state.delayMs = Math.min(state.delayMs * 2, RETRY_MAX_INTERVAL_MS);
  }

  /**
   * Rebuild every key registered AFTER `recoveredKey` (mt#3635).
   *
   * `initialize()` resolves each key eagerly and memoizes it with
   * `useValue`, so a dependent that captured the degraded substitute at its own
   * construction time keeps serving it for the life of the process even after
   * the dependency recovers — `taskService` registers zero task backends when
   * built against a degraded provider, and swapping the provider underneath it
   * changes nothing. Re-running the dependents' factories is what actually
   * restores service.
   *
   * Registration order is a deliberate over-approximation: this container
   * tracks the order keys were registered but not a dependency graph, and a
   * factory's `c.get(...)` calls are opaque to it. Rebuilding a key that did not
   * actually depend on the recovered one is wasted work, not incorrect work.
   * (ADR-035 names the eager-resolution design itself as a known deviation and
   * explicitly does not authorize reworking it here.)
   *
   * Each key is rebuilt independently: one failing factory must not prevent the
   * rest from recovering. A key whose rebuild fails keeps its existing value and
   * is enrolled for its own retry if what it produced is itself degraded.
   *
   * ## Rebuilds run SEQUENTIALLY, awaited, in registration order (mt#4379)
   *
   * They were previously fired as unordered `void (async () => …)()` IIFEs, one
   * per dependent, and that is what produced mt#4379. `sessionDeps` awaits only
   * two module-cache imports before reading `c.get("taskService")`
   * synchronously, while `taskService`'s own rebuild awaits a real DB roundtrip
   * (`resolveProjectScope`). The fast dependent therefore re-registered while
   * still holding the OLD zero-backend `taskService` — and because a plain
   * bundle is not a degraded substitute, the `else` branch below then removed it
   * from `deferredKeys`, making it permanently ineligible for any further
   * rebuild. `session_start` served that frozen bundle for 20+ hours while every
   * per-call resolver in the same process healed normally.
   *
   * The order SOURCE is unchanged, and was never the defect — see the
   * over-approximation paragraph above. The field agrees on that point: OTP's
   * `rest_for_one`, systemd's unit ordering, and Kubernetes init containers all
   * restart by a DECLARED order rather than a runtime-discovered graph. What
   * they also do, and what this omitted, is walk that order SEQUENTIALLY,
   * awaiting each step before starting the next, so a later dependent cannot
   * observe an earlier one mid-rebuild.
   *
   * Awaiting is safe: the sole caller is already inside `retryDeferred`'s
   * fire-and-forget task, so this blocks no user-facing path.
   */
  private async reresolveDependents(recoveredKey: string): Promise<void> {
    const startIndex = this.registrationOrder.indexOf(recoveredKey);
    if (startIndex === -1) return;
    const epoch = this.lifecycleEpoch;
    const dependents = this.registrationOrder.slice(startIndex + 1);
    for (const dependentKey of dependents) {
      // A manual override is the caller's explicit instance — never clobber it,
      // the same contract `set()` establishes against in-flight retries.
      if (this.manuallyOverridden.has(dependentKey)) continue;
      const registration = this.factories.get(dependentKey);
      if (!registration) continue;
      try {
        const instance = await Promise.resolve(registration.factory(this));
        // Re-checked AFTER the await: an override may have landed while this
        // factory was in flight. `continue`, not `return` — the dependents
        // after this one are unaffected and still need rebuilding.
        if (this.manuallyOverridden.has(dependentKey)) continue;
        // Same teardown guard as retryDeferred (PR #2603 R1) — this is the
        // writer the review flagged: a rebuild spawned before `close()` would
        // otherwise re-register a dependent after the container was reset.
        // `return`, not `continue`: the container is gone, so every remaining
        // dependent is moot too.
        if (this.lifecycleEpoch !== epoch) return;
        this.tsyringe.register(dependentKey, { useValue: instance });
        if (asDegradedSubstitute(instance)) {
          this.deferredKeys.add(dependentKey);
        } else {
          this.deferredKeys.delete(dependentKey);
          this.retryState.delete(dependentKey);
        }
      } catch {
        // This dependent could not be rebuilt yet. Leave its current value in
        // place; if it is a deferred key it retries on its own schedule. Kept
        // per-key so one failing factory cannot strand the dependents after it
        // — the property the sequential walk must not cost us.
      }
    }
  }

  has<K extends ServiceKey>(key: K): boolean {
    return this.tsyringe.isRegistered(key);
  }

  async initialize(): Promise<void> {
    this.initializing = true;
    try {
      await this.resolveAllRegistrations();
    } finally {
      this.initializing = false;
    }
  }

  private async resolveAllRegistrations(): Promise<void> {
    for (const key of this.registrationOrder) {
      // Skip services already provided via set()
      if (this.tsyringe.isRegistered(key)) continue;

      const registration = this.factories.get(key);
      if (!registration) continue;

      try {
        const instance = await Promise.resolve(registration.factory(this));
        this.tsyringe.register(key, { useValue: instance });
        // mt#3635 / ADR-035 rule 1: a factory that CONVERTED a failure into a
        // substitute value resolved "successfully" as far as this loop is
        // concerned, so the catch branch below never sees it and the key was
        // never enrolled for retry. Enroll it here instead.
        //
        // The substitute stays REGISTERED rather than being swapped for the
        // throw-on-access placeholder: the diagnostic surface (`/health`,
        // `persistence_check`, `config_*`) has to keep answering while the data
        // plane is down — that is ADR-035 rule 5, and mt#3636 owns the
        // data-plane honesty half. Enrolling for retry and replacing the value
        // are independent, and only the first is wanted here.
        if (asDegradedSubstitute(instance)) {
          this.deferredKeys.add(key);
        }
      } catch (err) {
        // Boot-tolerant deferral (mt#2349): a factory may fail because a
        // required resource is unavailable at boot — specifically, the absence
        // of a configured Postgres connection (the former silent SQLite fallback
        // was removed). Such errors carry a structural `bootDeferrable` marker.
        // Defer ONLY those to use-time by registering a placeholder that re-throws
        // when the service is actually touched, so non-DB commands and `/health`
        // still boot. Every OTHER error (real wiring bug) aborts boot loudly,
        // preserving the fail-fast / no-DI-fallback discipline.
        if (isBootDeferrable(err)) {
          const message = err instanceof Error ? err.message : String(err);
          this.tsyringe.register(key, {
            useValue: makeDeferredFailurePlaceholder(String(key), message),
          });
          this.deferredKeys.add(key);
          continue;
        }
        throw err;
      }
    }
  }

  async close(): Promise<void> {
    // Invalidate in-flight retries and dependent rebuilds FIRST (PR #2603 R1),
    // before the first `await` below. Bumping after the disposal loop would
    // leave the whole loop as a window in which a settling background task
    // could still register onto a container being torn down.
    this.lifecycleEpoch += 1;
    // Dispose in reverse registration order (tear down leaves before roots)
    const keys = [...this.registrationOrder].reverse();
    for (const key of keys) {
      const registration = this.factories.get(key);
      if (registration?.dispose && this.tsyringe.isRegistered(key)) {
        const instance = this.tsyringe.resolve(key);
        if (instance !== undefined) {
          await registration.dispose(instance);
        }
      }
    }
    // Clear all registrations from the child container
    this.tsyringe.reset();
    this.deferredKeys.clear();
    this.retryInFlight.clear();
    this.retryState.clear();
    this.manuallyOverridden.clear();
  }
}
