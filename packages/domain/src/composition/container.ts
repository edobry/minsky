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
  // A callable target so the apply/construct traps are valid for service
  // placeholders that may be invoked as functions or constructors.
  const target = function placeholder() {};
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
      // Any other property read is benign and returns a function that throws
      // only when invoked — so `service.method()` fails clearly while a bare
      // read (logging, existence/feature checks) does not crash.
      return () => fail();
    },
    apply: () => fail(),
    construct: () => fail(),
  }) as object;
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
    if (this.deferredKeys.has(String(key))) {
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
    this.retryInFlight.add(key);
    void Promise.resolve(registration.factory(this))
      .then((instance) => {
        this.tsyringe.register(key, { useValue: instance });
        this.deferredKeys.delete(key);
      })
      .catch(() => {
        // Still unavailable — leave the placeholder in place, try again later.
      })
      .finally(() => {
        this.retryInFlight.delete(key);
      });
  }

  has<K extends ServiceKey>(key: K): boolean {
    return this.tsyringe.isRegistered(key);
  }

  async initialize(): Promise<void> {
    for (const key of this.registrationOrder) {
      // Skip services already provided via set()
      if (this.tsyringe.isRegistered(key)) continue;

      const registration = this.factories.get(key);
      if (!registration) continue;

      try {
        const instance = await Promise.resolve(registration.factory(this));
        this.tsyringe.register(key, { useValue: instance });
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
  }
}
