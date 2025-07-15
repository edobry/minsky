/**
 * Type Guards and Utilities
 *
 * This module provides type guards and utility functions to help avoid 'as unknown' assertions
 * by providing safer alternatives for common typing scenarios identified in task #280.
 *
 * These utilities are designed to replace dangerous 'as unknown' patterns with proper type safety.
 */

/**
 * Safely access object properties with type checking
 *
 * Instead of: (someObject as unknown).property
 * Use: safeGet(someObject, 'property')
 */
export function safeGet<T, K extends keyof T>(obj: T, key: K): T[K] | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    return obj[key];
  }
  return undefined;
}

/**
 * Safely access nested object properties
 *
 * Instead of: (someObject as unknown).deep.property
 * Use: safeGetNested(someObject, 'deep', 'property')
 */
export function safeGetNested<T>(obj: T, ...keys: string[]): unknown {
  let current: any = obj;
  for (const key of keys) {
    if (current && typeof current === "object" && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Type guard to check if a value has a specific property
 *
 * Instead of: (someObject as unknown).property
 * Use: hasProperty(someObject, 'property') && someObject.property
 */
export function hasProperty<T extends string>(
  obj: unknown,
  property: T
): obj is Record<T, unknown> {
  return obj !== null && typeof obj === "object" && property in obj;
}

/**
 * Type guard to check if a value is a function
 *
 * Instead of: (someValue as unknown)()
 * Use: isFunction(someValue) && someValue()
 */
export function isFunction(value: unknown): value is Function {
  return typeof value === "function";
}

/**
 * Type guard to check if a value is an array
 *
 * Instead of: (someValue as unknown).length
 * Use: isArray(someValue) && someValue.length
 */
export function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/**
 * Type guard to check if a value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Type guard to check if a value is a number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && !isNaN(value);
}

/**
 * Type guard to check if a value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Type guard to check if a value is an object (and not null)
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Safely cast a value to a specific type with validation
 *
 * Instead of: someValue as unknown as TargetType
 * Use: safeCast(someValue, isTargetType)
 */
export function safeCast<T>(value: unknown, guard: (value: unknown) => value is T): T | undefined {
  return guard(value) ? value : undefined;
}

/**
 * Assert that a value is not null or undefined
 *
 * Instead of: (someValue as unknown)!
 * Use: assertDefined(someValue)
 */
export function assertDefined<T>(value: T | null | undefined, message?: string): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message || "Value is null or undefined");
  }
}

/**
 * Environment variable utilities to avoid 'as unknown' with process.env
 */
export const _EnvUtils = {
  /**
   * Get environment variable as string
   *
   * Instead of: process.env.VARIABLE as unknown as string
   * Use: EnvUtils.getString('VARIABLE')
   */
  getString(key: string, defaultValue?: string): string | undefined {
    const value = process.env[key];
    return value !== undefined ? value : defaultValue;
  },

  /**
   * Get environment variable as number
   *
   * Instead of: Number(process.env.VARIABLE as unknown)
   * Use: EnvUtils.getNumber('VARIABLE')
   */
  getNumber(key: string, defaultValue?: number): number | undefined {
    const value = process.env[key];
    if (value === undefined) {
      return defaultValue;
    }
    const num = Number(value);
    return isNaN(num) ? defaultValue : num;
  },

  /**
   * Get environment variable as boolean
   *
   * Instead of: Boolean(process.env.VARIABLE as unknown)
   * Use: EnvUtils.getBoolean('VARIABLE')
   */
  getBoolean(key: string, defaultValue?: boolean): boolean | undefined {
    const value = process.env[key];
    if (value === undefined) {
      return defaultValue;
    }
    return value.toLowerCase() === "true" || value === "1";
  },

  /**
   * Require environment variable (throws if not found)
   *
   * Instead of: process.env.VARIABLE as unknown as string
   * Use: EnvUtils.require('VARIABLE')
   */
  require(key: string): string {
    const value = process.env[key];
    if (value === undefined) {
      throw new Error(`Required environment variable ${key} is not set`);
    }
    return value;
  }
};

/**
 * Safe JSON parsing utilities
 *
 * Instead of: JSON.parse(someString as unknown)
 * Use: JsonUtils.safeParse(someString)
 */
export const _JsonUtils = {
  /**
   * Safely parse JSON with type checking
   */
  safeParse<T>(value: string, guard?: (value: unknown) => value is T): T | undefined {
    try {
      const parsed = JSON.parse(value);
      return guard ? (guard(parsed) ? parsed : undefined) : parsed;
    } catch {
      return undefined;
    }
  },

  /**
   * Parse JSON with default value
   */
  parseWithDefault<T>(value: string, defaultValue: T): T {
    try {
      return JSON.parse(value) || defaultValue;
    } catch {
      return defaultValue;
    }
  }
};

/**
 * Service interface utilities
 *
 * Instead of: (someService as unknown).method()
 * Use: ServiceUtils.safeCall(someService, 'method')
 */
export const _ServiceUtils = {
  /**
   * Safely call a method on a service
   */
  safeCall<T, K extends keyof T>(
    service: T,
    method: K,
    ...args: T[K] extends (...args: any[]) => any ? Parameters<T[K]> : never[]
  ): T[K] extends (...args: any[]) => any ? ReturnType<T[K]> | undefined : undefined {
    if (service && typeof service === "object" && method in service) {
      const methodFn = service[method];
      if (typeof methodFn === "function") {
        try {
          return (methodFn as Function).apply(service, args);
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  },

  /**
   * Check if a service has a method
   */
  hasMethod<T, K extends keyof T>(service: T, method: K): boolean {
    return service && typeof service === "object" && method in service &&
           typeof service[method] === "function";
  }
};

/**
 * Configuration and options utilities
 *
 * Instead of: (options as unknown).property
 * Use: ConfigUtils.get(options, 'property')
 */
export const _ConfigUtils = {
  /**
   * Safely get configuration value with type checking
   */
  get<T>(config: unknown, key: string, defaultValue?: T): T | undefined {
    if (isObject(config) && key in config) {
      const value = config[key];
      return value !== undefined ? value as T : defaultValue;
    }
    return defaultValue;
  },

  /**
   * Merge configuration objects safely
   */
  merge<T extends Record<string, unknown>>(...configs: Array<T | undefined>): T {
    const result = {} as T;
    for (const config of configs) {
      if (isObject(config)) {
        Object.assign(result, config);
      }
    }
    return result;
  }
};

/**
 * Array utilities for unknown types
 *
 * Instead of: (someArray as unknown).map(...)
 * Use: ArrayUtils.safeMap(someArray, ...)
 */
export const _ArrayUtils = {
  /**
   * Safely map over an array
   */
  safeMap<T, U>(value: unknown, fn: (item: T, index: number) => U): U[] {
    if (isArray(value)) {
      return value.map(fn as (item: unknown, index: number) => U);
    }
    return [];
  },

  /**
   * Safely filter an array
   */
  safeFilter<T>(value: unknown, fn: (item: T) => boolean): T[] {
    if (isArray(value)) {
      return value.filter(fn as (item: unknown) => boolean) as T[];
    }
    return [];
  },

  /**
   * Safely get array length
   */
  safeLength(value: unknown): number {
    return isArray(value) ? value.length : 0;
  }
};
