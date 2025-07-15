/**
 * Type Guards and Utilities
 * 
 * This module provides type guards and utility functions to help avoid "as unknown" assertions
 * by providing safer alternatives for common typing scenarios identified in task #280.
 * 
 * These utilities are designed to replace dangerous "as unknown" patterns with proper type safety.
 */

/**
 * Safely access object properties with type checking
 * 
 * Instead of: (someObject as unknown).property
 * Use: safeGet(someObject, "property")
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
 * Instead of: (someObject as unknown).prop.nested
 * Use: safeGetNested(someObject, ["prop", "nested"])
 */
export function safeGetNested<T>(obj: T, path: string[]): any {
  let current: any = obj;
  for (const key of path) {
    if (current && typeof current === "object" && key in current) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Type guard for checking if a value has a specific property
 * 
 * Instead of: (obj as unknown).property
 * Use: hasProperty(obj, "property") && obj.property
 */
export function hasProperty<T, K extends string>(
  obj: T,
  prop: K
): obj is T & Record<K, unknown> {
  return typeof obj === "object" && obj !== null && prop in obj;
}

/**
 * Type guard for checking if a value is a callable function
 * 
 * Instead of: (obj as unknown).method()
 * Use: isCallable(obj.method) && obj.method()
 */
export function isCallable<T>(value: T): value is T & ((...args: any[]) => any) {
  return typeof value === "function";
}

/**
 * Safe environment variable access with type checking
 * 
 * Instead of: process.env.VAR as unknown
 * Use: safeEnv("VAR")
 */
export function safeEnv(key: string): string | undefined {
  return process.env[key];
}

/**
 * Safe environment variable access with default value
 * 
 * Instead of: (process.env.VAR || 'default') as unknown
 * Use: safeEnvWithDefault("VAR", "default")
 */
export function safeEnvWithDefault(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

/**
 * Safe JSON parsing with error handling
 * 
 * Instead of: JSON.parse(str) as unknown
 * Use: safeJsonParse(str)
 */
export function safeJsonParse<T = any>(str: string): T | null {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

/**
 * Safe JSON parsing with type validation
 * 
 * Instead of: JSON.parse(str) as unknown as MyType
 * Use: safeJsonParseWithValidator(str, isMyType)
 */
export function safeJsonParseWithValidator<T>(
  str: string,
  validator: (value: any) => value is T
): T | null {
  try {
    const parsed = JSON.parse(str);
    return validator(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Type guard for checking if a value is an array
 * 
 * Instead of: (value as unknown).length
 * Use: isArray(value) && value.length
 */
export function isArray<T>(value: any): value is T[] {
  return Array.isArray(value);
}

/**
 * Type guard for checking if a value is an object (not null or array)
 * 
 * Instead of: (value as unknown).property
 * Use: isObject(value) && hasProperty(value, "property") && value.property
 */
export function isObject(value: any): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Type guard for checking if a value is a string
 * 
 * Instead of: (value as unknown).charAt(0)
 * Use: isString(value) && value.charAt(0)
 */
export function isString(value: any): value is string {
  return typeof value === "string";
}

/**
 * Type guard for checking if a value is a number
 * 
 * Instead of: (value as unknown).toFixed(2)
 * Use: isNumber(value) && value.toFixed(2)
 */
export function isNumber(value: any): value is number {
  return typeof value === "number" && !isNaN(value);
}

/**
 * Type guard for checking if a value is a boolean
 * 
 * Instead of: (value as unknown) ? true : false
 * Use: isBoolean(value) && value
 */
export function isBoolean(value: any): value is boolean {
  return typeof value === "boolean";
}

/**
 * Safe array method access with type checking
 * 
 * Instead of: (arr as unknown).map(...)
 * Use: safeArrayMethod(arr, "map", ...)
 */
export function safeArrayMethod<T, K extends keyof T[]>(
  arr: T[],
  method: K,
  ...args: any[]
): any {
  if (isArray(arr) && method in arr && isCallable(arr[method])) {
    return (arr[method] as any)(...args);
  }
  return undefined;
}

/**
 * Safe service method call with type checking
 * 
 * Instead of: (service as unknown).method()
 * Use: safeServiceCall(service, "method")
 */
export function safeServiceCall<T>(
  service: T,
  method: string,
  ...args: any[]
): any {
  if (hasProperty(service, method) && isCallable(service[method])) {
    return service[method](...args);
  }
  return undefined;
}

/**
 * Type assertion with runtime validation
 * 
 * Instead of: value as unknown as MyType
 * Use: assertType(value, isMyType)
 */
export function assertType<T>(value: any, guard: (value: any) => value is T): T {
  if (guard(value)) {
    return value;
  }
  throw new Error("Type assertion failed: value does not match expected type");
}

/**
 * Safe type assertion with fallback
 * 
 * Instead of: value as unknown as MyType
 * Use: safeAssertType(value, isMyType, fallback)
 */
export function safeAssertType<T>(
  value: any,
  guard: (value: any) => value is T,
  fallback: T
): T {
  return guard(value) ? value : fallback;
}

/**
 * Common type guards for domain objects
 */
export namespace DomainTypeGuards {
  export function isSessionLike(value: any): value is { id: string; [key: string]: any } {
    return isObject(value) && hasProperty(value, "id") && isString(value.id);
  }

  export function isTaskLike(value: any): value is { id: string; status: string; [key: string]: any } {
    return isObject(value) && 
           hasProperty(value, "id") && isString(value.id) &&
           hasProperty(value, "status") && isString(value.status);
  }

  export function isConfigLike(value: any): value is Record<string, any> {
    return isObject(value);
  }

  export function isErrorLike(value: any): value is { message: string; [key: string]: any } {
    return isObject(value) && hasProperty(value, "message") && isString(value.message);
  }
}

/**
 * Utility for creating type-safe wrappers around existing APIs
 * 
 * Instead of: (api as unknown).method()
 * Use: createTypedWrapper(api, { method: isString })
 */
export function createTypedWrapper<T>(
  obj: any,
  methods: Record<string, (value: any) => boolean>
): T {
  const wrapper: any = {};
  
  for (const [methodName, validator] of Object.entries(methods)) {
    wrapper[methodName] = (...args: any[]) => {
      if (hasProperty(obj, methodName) && isCallable(obj[methodName])) {
        const result = obj[methodName](...args);
        return validator(result) ? result : undefined;
      }
      return undefined;
    };
  }
  
  return wrapper as T;
}
