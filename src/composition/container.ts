/**
 * Typed DI Container
 *
 * A lightweight (~80 lines) container that maps service keys to factory functions,
 * caches resolved instances as singletons, and manages async lifecycle.
 *
 * Design decisions (see mt#761 spec):
 * - DIY rather than a library: the codebase is function-oriented with 18+ DI interfaces
 *   already in place. A 80-line container fits better than decorator-based frameworks.
 * - Async initialization is first-class: JS constructors can't be async, so TypeScript
 *   DI libraries punt on this. We make initialize() a core lifecycle method.
 * - Registration order = dependency order: factories are resolved sequentially during
 *   initialize(). Each factory can call container.get() to access earlier services.
 *   This is explicit and debuggable — no topological sort needed for ~20 services.
 * - Domain code never sees this container. It receives typed deps interfaces
 *   (SessionDeps, StartSessionDependencies, etc.) assembled by composition roots.
 */

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

export class AppContainer implements AppContainerInterface {
  private instances = new Map<string, unknown>();
  private registrations = new Map<string, Registration<unknown>>();
  /** Tracks registration order for sequential initialization and reverse-order disposal. */
  private registrationOrder: string[] = [];

  register<K extends ServiceKey>(
    key: K,
    factory: ServiceFactory<AppServices[K]>,
    options?: RegisterOptions<AppServices[K]>
  ): this {
    this.registrations.set(key, {
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
    this.instances.set(key, instance);
    return this;
  }

  get<K extends ServiceKey>(key: K): AppServices[K] {
    const instance = this.instances.get(key);
    if (instance !== undefined) return instance as AppServices[K];
    throw new Error(
      `Service "${String(key)}" is not available. ` +
        `Call initialize() first or use set() to provide an instance.`
    );
  }

  has<K extends ServiceKey>(key: K): boolean {
    return this.instances.has(key);
  }

  async initialize(): Promise<void> {
    for (const key of this.registrationOrder) {
      // Skip services already provided via set()
      if (this.instances.has(key)) continue;

      const registration = this.registrations.get(key);
      if (!registration) continue;

      const instance = await Promise.resolve(registration.factory(this));
      this.instances.set(key, instance);
    }
  }

  async close(): Promise<void> {
    // Dispose in reverse registration order (tear down leaves before roots)
    const keys = [...this.registrationOrder].reverse();
    for (const key of keys) {
      const registration = this.registrations.get(key);
      const instance = this.instances.get(key);
      if (registration?.dispose && instance !== undefined) {
        await registration.dispose(instance);
      }
    }
    this.instances.clear();
  }
}
