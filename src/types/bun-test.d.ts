declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;

  // Define ExpectNot interface for negative assertions
  interface ExpectNot {
    toBe(expected: any): void;
    toEqual(expected: any): void;
    toContain(expected: any): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toHaveBeenCalledWith(...args: any[]): void;
    toHaveProperty(property: string, value?: any): void;
    toHaveLength(length: number): void;
  }

  export function expect(actual: any): {
    toBe(expected: any): void;
    toEqual(expected: any): void;
    toContain(expected: any): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeGreaterThan(expected: number): void;
    toHaveBeenCalledWith(...args: any[]): void;
    toHaveProperty(property: string, value?: any): void;
    toHaveLength(length: number): void;
    toThrow(message?: string | RegExp | Error): void;
    rejects: {
      toThrow(message?: string): Promise<void>;
    };
    not: ExpectNot;
  };

  export const mock: {
    fn: <T extends (...args: any[]) => any>(
      implementation?: T
    ) => {
      mockImplementation: (impl: T) => void;
    };
    module: (path: string, factory: () => any) => void;
    restoreAll: () => void;
    restore: () => void;
  };

  export function spyOn(
    object: any,
    method: string
  ): {
    mockImplementation: (impl: any) => void;
    mockReturnValue: (value: any) => void;
  };

  // Add namespace for expect matchers
  export namespace expect {
    export function stringContaining(expected: string): any;
    export function any(constructor: any): any;
  }
}
