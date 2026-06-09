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
 * failure error. Symbols, `then`, and `constructor` return undefined (so the
 * placeholder isn't mistaken for a thenable and inspection works); `toString` /
 * `valueOf` / `toJSON` return a safe stringifier so logging the service is fine.
 */
function makeDeferredFailurePlaceholder(key: string, message: string): object {
  const fail = (): never => {
    throw new Error(
      `Service "${key}" is unavailable: it could not be constructed at startup because a required resource is not configured. ${message}`
    );
  };
  const label = `[unavailable service "${key}"]`;
  // A callable target so the apply/construct traps are valid for service
  // placeholders that may be invoked as functions or constructors.
  const target = function placeholder() {};
  return new Proxy(target, {
    get(_t, prop) {
      // Benign introspection — never throw, and don't return a throwing function
      // (so stringify / await / prototype lookups behave normally).
      if (typeof prop === "symbol" || prop === "then" || prop === "constructor") {
        return undefined;
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
    return this.tsyringe.resolve(key) as AppServices[K];
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
  }
}
