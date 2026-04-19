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

      const instance = await Promise.resolve(registration.factory(this));
      this.tsyringe.register(key, { useValue: instance });
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
