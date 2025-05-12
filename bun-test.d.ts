declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  
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
    rejects: {
      toThrow(message?: string): Promise<void>;
    }
  };
  
  export interface Mock<T extends (...args: any[]) => any> {
    mock: {
      calls: any[][];
      results: any[];
      instances: any[];
      invocationCallOrder: number[];
      lastCall: any[];
    };
    mockImplementation(fn: T): Mock<T>;
    mockReturnValue(value: any): Mock<T>;
    mockReset(): void;
  }
  
  export const mock: {
    (implementation?: Function): Mock<any>;
    fn<T extends (...args: any[]) => any>(implementation?: T): Mock<T>;
    module(path: string, factory: () => any): void;
    restoreAll(): void;
    restore(): void;
  };
  
  export function spyOn(object: any, method: string): {
    mockImplementation: (impl: any) => void;
    mockReturnValue: (value: any) => void;
  };
  
  // Add namespace for expect matchers
  export namespace expect {
    export function stringContaining(expected: string): any;
    export function any(constructor: any): any;
  }
} 
